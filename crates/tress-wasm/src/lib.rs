//! Browser and Node bindings for the tress agent core.
//!
//! The same [`tress::Engine`] the terminal binary runs drives an in-memory
//! workspace or asynchronous host tools, and reaches the model through `fetch`.
//! The host page supplies the endpoint and any auth header, so a key never
//! has to live in the bundle — point it at a proxy you control.

use std::cell::RefCell;
use std::rc::Rc;

use js_sys::{Array, Uint8Array};
use serde_json::Value;
use tress::engine::{Approval, Engine, Event};
use tress::provider::{request_body, Delta, MessageAccumulator, Provider, ProviderError, Turn};
use tress::tools::ToolOutcome;
use tress::{MemoryTools, Tools};
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
        let response: Response = JsFuture::from(fetch(&request)?)
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

/// Calls the global `fetch`, whatever the host is.
///
/// Reaching through `globalThis` rather than `Window` keeps the bindings
/// working in a page, a worker, and Node, which is what lets the same module
/// run the agent server-side.
fn fetch(request: &Request) -> Result<js_sys::Promise, ProviderError> {
    let global = js_sys::global();
    let handle = js_sys::Reflect::get(&global, &JsValue::from_str("fetch"))
        .map_err(|_| ProviderError::Http("no global fetch".into()))?;
    let function: js_sys::Function = handle
        .dyn_into()
        .map_err(|_| ProviderError::Http("global fetch is not callable".into()))?;
    function
        .call1(&global, request)
        .map_err(js_error)?
        .dyn_into()
        .map_err(|_| ProviderError::Http("fetch did not return a promise".into()))
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

/// Async tool calls implemented by the embedding host. Policy is enforced
/// in the callback, before it accesses a workspace or a remote service.
struct HostTools {
    schemas: Vec<Value>,
    execute: js_sys::Function,
}

impl Tools for HostTools {
    fn schemas(&self) -> Vec<Value> {
        self.schemas.clone()
    }

    fn needs_approval(&self, _: &str, _: &Value) -> bool {
        false
    }

    async fn execute_async(&mut self, name: &str, input: &Value) -> ToolOutcome {
        if !self.schemas.iter().any(|schema| schema["name"] == name) {
            return ToolOutcome::error(format!("Unknown tool: {name}"));
        }
        let result = async {
            let value = self.execute.call2(
                &JsValue::NULL,
                &JsValue::from_str(name),
                &JsValue::from_str(&input.to_string()),
            )?;
            let value = JsFuture::from(js_sys::Promise::resolve(&value)).await?;
            let raw = value
                .as_string()
                .ok_or_else(|| JsValue::from_str("Tool must return JSON text"))?;
            let result: Value = serde_json::from_str(&raw)
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
            match (result["content"].as_str(), result["is_error"].as_bool()) {
                (Some(content), Some(is_error)) => Ok(ToolOutcome {
                    content: content.to_owned(),
                    is_error,
                }),
                _ => Err(JsValue::from_str(
                    "Tool result requires content and is_error",
                )),
            }
        }
        .await;
        result.unwrap_or_else(|error| ToolOutcome::error(js_error(error).to_string()))
    }
}

/// An embeddable session whose tools are provided asynchronously by JS.
/// The host owns workspace lifetime, credentials, authorization, and storage.
#[wasm_bindgen]
pub struct TressHostSession {
    engine: Engine<FetchProvider, HostTools>,
}

#[wasm_bindgen]
impl TressHostSession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        url: String,
        model: String,
        headers: JsValue,
        schemas: String,
        execute: js_sys::Function,
    ) -> Result<TressHostSession, JsValue> {
        let schemas: Vec<Value> = serde_json::from_str(&schemas)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        if schemas
            .iter()
            .any(|s| s["name"].as_str().is_none() || !s["input_schema"].is_object())
        {
            return Err(JsValue::from_str("Invalid tool definitions"));
        }
        let provider = FetchProvider {
            url,
            model,
            headers: entries(&headers)?,
            max_tokens: 16_000,
        };
        Ok(Self {
            engine: Engine::new(provider, HostTools { schemas, execute }),
        })
    }

    pub async fn send(
        &mut self,
        prompt: String,
        on_event: js_sys::Function,
    ) -> Result<(), JsValue> {
        let mut emit = |event: Event| {
            let value = match event {
                Event::Text(text) => serde_json::json!({"type":"text", "text":text}),
                Event::ToolStarted { name, summary } => {
                    serde_json::json!({"type":"tool", "name":name, "summary":summary})
                }
                Event::ToolFinished { name, is_error } => {
                    serde_json::json!({"type":"tool_done", "name":name, "isError":is_error})
                }
                Event::Idle => serde_json::json!({"type":"idle"}),
                _ => return,
            };
            let _ = on_event.call1(&JsValue::NULL, &JsValue::from_str(&value.to_string()));
        };
        self.engine
            .send(&prompt, &mut emit, &mut |_, _| Approval::Deny)
            .await
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn messages(&self) -> String {
        serde_json::to_string(self.engine.messages()).unwrap_or_else(|_| "[]".into())
    }

    /// Only restore trusted host checkpoints, never untrusted client input.
    #[wasm_bindgen(js_name = restoreMessages)]
    pub fn restore_messages(&mut self, json: String) -> Result<(), JsValue> {
        let messages: Vec<Value> =
            serde_json::from_str(&json).map_err(|error| JsValue::from_str(&error.to_string()))?;
        self.engine.restore_messages(messages);
        Ok(())
    }

    #[wasm_bindgen(js_name = setSystem)]
    pub fn set_system(&mut self, system: String) {
        self.engine.set_system(system);
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
