//! Attaching the terminal to a thread.
//!
//! A thread is replicated state on a host, so the terminal is just another
//! client: it renders what the thread holds and sends prompts back as
//! commands. Whoever is driving the run — this terminal, a browser, or
//! nobody at all — every attached client sees the same thing.

use std::io::Write;

use serde::Deserialize;
use serde_json::{json, Value};
use statewire::session::{Config, Event};
use statewire::transport::http::{connect, generate_client_id};
use statewire::{ProtocolOffer, VersionRange, WIRE_VERSION};
use tokio::io::{AsyncBufReadExt, BufReader};

/// One message in the thread.
#[derive(Debug, Clone, Default, Deserialize)]
struct Entry {
    #[serde(default)]
    role: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    tools: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ThreadState {
    #[serde(default)]
    entries: Vec<Entry>,
    #[serde(default)]
    status: String,
}

/// Tracks what has already reached the terminal, so each change prints only
/// what is new rather than redrawing the transcript.
#[derive(Default)]
struct Printed {
    entries: usize,
    text: usize,
    tools: usize,
    status: String,
}

const PROTOCOL: &str = "default";

pub async fn run(url: &str, style: &crate::Style) -> Result<(), String> {
    let config = Config {
        client_id: generate_client_id(),
        wire: VersionRange::exact(WIRE_VERSION),
        offers: vec![ProtocolOffer {
            name: PROTOCOL.to_owned(),
            range: VersionRange::exact(WIRE_VERSION),
            optional: false,
        }],
    };

    let (client, mut events) = connect(url, config)
        .await
        .map_err(|error| format!("{error}"))?;

    println!(
        "{} {}",
        style.paint(crate::ansi::DIM, "attached to"),
        style.paint(crate::ansi::BOLD, url)
    );
    println!(
        "{}",
        style.paint(
            crate::ansi::DIM,
            "type to send · the thread keeps running when you leave · ctrl-d to detach"
        )
    );

    // Prompts typed here become `send` commands on the thread.
    let (lines_tx, mut lines_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut reader = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if lines_tx.send(line).is_err() {
                break;
            }
        }
    });

    let mut printed = Printed::default();

    loop {
        tokio::select! {
            typed = lines_rx.recv() => {
                match typed {
                    Some(line) if !line.trim().is_empty() => {
                        client
                            .command(PROTOCOL, "send", vec![json!(line.trim())])
                            .await;
                    }
                    Some(_) => {}
                    None => break,
                }
            }
            event = events.recv() => {
                let Some(event) = event else { break };
                match event {
                    Event::Connected { .. } | Event::StateChanged => {
                        let value = client.main_value(PROTOCOL).await;
                        if let Some(value) = value {
                            render(&value, &mut printed, style);
                        }
                    }
                    Event::Finished { fin, .. } => {
                        println!(
                            "{}",
                            style.paint(
                                crate::ansi::DIM,
                                &format!("detached: {:?}", fin.reason)
                            )
                        );
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

/// Prints whatever the thread gained since the last render.
fn render(value: &Value, printed: &mut Printed, style: &crate::Style) {
    let Ok(state) = serde_json::from_value::<ThreadState>(value.clone()) else {
        return;
    };

    // A reset shortens the thread; start the transcript over.
    if state.entries.len() < printed.entries {
        *printed = Printed::default();
        println!("{}", style.paint(crate::ansi::DIM, "— thread reset —"));
    }

    for (index, entry) in state.entries.iter().enumerate() {
        let fresh = index >= printed.entries;
        if fresh {
            printed.entries = index + 1;
            printed.text = 0;
            printed.tools = 0;
            if entry.role == "user" {
                println!("\n{} {}", style.paint(crate::ansi::AMBER, "❯"), entry.text);
                printed.text = entry.text.len();
                continue;
            }
        }
        if entry.role == "user" {
            continue;
        }
        // The last entry is the one that grows while a run streams.
        if index + 1 == state.entries.len() {
            for tool in entry.tools.iter().skip(printed.tools) {
                println!("{}", style.paint(crate::ansi::DIM, &format!("  · {tool}")));
            }
            printed.tools = entry.tools.len();

            if entry.text.len() > printed.text {
                print!("{}", &entry.text[printed.text..]);
                let _ = std::io::stdout().flush();
                printed.text = entry.text.len();
            }
        }
    }

    if state.status != printed.status {
        if printed.status == "running" && state.status == "idle" {
            println!();
        }
        printed.status = state.status;
    }
}
