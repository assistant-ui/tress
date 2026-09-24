//! Model providers. Ships Anthropic's Messages API over raw HTTP with SSE
//! streaming; the [`Provider`] trait keeps the engine testable and open to
//! other backends.

use futures_util::StreamExt;
use serde_json::{json, Value};

/// A streamed observation from the model mid-turn.
#[derive(Debug, Clone, PartialEq)]
pub enum Delta {
    Text(String),
    ToolUseStarted { name: String },
}

/// One completed model turn.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    /// The assistant content blocks verbatim (thinking blocks included, so
    /// history echoes them back unchanged).
    pub content: Vec<Value>,
    pub stop_reason: String,
}

impl Turn {
    pub fn tool_uses(&self) -> impl Iterator<Item = &Value> {
        self.content
            .iter()
            .filter(|block| block["type"] == "tool_use")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("request failed: {0}")]
    Http(String),
    #[error("api error: {0}")]
    Api(String),
    #[error("stream ended mid-message")]
    Truncated,
}

/// A model backend the engine can drive.
///
/// The future is deliberately not `Send`: a session runs on one task, and
/// wasm futures cannot be `Send` at all.
pub trait Provider {
    fn turn(
        &self,
        system: &str,
        messages: &[Value],
        tools: &[Value],
        on_delta: &mut dyn FnMut(Delta),
    ) -> impl std::future::Future<Output = Result<Turn, ProviderError>>;
}

/// Anthropic's Messages API.
pub struct Anthropic {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    pub model: String,
    pub max_tokens: u32,
}

impl Anthropic {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("client builds"),
            base_url: std::env::var("ANTHROPIC_BASE_URL")
                .unwrap_or_else(|_| "https://api.anthropic.com".to_owned()),
            api_key,
            model,
            max_tokens: 32_000,
        }
    }
}

impl Provider for Anthropic {
    async fn turn(
        &self,
        system: &str,
        messages: &[Value],
        tools: &[Value],
        on_delta: &mut dyn FnMut(Delta),
    ) -> Result<Turn, ProviderError> {
        let body = json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": system,
            "messages": messages,
            "tools": tools,
            "stream": true,
        });
        let response = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| ProviderError::Http(error.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(ProviderError::Api(format!("{status}: {detail}")));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut accumulator = Accumulator::default();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|error| ProviderError::Http(error.to_string()))?;
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
        Err(ProviderError::Truncated)
    }
}

/// Rebuilds the assistant message from SSE events.
#[derive(Default)]
struct Accumulator {
    blocks: Vec<Value>,
    partial_json: Vec<String>,
    stop_reason: Option<String>,
}

impl Accumulator {
    fn event(
        &mut self,
        event: &Value,
        on_delta: &mut dyn FnMut(Delta),
    ) -> Result<Option<Turn>, ProviderError> {
        let index = event["index"].as_u64().unwrap_or(0) as usize;
        match event["type"].as_str().unwrap_or_default() {
            "content_block_start" => {
                let block = event["content_block"].clone();
                if block["type"] == "tool_use" {
                    on_delta(Delta::ToolUseStarted {
                        name: block["name"].as_str().unwrap_or_default().to_owned(),
                    });
                }
                while self.blocks.len() <= index {
                    self.blocks.push(Value::Null);
                    self.partial_json.push(String::new());
                }
                self.blocks[index] = block;
            }
            "content_block_delta" => {
                let delta = &event["delta"];
                let Some(block) = self.blocks.get_mut(index) else {
                    return Ok(None);
                };
                match delta["type"].as_str().unwrap_or_default() {
                    "text_delta" => {
                        let text = delta["text"].as_str().unwrap_or_default();
                        if let Some(existing) = block["text"].as_str() {
                            block["text"] = Value::String(format!("{existing}{text}"));
                        }
                        on_delta(Delta::Text(text.to_owned()));
                    }
                    "input_json_delta" => {
                        self.partial_json[index]
                            .push_str(delta["partial_json"].as_str().unwrap_or_default());
                    }
                    "thinking_delta" => {
                        let text = delta["thinking"].as_str().unwrap_or_default();
                        if let Some(existing) = block["thinking"].as_str() {
                            block["thinking"] = Value::String(format!("{existing}{text}"));
                        }
                    }
                    "signature_delta" => {
                        block["signature"] = Value::String(
                            delta["signature"].as_str().unwrap_or_default().to_owned(),
                        );
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some(block) = self.blocks.get_mut(index) {
                    if block["type"] == "tool_use" {
                        let raw = &self.partial_json[index];
                        block["input"] = if raw.is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(raw)
                                .map_err(|error| ProviderError::Api(error.to_string()))?
                        };
                    }
                }
            }
            "message_delta" => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(reason.to_owned());
                }
            }
            "message_stop" => {
                return Ok(Some(Turn {
                    content: std::mem::take(&mut self.blocks)
                        .into_iter()
                        .filter(|block| !block.is_null())
                        .collect(),
                    stop_reason: self.stop_reason.take().unwrap_or_default(),
                }));
            }
            "error" => {
                return Err(ProviderError::Api(
                    event["error"]["message"]
                        .as_str()
                        .unwrap_or("unknown stream error")
                        .to_owned(),
                ));
            }
            _ => {}
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(events: &[Value]) -> (Turn, Vec<Delta>) {
        let mut accumulator = Accumulator::default();
        let mut deltas = Vec::new();
        let mut turn = None;
        for event in events {
            if let Some(done) = accumulator.event(event, &mut |d| deltas.push(d)).unwrap() {
                turn = Some(done);
            }
        }
        (turn.expect("message_stop"), deltas)
    }

    #[test]
    fn accumulates_text_and_tool_use() {
        let (turn, deltas) = feed(&[
            json!({"type": "message_start"}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "run"}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": " tests"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "t1", "name": "bash", "input": {}}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"comm"}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "and\": \"cargo test\"}"}}),
            json!({"type": "content_block_stop", "index": 1}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
            json!({"type": "message_stop"}),
        ]);
        assert_eq!(turn.stop_reason, "tool_use");
        assert_eq!(turn.content[0]["text"], "run tests");
        let tool = turn.tool_uses().next().unwrap();
        assert_eq!(tool["input"]["command"], "cargo test");
        assert!(deltas.contains(&Delta::ToolUseStarted {
            name: "bash".into()
        }));
    }

    #[test]
    fn thinking_blocks_keep_their_signature() {
        let (turn, _) = feed(&[
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hm"}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}}),
            json!({"type": "message_stop"}),
        ]);
        assert_eq!(turn.content[0]["thinking"], "hm");
        assert_eq!(turn.content[0]["signature"], "sig");
    }

    #[test]
    fn stream_error_events_surface() {
        let mut accumulator = Accumulator::default();
        let result = accumulator.event(
            &json!({"type": "error", "error": {"message": "overloaded"}}),
            &mut |_| {},
        );
        assert!(matches!(result, Err(ProviderError::Api(m)) if m == "overloaded"));
    }
}
