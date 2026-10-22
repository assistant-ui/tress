//! A single-owner Statewire HTTP endpoint. Ephemeral command lanes deliberately
//! fail unanswered commands on disconnect instead of replaying machine effects.
use std::{collections::BTreeMap, convert::Infallible, sync::Arc, time::Duration};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    Json,
};
use serde_json::{json, Value};
use statewire::{Frame, WIRE_VERSION};
use tokio::sync::{mpsc, Mutex};

use super::{id, Shared};

#[derive(Clone)]
pub(super) struct Lease {
    tx: mpsc::Sender<Value>,
    commands: Arc<Mutex<Commands>>,
}

#[derive(Default)]
struct Commands {
    seq: u64,
    answers: BTreeMap<u64, Value>,
}

struct StreamGuard {
    host: Shared,
    lease: String,
}
impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.host.leases.lock().unwrap().remove(&self.lease);
    }
}

// This endpoint supports the exact wire revision used by the bundled clients.
// Unknown required application protocols must fail rather than downgrade.
fn compatible(headers: &HeaderMap) -> bool {
    if headers
        .get("statewire-version")
        .and_then(|v| v.to_str().ok())
        != Some(format!("\"{WIRE_VERSION}\"").as_str())
    {
        return false;
    }
    let Some(offers) = headers
        .get("statewire-protocol")
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let mut supported = false;
    for offer in offers.split(',') {
        let mut fields = offer.trim().split(';').map(str::trim);
        let name = fields.next().unwrap_or("");
        let fields: Vec<_> = fields.collect();
        if name == "default" && fields.contains(&format!("version=\"{WIRE_VERSION}\"").as_str()) {
            supported = true;
        } else if !fields.contains(&"optional") {
            return false;
        }
    }
    supported
}

pub(super) async fn stream(
    State(host): State<Shared>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    if token != host.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !compatible(&headers) {
        return (
            StatusCode::BAD_REQUEST,
            "Unsupported Statewire version or protocol",
        )
            .into_response();
    }
    let lease = id();
    let (tx, rx) = mpsc::channel(64);
    {
        let mut leases = host.leases.lock().unwrap();
        if leases.len() >= 32 {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
        leases.insert(
            lease.clone(),
            Lease {
                tx,
                commands: Arc::default(),
            },
        );
    }
    let state = host.state.subscribe();
    let hello = json!({
        "syn":{"version":WIRE_VERSION,"protocols":[{"name":"default","version":WIRE_VERSION,"seq":0,"record":"ephemeral"}],"id":lease,"idle":false},
        "ops":[{"op":"mount","protocol":"default","main":true,"value":state.borrow().clone()}]
    });
    let guard = StreamGuard {
        host: host.clone(),
        lease: lease.clone(),
    };
    let stop = host.shutdown.subscribe();
    let events = futures_util::stream::unfold(
        (Some(hello), state, rx, stop, guard),
        |(mut first, mut state, mut rx, mut stop, guard)| async move {
            let packet = if let Some(first) = first.take() {
                first
            } else {
                tokio::select! {
                    biased;
                    _ = stop.changed() => return None,
                    answer = rx.recv() => answer?,
                    changed = state.changed() => {
                        changed.ok()?;
                        json!({"ops":[{"op":"replace","path":[],"value":state.borrow_and_update().clone()}]})
                    }
                }
            };
            Some((
                Ok::<_, Infallible>(Event::default().data(packet.to_string())),
                (first, state, rx, stop, guard),
            ))
        },
    );
    let mut response = Sse::new(events)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
        .into_response();
    response
        .headers_mut()
        .insert("statewire-lease", lease.parse().unwrap());
    response
}

pub(super) async fn frames(
    State(host): State<Shared>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(frame): Json<Frame>,
) -> Response {
    if token != host.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let lease = headers
        .get("statewire-lease")
        .and_then(|v| v.to_str().ok())
        .and_then(|key| host.leases.lock().unwrap().get(key).cloned());
    let Some(lease) = lease else {
        return StatusCode::LOCKED.into_response();
    };
    if frame.cmd.is_empty() || frame.cmd.len() > 16 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut commands = lease.commands.lock().await;
    // Validate the whole frame before admitting any operation.
    let mut expected = commands.seq;
    for statement in &frame.cmd {
        if statement.protocol != "default" || statement.seq == 0 {
            return StatusCode::BAD_REQUEST.into_response();
        }
        if statement.seq <= commands.seq {
            continue;
        }
        if statement.seq != expected + 1 {
            return (
                StatusCode::CONFLICT,
                Json(json!({"syn":{"protocols":[{"name":"default","seq":commands.seq}]}})),
            )
                .into_response();
        }
        expected = statement.seq;
    }
    for statement in frame.cmd {
        if statement.seq <= commands.seq {
            if let Some(answer) = commands.answers.get(&statement.seq) {
                let _ = lease.tx.try_send(json!({"ops":[{"op":"replace","path":[],"value":host.state.borrow().clone()}],"cmd":[answer]}));
            }
            continue;
        }
        commands.seq = statement.seq;
        // Admission and command dispatch happen together without an await. A
        // lost POST response cannot turn its retry into a second execution.
        let result = host.command(&statement.method, &statement.params);
        let answer = match result {
            Ok(()) => {
                json!({"protocol":"default","seq":statement.seq,"type":"result","payload":null})
            }
            Err(message) => {
                json!({"protocol":"default","seq":statement.seq,"type":"rejected","message":message})
            }
        };
        // Publish the current state with the answer, including busy admission.
        let packet = json!({"ops":[{"op":"replace","path":[],"value":host.state.borrow().clone()}],"cmd":[answer]});
        commands.answers.insert(statement.seq, answer);
        while commands.answers.len() > 64 {
            commands.answers.pop_first();
        }
        if lease.tx.try_send(packet).is_err() {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }
    StatusCode::OK.into_response()
}
