//! Browser bindings for the tress agent core.
//!
//! The same [`tress::Engine`] the terminal binary runs drives an in-memory
//! workspace here, and reaches the model through the browser's own `fetch`.
//! The host page supplies the endpoint and any auth header, so a key never
//! has to live in the bundle — point it at a proxy you control.

use std::cell::RefCell;
use std::rc::Rc;

use js_sys::{Array, Uint8Array};
use serde_json::Value;
use tress::engine::{Approval, Engine, Event};
use tress::provider::{request_body, Delta, MessageAccumulator, Provider, ProviderError, Turn};
use tress::MemoryTools;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request, RequestInit, Response};

/// Reaches the Messages API through the browser's `fetch`.
struct FetchProvider {
    url: String,
    headers: Vec<(String, String)>,
    model: String,
    max_tokens: u32,
}

impl Provider for FetchProvider {
    async fn turn(
        &self,
        system: &str,
        messages: &[Value],
        tools: &[Value],
        on_delta: &mut dyn FnMut(Delta),
    ) -> Result<Turn, ProviderError> {
        let body = request_body(&self.model, self.max_tokens, system, messages, tools);
        let init = RequestInit::new();
        init.set_method("POST");
        init.set_body(&JsValue::from_str(&body.to_string()));

        let headers = web_sys::Headers::new().map_err(js_error)?;
        headers
            .set("content-type", "application/json")
            .map_err(js_error)?;
        for (name, value) in &self.headers {
            headers.set(name, value).map_err(js_error)?;
        }
        init.set_headers(&headers);

        let request = Request::new_with_str_and_init(&self.url, &init).map_err(js_error)?;
        let response: Response = JsFuture::from(fetch(&request))
            .await
            .map_err(js_error)?
            .dyn_into()
            .map_err(|_| ProviderError::Http("response is not a Response".into()))?;

        if !response.ok() {
            let detail = JsFuture::from(response.text().map_err(js_error)?)
                .await
                .ok()
                .and_then(|text| text.as_string())
                .unwrap_or_default();
            return Err(ProviderError::Api(format!(
                "{}: {detail}",
                response.status()
            )));
        }

        let stream = response
            .body()
            .ok_or_else(|| ProviderError::Http("response has no body".into()))?;
        let reader: web_sys::ReadableStreamDefaultReader = stream
            .get_reader()
            .dyn_into()
            .map_err(|_| ProviderError::Http("body reader is not a default reader".into()))?;

        let mut buffer = String::new();
        let mut accumulator = MessageAccumulator::default();
        loop {
            let chunk = JsFuture::from(reader.read()).await.map_err(js_error)?;
            let done = js_sys::Reflect::get(&chunk, &JsValue::from_str("done"))
                .map_err(js_error)?
                .as_bool()
                .unwrap_or(false);
            if done {
                return Err(ProviderError::Truncated);
            }
            let value =
                js_sys::Reflect::get(&chunk, &JsValue::from_str("value")).map_err(js_error)?;
            let bytes = Uint8Array::new(&value).to_vec();
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(boundary) = buffer.find("\n\n") {
                let block = buffer[..boundary].to_owned();
                buffer.drain(..boundary + 2);
                for line in block.lines() {
                    let Some(data) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let event: Value = serde_json::from_str(data.trim())
                        .map_err(|error| ProviderError::Api(error.to_string()))?;
                    if let Some(turn) = accumulator.event(&event, on_delta)? {
                        return Ok(turn);
                    }
                }
            }
        }
    }
}

fn js_error(error: JsValue) -> ProviderError {
    ProviderError::Http(
        error
            .as_string()
            .or_else(|| {
                js_sys::Reflect::get(&error, &JsValue::from_str("message"))
                    .ok()
                    .and_then(|value| value.as_string())
            })
            .unwrap_or_else(|| "fetch failed".into()),
    )
}

/// `fetch` from a window or a worker, so the bindings work in both.
fn fetch(request: &Request) -> js_sys::Promise {
    let global = js_sys::global();
    if let Ok(window) = global.clone().dyn_into::<web_sys::Window>() {
        window.fetch_with_request(request)
    } else {
        global
            .unchecked_into::<web_sys::WorkerGlobalScope>()
            .fetch_with_request(request)
    }
}

/// An agent session backed by an in-memory workspace.
#[wasm_bindgen]
pub struct TressSession {
    engine: Engine<FetchProvider, MemoryTools>,
    files: Rc<RefCell<MemoryTools>>,
}

#[wasm_bindgen]
impl TressSession {
    /// Creates a session.
    ///
    /// `url` is the Messages API endpoint (your proxy). `headers` is an
    /// object of header names to values. `files` is an optional object of
    /// path to contents, seeding the workspace.
    #[wasm_bindgen(constructor)]
    pub fn new(
        url: String,
        model: String,
        headers: JsValue,
        files: JsValue,
    ) -> Result<TressSession, JsValue> {
        let headers = entries(&headers)?;
        let seeded = MemoryTools::with_files(entries(&files)?);
        let provider = FetchProvider {
            url,
            headers,
            model,
            max_tokens: 16_000,
        };
        Ok(TressSession {
            engine: Engine::new(provider, seeded.clone()),
            files: Rc::new(RefCell::new(seeded)),
        })
    }

    /// Runs one turn. `on_event` receives `{type, ...}` objects: `text`,
    /// `tool`, `tool_done`, and `idle`.
    #[wasm_bindgen]
    pub async fn send(
        &mut self,
        prompt: String,
        on_event: js_sys::Function,
    ) -> Result<(), JsValue> {
        let emit = |value: Value| {
            let _ = on_event.call1(
                &JsValue::NULL,
                &JsValue::from_str(&serde_json::to_string(&value).unwrap_or_default()),
            );
        };
        let mut on_engine_event = |event: Event| match event {
            Event::Text(text) => emit(serde_json::json!({"type": "text", "text": text})),
            Event::ToolStarted { name, summary } => {
                emit(serde_json::json!({"type": "tool", "name": name, "summary": summary}));
            }
            Event::ToolFinished { name, is_error } => {
                emit(serde_json::json!({"type": "tool_done", "name": name, "isError": is_error}));
            }
            Event::Idle => emit(serde_json::json!({"type": "idle"})),
            Event::ApprovalNeeded { .. } | Event::ToolDenied { .. } => {}
        };
        // The in-memory surface gates nothing, so approval never fires.
        let mut approve = |_: &str, _: &str| Approval::Once;

        self.engine
            .send(&prompt, &mut on_engine_event, &mut approve)
            .await
            .map_err(|error| JsValue::from_str(&error.to_string()))?;

        *self.files.borrow_mut() = self.engine.tools_mut().clone();
        Ok(())
    }

    /// The workspace's files as a `{path: contents}` object.
    #[wasm_bindgen(js_name = files)]
    pub fn files_js(&self) -> Result<JsValue, JsValue> {
        let files = self.files.borrow();
        let object = js_sys::Object::new();
        for path in files.paths() {
            js_sys::Reflect::set(
                &object,
                &JsValue::from_str(path),
                &JsValue::from_str(files.get(path).unwrap_or_default()),
            )?;
        }
        Ok(object.into())
    }
}

/// Reads a JS object into `(key, value)` string pairs; `null`/`undefined`
/// read as empty.
fn entries(value: &JsValue) -> Result<Vec<(String, String)>, JsValue> {
    if value.is_undefined() || value.is_null() {
        return Ok(Vec::new());
    }
    let object: &js_sys::Object = value
        .dyn_ref()
        .ok_or_else(|| JsValue::from_str("expected an object"))?;
    js_sys::Object::entries(object)
        .iter()
        .map(|entry| {
            let pair: Array = entry.unchecked_into();
            let key = pair.get(0).as_string().unwrap_or_default();
            let value = pair.get(1).as_string().unwrap_or_default();
            Ok((key, value))
        })
        .collect()
}
