//! Attaching the terminal to a thread.
//!
//! A thread is replicated state on a host, so the terminal is just another
//! client: it renders what the thread holds and sends prompts back as
//! commands. Whoever is driving the run — this terminal, a browser, or
//! nobody at all — every attached client sees the same thing.

use std::collections::BTreeMap;
use std::io::{BufRead, IsTerminal, Write};

use futures_util::StreamExt;

use serde::Deserialize;
use serde_json::{json, Value};
use statewire::session::{Config, Event};
use statewire::transport::http::{connect, generate_client_id};
use statewire::wire::Verdict;
use statewire::{ProtocolOffer, VersionRange, WIRE_VERSION};

use crate::commands::{self, Command};

mod recent;
mod ui;

/// One message in the thread.
#[derive(Debug, Clone, Default, Deserialize)]
struct Entry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    error: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ThreadState {
    #[serde(default)]
    entries: Vec<Entry>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    runs: usize,
    #[serde(default)]
    clients: Vec<ConnectedClient>,
    #[serde(default)]
    harness: Option<ManagedHarness>,
    #[serde(default)]
    workspace: Option<WorkspaceInfo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct WorkspaceInfo {
    mode: String,
    root: Option<String>,
}

impl WorkspaceInfo {
    fn label(&self) -> &str {
        match self.mode.as_str() {
            "vercel" => "sandbox",
            mode => mode,
        }
    }

    fn path_notice(&self) -> String {
        match self.mode.as_str() {
            "local" => self.root.as_ref().map_or_else(
                || "The host has not provided its local workspace path.".into(),
                |root| format!("Local workspace on the host: {root}"),
            ),
            "vercel" => "Sandbox workspace: files live remotely, not on this host.".into(),
            "memory" => "Virtual files in memory; there is no local disk path.".into(),
            "overlay" => "Overlay workspace: reads local files; edits stay in memory. No writable local folder.".into(),
            _ => "This workspace does not expose a local disk path.".into(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ConnectedClient {
    #[serde(default)]
    id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    label: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ManagedHarness {
    #[serde(rename = "threadId")]
    id: String,
    connection: String,
    error: Option<String>,
}

/// Tracks what has already reached the terminal.
///
/// `done` counts entries printed in full; the fields after it track how far
/// the entry at `done` has been printed, which is the one that grows while a
/// run streams.
#[derive(Default)]
struct Printed {
    first_id: Option<String>,
    done: usize,
    started: bool,
    text: usize,
    tools: usize,
    line_open: bool,
}

const PROTOCOL: &str = "default";

/// Where a host serves its thread when the URL names only an origin.
const DEFAULT_PATH: &str = "/api/thread";

/// Expands what a person is likely to type into the thread's URL.
///
/// An origin alone (`localhost:5312`, `https://example.com`) means that
/// host's default thread; a URL that already carries a path is used as
/// given, so other layouts still work.
fn thread_url(input: &str) -> String {
    let with_scheme = if input.contains("://") {
        input.to_owned()
    } else {
        format!("http://{input}")
    };
    let trimmed = with_scheme.trim_end_matches('/').to_owned();
    let after_scheme = trimmed.find("://").map_or(0, |index| index + 3);
    if trimmed[after_scheme..].contains('/') {
        trimmed
    } else {
        format!("{trimmed}{DEFAULT_PATH}")
    }
}

/// The CLI keeps the access ID separate; Statewire uses the scoped endpoint.
fn session_url(input: &str, id: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&thread_url(input)).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("the host must use http or https".into());
    }
    if url.path() != DEFAULT_PATH || url.query().is_some() || url.fragment().is_some() {
        return Err(
            "with -s / --session, use the host URL, for example http://localhost:5311".into(),
        );
    }
    url.set_path(&format!("/api/sessions/{id}"));
    Ok(url.to_string())
}

fn connection_config() -> Config {
    Config {
        client_id: generate_client_id(),
        wire: VersionRange::exact(WIRE_VERSION),
        offers: vec![ProtocolOffer {
            name: PROTOCOL.to_owned(),
            range: VersionRange::exact(WIRE_VERSION),
            optional: false,
        }],
    }
}

pub async fn run(
    input: &str,
    style: &crate::Style,
    ui_requested: bool,
    session: Option<&str>,
) -> Result<(), String> {
    let mut url = match session {
        Some(id) => session_url(input, id)?,
        None => thread_url(input),
    };
    let mut display_url = session.map_or_else(
        || url.clone(),
        |id| {
            format!(
                "{input} · session {}",
                if id.len() <= 12 { id } else { &id[..8] }
            )
        },
    );
    let mut attach_command = session.map_or_else(
        || format!("tress attach {input}"),
        |id| format!("tress attach {input} -s {id}"),
    );
    let (initial, mut events) = connect(&url, connection_config())
        .await
        .map_err(|error| error.to_string())?;
    let mut client = Some(initial);
    let interactive = ui_requested
        && std::io::stdin().is_terminal()
        && std::io::stdout().is_terminal()
        && std::env::var("TERM").as_deref() != Ok("dumb");
    let mut screen = if interactive {
        Some(ui::Screen::new().map_err(|error| error.to_string())?)
    } else {
        None
    };
    let mut keyboard = interactive.then(crossterm::event::EventStream::new);
    let mut recent = recent::RecentThreads::load();
    recent.remember(&url, None);
    let mut remembered = false;
    if let Some(screen) = &mut screen {
        screen.set_threads(&recent.items, &url);
    }
    let (lines_tx, mut lines_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    if !interactive {
        println!(
            "tress {} · shared thread · {display_url}",
            env!("CARGO_PKG_VERSION")
        );
        println!("/help for commands · the host keeps running when you leave · /exit to detach");
        // A dedicated reader lets /exit quit even while a pipe stays open.
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                if lines_tx.send(line).is_err() {
                    break;
                }
            }
        });
    }

    let mut printed = Printed::default();
    let mut snapshot: Option<ThreadState> = None;
    let mut pending = None;
    let mut plain_prompt = false;
    let mut cloud_error: Option<String> = None;

    loop {
        let connected = match &client {
            Some(current) => current.with_session(|session| session.is_connected()).await,
            None => false,
        };
        let managed = snapshot.as_ref().and_then(|state| state.harness.as_ref());
        let connected = connected && managed.is_none_or(|cloud| cloud.connection == "connected");
        let connection = if connected {
            "connected"
        } else if client.is_some() {
            "connecting"
        } else {
            "disconnected"
        };
        if let Some(screen) = &mut screen {
            screen
                .draw(
                    snapshot.as_ref(),
                    connection,
                    pending.is_some(),
                    &display_url,
                )
                .map_err(|error| error.to_string())?;
        } else if !plain_prompt
            && pending.is_none()
            && snapshot
                .as_ref()
                .is_some_and(|state| state.status != "running")
        {
            print!("\n{} ", style.paint(crate::ansi::AMBER, "❯"));
            let _ = std::io::stdout().flush();
            plain_prompt = true;
        }

        let typed = tokio::select! {
            typed = lines_rx.recv(), if !interactive => {
                let Some(line) = typed else { break };
                plain_prompt = false;
                Some(line)
            }
            key = async { keyboard.as_mut().unwrap().next().await }, if interactive => {
                let Some(event) = key else { break };
                let action = screen.as_mut().unwrap().event(event.map_err(|error| error.to_string())?, snapshot.as_ref().map_or(0, |state| state.files.len())).map_err(|error| error.to_string())?;
                match action {
                    Some(ui::Action::Exit) => break,
                    Some(ui::Action::Submit(line)) => Some(line),
                    Some(ui::Action::Threads) => {
                        recent = recent::RecentThreads::load();
                        recent.remember(&url, None);
                        let screen = screen.as_mut().unwrap();
                        screen.set_threads(&recent.items, &url);
                        screen.threads();
                        None
                    }
                    Some(ui::Action::Switch(next_url)) => {
                        if next_url != url {
                            match connect(&next_url, connection_config()).await {
                                Ok((next, next_events)) => {
                                    screen.as_mut().unwrap().switch(&url, &next_url);
                                    client = Some(next);
                                    events = next_events;
                                    url = next_url;
                                    display_url = recent::location(&url);
                                    attach_command = recent::attach_command(&url);
                                    snapshot = None;
                                    pending = None;
                                    cloud_error = None;
                                    remembered = false;
                                    recent.remember(&url, None);
                                    screen.as_mut().unwrap().set_threads(&recent.items, &url);
                                }
                                Err(error) => notice(&mut screen, &format!("Couldn’t switch threads: {error}")),
                            }
                        }
                        None
                    }
                    None => None,
                }
            }
            event = events.recv(), if client.is_some() => {
                let Some(event) = event else {
                    client = None;
                    pending = None;
                    notice(&mut screen, "Connection closed. Use /reconnect to try again.");
                    continue;
                };
                match event {
                    Event::Connected { .. } | Event::StateChanged => {
                        let value = client.as_ref().unwrap().main_value(PROTOCOL).await;
                        if let Some(value) = value {
                            snapshot = serde_json::from_value(value.clone()).ok();
                            if interactive {
                                let title = snapshot.as_ref().and_then(|state| state.entries.iter().find(|entry| entry.role == "user")).map(|entry| entry.text.as_str());
                                let changed = recent.remember(&url, title);
                                if changed || !remembered {
                                    if let Err(error) = recent.save() {
                                        notice(&mut screen, &format!("Couldn’t save recent threads: {error}"));
                                    }
                                    remembered = true;
                                    screen.as_mut().unwrap().set_threads(&recent.items, &url);
                                }
                            }
                            let error = snapshot.as_ref().and_then(|state| state.harness.as_ref()).and_then(|cloud| cloud.error.clone());
                            if error != cloud_error {
                                if let Some(message) = &error {
                                    notice(&mut screen, &format!("Managed Harness: {message}"));
                                }
                                cloud_error = error;
                            }
                            if screen.is_none() {
                                if plain_prompt { println!(); plain_prompt = false; }
                                render(&value, &mut printed, style);
                            }
                        }
                    }
                    Event::CommandUpdate { answer, terminal: true } if pending == Some(answer.seq) => {
                        pending = None;
                        if answer.verdict.is_some_and(|verdict| verdict != Verdict::Result) {
                            notice(&mut screen, &format!("Command failed: {}", answer.message.as_deref().unwrap_or("the host rejected the command")));
                        }
                    }
                    Event::CommandsLost { .. } => {
                        pending = None;
                        notice(&mut screen, "Connection interrupted. Use /status or /reconnect before sending again.");
                    }
                    Event::Finished { fin, .. } => {
                        client = None;
                        pending = None;
                        notice(&mut screen, &format!("Detached: {:?}. Use /reconnect to rejoin the thread.", fin.reason));
                    }
                    _ => {}
                }
                None
            }
        };
        let Some(line) = typed else { continue };
        let prompt = line.trim();
        if prompt.is_empty() {
            continue;
        }
        let command = commands::parse(prompt);
        let mut accepted = true;
        match command {
            Some(Command::Help) => {
                if screen.is_none() {
                    commands::help(true);
                }
            }
            Some(Command::Exit) => break,
            Some(Command::Attach) => notice(&mut screen, &attach_command),
            Some(Command::Pwd) => {
                let detail = snapshot.as_ref().and_then(|state| state.workspace.as_ref()).map_or_else(
                    || "Workspace information is unavailable. Reconnect to an updated host and try /pwd again.".into(),
                    WorkspaceInfo::path_notice,
                );
                notice(&mut screen, &detail);
            }
            Some(Command::Threads) => {
                recent = recent::RecentThreads::load();
                recent.remember(&url, None);
                if let Some(screen) = &mut screen {
                    screen.set_threads(&recent.items, &url);
                }
                if screen.is_none() {
                    for thread in &recent.items {
                        println!(
                            "  {}\n    {}",
                            thread.title,
                            recent::attach_command(&thread.url)
                        );
                    }
                }
            }
            Some(Command::Files) => {
                if screen.is_none() {
                    if let Some(state) = &snapshot {
                        if !connected {
                            println!("Last known workspace; /reconnect to sync.");
                        }
                        if state.files.is_empty() {
                            println!("No workspace files.");
                        }
                        for name in state.files.keys() {
                            println!("  {name}");
                        }
                    } else {
                        println!("Waiting for the workspace. Use /status to check the connection.");
                    }
                }
            }
            Some(Command::Status) => {
                let detail = snapshot.as_ref().map_or_else(
                    || format!("{connection}\nWaiting for workspace"),
                    |state| {
                        let mut detail = format!(
                            "{connection}\nAgent      {}\nRuns       {} completed\nFiles      {}",
                            state.status,
                            state.runs,
                            state.files.len()
                        );
                        if let Some(cloud) = &state.harness {
                            detail.push_str(&format!(
                                "\nThread     {}\nCloud      {}",
                                cloud.id, cloud.connection
                            ));
                        }
                        if let Some(workspace) = &state.workspace {
                            detail.push_str(&format!("\nWorkspace  {}", workspace.label()));
                        }
                        detail.push_str("\n\n");
                        detail.push_str(&client_status(&state.clients, connected));
                        if !connected {
                            detail.push_str("\nUse /reconnect to sync.");
                        }
                        detail
                    },
                );
                notice(&mut screen, &detail);
            }
            Some(Command::Disconnect) => {
                client = None; // Drop the transport; the shared host keeps running.
                pending = None;
                notice(
                    &mut screen,
                    "Disconnected. The host keeps running. Use /reconnect to catch up.",
                );
            }
            Some(Command::Reconnect) => {
                drop(client.take());
                pending = None;
                let (next, next_events) = connect(&url, connection_config())
                    .await
                    .map_err(|error| error.to_string())?;
                client = Some(next);
                events = next_events;
                notice(&mut screen, "Reconnecting to the shared thread…");
            }
            Some(Command::Unknown) => {
                accepted = false;
                notice(
                    &mut screen,
                    &format!("Unknown command: {prompt}. Type /help for commands."),
                );
            }
            Some(Command::Clear) | None => {
                if !connected || snapshot.is_none() {
                    accepted = false;
                    notice(
                        &mut screen,
                        "Not connected. Use /reconnect; your draft has not been sent.",
                    );
                } else if pending.is_some()
                    || snapshot
                        .as_ref()
                        .is_some_and(|state| state.status == "running")
                {
                    accepted = false;
                    notice(&mut screen, "The host is working. Your draft is kept; send it when the status is ready.");
                } else if let Some(current) = &client {
                    let (method, args) = if command == Some(Command::Clear) {
                        ("reset", vec![])
                    } else {
                        ("send", vec![json!(prompt)])
                    };
                    pending = Some(current.command(PROTOCOL, method, args).await);
                    if let Some(screen) = &mut screen {
                        screen.notice("");
                    }
                }
            }
        }
        if accepted {
            if let Some(screen) = &mut screen {
                screen.accept();
                if command == Some(Command::Help) {
                    screen.help();
                }
                if command == Some(Command::Files) {
                    screen.files();
                }
                if command == Some(Command::Threads) {
                    screen.threads();
                }
            }
        }
    }
    Ok(())
}

fn client_status(clients: &[ConnectedClient], live: bool) -> String {
    let noun = if clients.len() == 1 {
        "client"
    } else {
        "clients"
    };
    let prefix = if live { "connected" } else { "last known" };
    if clients.is_empty() {
        return format!("0 {prefix} {noun}");
    }
    let labels = clients
        .iter()
        .map(|client| {
            let label = if client.label.is_empty() {
                if client.kind.is_empty() {
                    "unknown client"
                } else {
                    &client.kind
                }
            } else {
                &client.label
            };
            let short_id: String = client.id.chars().take(6).collect();
            if short_id.is_empty() {
                format!("  - {label}")
            } else {
                format!("  - {label} [{short_id}]")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{} {prefix} {noun}\n{labels}", clients.len())
}

fn notice(screen: &mut Option<ui::Screen>, message: &str) {
    if let Some(screen) = screen {
        screen.notice(message);
    } else {
        println!("{message}");
    }
}

/// Prints whatever the thread gained since the last render.
///
/// Entries before the last can no longer change, so they are emitted in
/// full; the last one is emitted as a delta so text streams as it arrives.
/// That makes a fresh attach replay the whole transcript rather than only
/// the newest reply.
fn render(value: &Value, printed: &mut Printed, style: &crate::Style) {
    let Ok(state) = serde_json::from_value::<ThreadState>(value.clone()) else {
        return;
    };

    // Another client may reset and start a new run while we're disconnected.
    // Compare identities too: the replacement thread can be just as long.
    let first_id = state.entries.first().map(|entry| entry.id.clone());
    if (printed.started || printed.done > 0)
        && (state.entries.len() < printed.done || first_id != printed.first_id)
    {
        *printed = Printed::default();
        println!("{}", style.paint(crate::ansi::DIM, "— thread reset —"));
    }
    printed.first_id = first_id;

    while printed.done + 1 < state.entries.len() {
        emit(&state.entries[printed.done], printed, style, true);
        printed.done += 1;
        printed.started = false;
        printed.text = 0;
        printed.tools = 0;
    }

    if let Some(entry) = state.entries.get(printed.done) {
        emit(entry, printed, style, false);
    }

    // Leave the cursor on its own line once a run settles, so what the user
    // types next does not continue the agent's last sentence.
    let running = state.status == "running";
    if !running && printed.line_open {
        println!();
        printed.line_open = false;
    }
}

/// Emits what is new in one entry. `complete` closes it off, for an entry
/// that can no longer grow.
fn emit(entry: &Entry, printed: &mut Printed, style: &crate::Style, complete: bool) {
    if entry.role == "user" {
        if !printed.started {
            println!("\n{} {}", style.paint(crate::ansi::AMBER, "❯"), entry.text);
            printed.started = true;
            printed.text = entry.text.len();
            printed.line_open = false;
        }
        return;
    }

    printed.started = true;
    for tool in entry.tools.iter().skip(printed.tools) {
        if printed.line_open {
            println!();
        }
        println!("{}", style.paint(crate::ansi::DIM, &format!("  · {tool}")));
        printed.line_open = false;
    }
    printed.tools = entry.tools.len();

    // Text only ever grows by appending, but guard the split anyway so a
    // rewritten reply cannot panic on a multi-byte boundary.
    if entry.text.len() > printed.text && entry.text.is_char_boundary(printed.text) {
        print!("{}", &entry.text[printed.text..]);
        let _ = std::io::stdout().flush();
        printed.text = entry.text.len();
        printed.line_open = !entry.text.ends_with('\n');
    }

    if complete && printed.line_open {
        println!();
        printed.line_open = false;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        client_status, render, session_url, thread_url, ConnectedClient, Printed, WorkspaceInfo,
    };

    #[test]
    fn pwd_uses_the_hosts_scoped_root_and_does_not_claim_virtual_files_are_local() {
        let workspace = WorkspaceInfo {
            mode: "local".into(),
            root: Some("/host/threads/visitor-a".into()),
        };
        assert_eq!(
            workspace.path_notice(),
            "Local workspace on the host: /host/threads/visitor-a"
        );
        for mode in ["memory", "overlay", "vercel"] {
            let remote = WorkspaceInfo {
                mode: mode.into(),
                root: workspace.root.clone(),
            };
            assert!(!remote.path_notice().contains("/host/threads/visitor-a"));
        }
    }

    #[test]
    fn session_id_selects_the_scoped_endpoint() {
        let id = "0123456789abcdef0123456789abcdef";
        for host in [
            "localhost:5311",
            "http://localhost:5311",
            "http://localhost:5311/",
        ] {
            assert_eq!(
                session_url(host, id).unwrap(),
                format!("http://localhost:5311/api/sessions/{id}")
            );
        }
        assert_eq!(
            session_url("https://demo.example", id).unwrap(),
            format!("https://demo.example/api/sessions/{id}")
        );
        assert!(session_url("https://demo.example/another-thread", id).is_err());
        assert!(session_url("https://demo.example/?session=other", id).is_err());
    }

    #[test]
    fn client_status_uses_live_identity_and_marks_stale_snapshots() {
        let clients = vec![
            ConnectedClient {
                id: "abcdef012345".into(),
                kind: "browser".into(),
                label: "Chrome on macOS".into(),
            },
            ConnectedClient {
                id: "123456abcdef".into(),
                kind: "terminal".into(),
                label: "tress terminal".into(),
            },
        ];
        assert_eq!(
            client_status(&clients, true),
            "2 connected clients\n  - Chrome on macOS [abcdef]\n  - tress terminal [123456]"
        );
        assert!(client_status(&clients, false).starts_with("2 last known clients\n"));
    }

    #[test]
    fn reconnect_after_a_reset_replays_replacement_entries() {
        let style = crate::Style { on: false };
        let mut printed = Printed::default();
        render(
            &serde_json::json!({"entries": [
            {"id": "old-user", "role": "user", "text": "old prompt"},
            {"id": "old-agent", "role": "agent", "text": "old longer reply"}
        ], "status": "idle"}),
            &mut printed,
            &style,
        );
        render(
            &serde_json::json!({"entries": [
            {"id": "new-user", "role": "user", "text": "new prompt"},
            {"id": "new-agent", "role": "agent", "text": "new reply"}
        ], "status": "idle"}),
            &mut printed,
            &style,
        );
        assert_eq!(printed.first_id.as_deref(), Some("new-user"));
        assert_eq!(printed.done, 1);
        assert_eq!(printed.text, "new reply".len());
        assert!(
            !printed.line_open,
            "an idle snapshot must end on its own line"
        );
    }

    #[test]
    fn an_origin_gets_the_default_thread_path() {
        for input in [
            "http://localhost:5312",
            "http://localhost:5312/",
            "localhost:5312",
        ] {
            assert_eq!(
                thread_url(input),
                "http://localhost:5312/api/thread",
                "{input}"
            );
        }
    }

    #[test]
    fn https_and_bare_hosts_work() {
        assert_eq!(
            thread_url("https://demo.example"),
            "https://demo.example/api/thread"
        );
        assert_eq!(thread_url("example.com"), "http://example.com/api/thread");
    }

    #[test]
    fn an_explicit_path_is_left_alone() {
        assert_eq!(
            thread_url("http://localhost:5312/threads/abc"),
            "http://localhost:5312/threads/abc"
        );
        assert_eq!(
            thread_url("http://localhost:5312/api/thread/"),
            "http://localhost:5312/api/thread"
        );
    }
}
