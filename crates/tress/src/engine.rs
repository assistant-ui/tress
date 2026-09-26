//! The agent loop: send a turn, run the tools it asks for, repeat until the
//! model stops asking.
//!
//! The loop owns no I/O of its own. It talks to a [`Provider`] and a
//! [`Tools`], and reports everything through [`Event`], so the same engine
//! drives a terminal, a browser build, or an embedded host.

use serde_json::{json, Value};

use crate::provider::{Delta, Provider, ProviderError};
use crate::tools::{ToolOutcome, Tools};

/// What the engine reports as a turn unfolds.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// A chunk of assistant text.
    Text(String),
    /// A tool call is about to be considered.
    ToolStarted { name: String, summary: String },
    /// The call needs the user's approval before it runs.
    ApprovalNeeded { name: String, summary: String },
    /// The user denied the call; the model is told so.
    ToolDenied { name: String },
    /// A call finished.
    ToolFinished { name: String, is_error: bool },
    /// The turn ended and control returns to the user.
    Idle,
}

/// The user's answer to an approval request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approval {
    Once,
    Always,
    Deny,
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Provider(#[from] ProviderError),
    #[error("stopped after {0} model steps; send another prompt to continue or raise max_steps")]
    StepLimit(usize),
}

/// Stops a run from looping forever on a misbehaving model.
pub const DEFAULT_MAX_STEPS: usize = 64;

pub const SYSTEM_PROMPT: &str = "\
You are tress, a coding agent. The working directory is the user's project,
and every path you use is relative to it.

Start by looking: `ls` shows what is here and `read` opens a file. Those never
need permission, so use them to orient yourself rather than searching the
machine. Reserve `bash` for actually doing something — running tests, a build,
a git command — and say in one line why you want it. If a command is denied,
carry on with the file tools instead of stopping.

Work directly: read what you need, make the edit, verify it. Prefer the
smallest change that solves the problem, and use the tools rather than telling
the user what to run.

Keep replies short and concrete. No preamble, no restating the request.";

/// One conversation with a model, over one tool surface.
pub struct Engine<P: Provider, T: Tools> {
    provider: P,
    tools: T,
    messages: Vec<Value>,
    system: String,
    always_allowed: Vec<String>,
    max_steps: std::num::NonZeroUsize,
}

impl<P: Provider, T: Tools> Engine<P, T> {
    pub fn new(provider: P, tools: T) -> Self {
        Self {
            provider,
            tools,
            messages: Vec::new(),
            system: SYSTEM_PROMPT.to_owned(),
            always_allowed: Vec::new(),
            max_steps: std::num::NonZeroUsize::new(DEFAULT_MAX_STEPS).unwrap(),
        }
    }

    pub fn with_system(mut self, system: impl Into<String>) -> Self {
        self.system = system.into();
        self
    }

    /// Limit model requests per user turn, including the final reply.
    pub fn with_max_steps(mut self, max_steps: std::num::NonZeroUsize) -> Self {
        self.max_steps = max_steps;
        self
    }

    /// The conversation so far, in provider shape.
    pub fn messages(&self) -> &[Value] {
        &self.messages
    }

    /// Restore a trusted checkpoint in the provider's message format.
    /// Call only between turns; storage and validation belong to the host.
    pub fn restore_messages(&mut self, messages: Vec<Value>) {
        self.messages = messages;
    }

    pub fn set_system(&mut self, system: impl Into<String>) {
        self.system = system.into();
    }

    pub fn tools_mut(&mut self) -> &mut T {
        &mut self.tools
    }

    /// Runs one user turn to completion.
    ///
    /// `on_event` receives progress; `approve` is asked before any tool the
    /// surface marks as needing it, and a tool approved with
    /// [`Approval::Always`] is not asked about again in this session.
    pub async fn send(
        &mut self,
        prompt: &str,
        on_event: &mut dyn FnMut(Event),
        approve: &mut dyn FnMut(&str, &str) -> Approval,
    ) -> Result<(), EngineError> {
        self.messages
            .push(json!({"role": "user", "content": prompt}));
        let schemas = self.tools.schemas();

        for _ in 0..self.max_steps.get() {
            let turn = self
                .provider
                .turn(&self.system, &self.messages, &schemas, &mut |delta| {
                    if let Delta::Text(text) = delta {
                        on_event(Event::Text(text));
                    }
                })
                .await?;

            self.messages
                .push(json!({"role": "assistant", "content": turn.content}));

            let calls: Vec<Value> = turn.tool_uses().cloned().collect();
            if calls.is_empty() {
                on_event(Event::Idle);
                return Ok(());
            }

            let mut results = Vec::with_capacity(calls.len());
            for call in &calls {
                let name = call["name"].as_str().unwrap_or_default().to_owned();
                let input = call["input"].clone();
                let summary = self.tools.describe(&name, &input);
                on_event(Event::ToolStarted {
                    name: name.clone(),
                    summary: summary.clone(),
                });

                let outcome = if self.is_gated(&name, &input) {
                    on_event(Event::ApprovalNeeded {
                        name: name.clone(),
                        summary: summary.clone(),
                    });
                    match approve(&name, &summary) {
                        Approval::Deny => {
                            on_event(Event::ToolDenied { name: name.clone() });
                            ToolOutcome::error("The user denied this call.")
                        }
                        Approval::Always => {
                            self.always_allowed.push(name.clone());
                            self.tools.execute_async(&name, &input).await
                        }
                        Approval::Once => self.tools.execute_async(&name, &input).await,
                    }
                } else {
                    self.tools.execute_async(&name, &input).await
                };

                on_event(Event::ToolFinished {
                    name: name.clone(),
                    is_error: outcome.is_error,
                });
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": call["id"],
                    "content": outcome.content,
                    "is_error": outcome.is_error,
                }));
            }
            // Every result rides one user message, so parallel calls stay
            // parallel on the next turn.
            self.messages
                .push(json!({"role": "user", "content": results}));
        }

        on_event(Event::Idle);
        Err(EngineError::StepLimit(self.max_steps.get()))
    }

    fn is_gated(&self, name: &str, input: &Value) -> bool {
        self.tools.needs_approval(name, input)
            && !self.always_allowed.iter().any(|allowed| allowed == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use crate::provider::Turn;

    /// A provider that replays scripted turns.
    struct ScriptedProvider {
        turns: Arc<Mutex<Vec<Turn>>>,
        seen: Arc<Mutex<Vec<Vec<Value>>>>,
    }

    impl Provider for ScriptedProvider {
        async fn turn(
            &self,
            _system: &str,
            messages: &[Value],
            _tools: &[Value],
            on_delta: &mut dyn FnMut(Delta),
        ) -> Result<Turn, ProviderError> {
            self.seen.lock().unwrap().push(messages.to_vec());
            let turn = self.turns.lock().unwrap().remove(0);
            for block in &turn.content {
                if let Some(text) = block["text"].as_str() {
                    on_delta(Delta::Text(text.to_owned()));
                }
            }
            Ok(turn)
        }
    }

    /// A tool surface that records calls and answers "ok".
    struct FakeTools {
        calls: Arc<Mutex<Vec<(String, Value)>>>,
        gated: Vec<String>,
    }

    impl Tools for FakeTools {
        fn schemas(&self) -> Vec<Value> {
            vec![json!({"name": "bash", "description": "", "input_schema": {}})]
        }

        fn needs_approval(&self, name: &str, _input: &Value) -> bool {
            self.gated.iter().any(|gated| gated == name)
        }

        fn execute(&mut self, name: &str, input: &Value) -> ToolOutcome {
            self.calls
                .lock()
                .unwrap()
                .push((name.to_owned(), input.clone()));
            ToolOutcome::ok("ok")
        }
    }

    fn text_turn(text: &str) -> Turn {
        Turn {
            content: vec![json!({"type": "text", "text": text})],
            stop_reason: "end_turn".into(),
        }
    }

    fn tool_turn(name: &str, input: Value) -> Turn {
        Turn {
            content: vec![json!({"type": "tool_use", "id": "t1", "name": name, "input": input})],
            stop_reason: "tool_use".into(),
        }
    }

    type Calls = Arc<Mutex<Vec<(String, Value)>>>;
    type Requests = Arc<Mutex<Vec<Vec<Value>>>>;

    fn engine(
        turns: Vec<Turn>,
        gated: Vec<String>,
    ) -> (Engine<ScriptedProvider, FakeTools>, Calls, Requests) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let engine = Engine::new(
            ScriptedProvider {
                turns: Arc::new(Mutex::new(turns)),
                seen: seen.clone(),
            },
            FakeTools {
                calls: calls.clone(),
                gated,
            },
        );
        (engine, calls, seen)
    }

    #[tokio::test]
    async fn plain_reply_ends_the_turn() {
        let (mut engine, calls, _) = engine(vec![text_turn("done")], vec![]);
        let mut events = Vec::new();
        engine
            .send("hi", &mut |event| events.push(event), &mut |_, _| {
                Approval::Once
            })
            .await
            .unwrap();
        assert_eq!(events[0], Event::Text("done".into()));
        assert_eq!(events.last(), Some(&Event::Idle));
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(engine.messages().len(), 2);
    }

    #[tokio::test]
    async fn step_limit_reports_failure_keeps_results_and_allows_continuation() {
        let (mut engine, calls, seen) = engine(
            vec![
                tool_turn("read", json!({"path": "a.rs"})),
                tool_turn("read", json!({"path": "b.rs"})),
                text_turn("continued"),
            ],
            vec![],
        );
        engine = engine.with_max_steps(std::num::NonZeroUsize::new(2).unwrap());
        let mut events = Vec::new();
        let result = engine
            .send("go", &mut |event| events.push(event), &mut |_, _| {
                Approval::Once
            })
            .await;
        assert!(matches!(result, Err(EngineError::StepLimit(2))));
        assert_eq!(calls.lock().unwrap().len(), 2);
        assert_eq!(seen.lock().unwrap().len(), 2);
        assert_eq!(events.last(), Some(&Event::Idle));
        assert_eq!(
            engine.messages().last().unwrap()["content"][0]["type"],
            "tool_result"
        );
        engine
            .send("continue", &mut |_| {}, &mut |_, _| Approval::Once)
            .await
            .unwrap();
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn async_tools_are_awaited_and_denied_calls_do_not_execute() {
        struct AsyncTools {
            calls: Arc<Mutex<usize>>,
        }
        impl Tools for AsyncTools {
            fn schemas(&self) -> Vec<Value> {
                vec![]
            }
            fn needs_approval(&self, _: &str, _: &Value) -> bool {
                true
            }
            async fn execute_async(&mut self, _: &str, _: &Value) -> ToolOutcome {
                tokio::task::yield_now().await;
                *self.calls.lock().unwrap() += 1;
                ToolOutcome::ok("async completed")
            }
        }
        for decision in [Approval::Deny, Approval::Once] {
            let calls = Arc::new(Mutex::new(0));
            let seen = Arc::new(Mutex::new(Vec::new()));
            let provider = ScriptedProvider {
                turns: Arc::new(Mutex::new(vec![
                    tool_turn("remote", json!({})),
                    text_turn("done"),
                ])),
                seen: seen.clone(),
            };
            let mut engine = Engine::new(
                provider,
                AsyncTools {
                    calls: calls.clone(),
                },
            );
            engine
                .send("go", &mut |_| {}, &mut |_, _| decision)
                .await
                .unwrap();
            assert_eq!(
                *calls.lock().unwrap(),
                usize::from(decision == Approval::Once)
            );
            let requests = seen.lock().unwrap();
            let result = &requests[1][2]["content"][0];
            assert_eq!(result["is_error"], decision == Approval::Deny);
            if decision == Approval::Once {
                assert_eq!(result["content"], "async completed");
            }
        }
    }

    #[tokio::test]
    async fn tool_call_runs_then_loops_back() {
        let (mut engine, calls, seen) = engine(
            vec![
                tool_turn("read", json!({"path": "a.rs"})),
                text_turn("read it"),
            ],
            vec![],
        );
        engine
            .send("look", &mut |_| {}, &mut |_, _| Approval::Once)
            .await
            .unwrap();
        assert_eq!(calls.lock().unwrap()[0].0, "read");
        // user, assistant(tool_use), user(tool_result), assistant(text)
        assert_eq!(engine.messages().len(), 4);
        let second_request = &seen.lock().unwrap()[1];
        assert_eq!(second_request[2]["content"][0]["type"], "tool_result");
    }

    #[tokio::test]
    async fn gated_tool_asks_and_denial_is_reported_to_the_model() {
        let (mut engine, calls, _) = engine(
            vec![
                tool_turn("bash", json!({"command": "rm -rf /"})),
                text_turn("understood"),
            ],
            vec!["bash".into()],
        );
        let mut events = Vec::new();
        engine
            .send("clean", &mut |event| events.push(event), &mut |_, _| {
                Approval::Deny
            })
            .await
            .unwrap();
        assert!(calls.lock().unwrap().is_empty(), "denied call must not run");
        assert!(events.contains(&Event::ToolDenied {
            name: "bash".into()
        }));
        let result = &engine.messages()[2]["content"][0];
        assert_eq!(result["is_error"], true);
    }

    #[tokio::test]
    async fn always_stops_asking_for_that_tool() {
        let (mut engine, calls, _) = engine(
            vec![
                tool_turn("bash", json!({"command": "ls"})),
                tool_turn("bash", json!({"command": "pwd"})),
                text_turn("done"),
            ],
            vec!["bash".into()],
        );
        let asked = Arc::new(Mutex::new(0));
        let counter = asked.clone();
        engine
            .send("go", &mut |_| {}, &mut move |_, _| {
                *counter.lock().unwrap() += 1;
                Approval::Always
            })
            .await
            .unwrap();
        assert_eq!(*asked.lock().unwrap(), 1, "asked once, then remembered");
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn parallel_calls_return_in_one_user_message() {
        let turn = Turn {
            content: vec![
                json!({"type": "tool_use", "id": "a", "name": "read", "input": {"path": "x"}}),
                json!({"type": "tool_use", "id": "b", "name": "read", "input": {"path": "y"}}),
            ],
            stop_reason: "tool_use".into(),
        };
        let (mut engine, calls, _) = engine(vec![turn, text_turn("both read")], vec![]);
        engine
            .send("read both", &mut |_| {}, &mut |_, _| Approval::Once)
            .await
            .unwrap();
        assert_eq!(calls.lock().unwrap().len(), 2);
        let results = &engine.messages()[2]["content"];
        assert_eq!(results.as_array().unwrap().len(), 2);
    }
}
