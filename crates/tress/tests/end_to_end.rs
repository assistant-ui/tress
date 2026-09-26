//! Drives the real binary against a mock Messages API, so the whole path —
//! HTTP, SSE parsing, the tool loop, the approval gate, and the filesystem
//! tools — runs exactly as it does against Anthropic.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Serves one scripted SSE response per request, in order.
fn serve(scripts: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for script in scripts {
            let Ok((stream, _)) = listener.accept() else {
                break;
            };
            requests.push(handle_request(stream, &script));
        }
        requests
    });
    (format!("http://127.0.0.1:{port}"), handle)
}

/// Reads one request, replies with `script` as an SSE stream, returns the
/// request body.
fn handle_request(mut stream: TcpStream, script: &str) -> String {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut length = 0usize;
    let mut authenticated = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("x-api-key:") {
            authenticated = matches!(value.trim(), "test-key" | "saved-test-key");
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    assert!(
        authenticated,
        "mock API requires the expected test credential"
    );
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).expect("request body");

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{script}"
    );
    stream.write_all(response.as_bytes()).expect("write");
    stream.flush().ok();
    String::from_utf8_lossy(&body).into_owned()
}

/// Builds an SSE body from `(event type, json)` pairs.
fn sse(events: &[serde_json::Value]) -> String {
    events
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect()
}

fn text_reply(text: &str) -> String {
    sse(&[
        serde_json::json!({"type": "message_start"}),
        serde_json::json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        serde_json::json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
        serde_json::json!({"type": "content_block_stop", "index": 0}),
        serde_json::json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}}),
        serde_json::json!({"type": "message_stop"}),
    ])
}

fn tool_reply(name: &str, input: serde_json::Value) -> String {
    let json = input.to_string();
    sse(&[
        serde_json::json!({"type": "message_start"}),
        serde_json::json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "call_1", "name": name, "input": {}}}),
        serde_json::json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json}}),
        serde_json::json!({"type": "content_block_stop", "index": 0}),
        serde_json::json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
        serde_json::json!({"type": "message_stop"}),
    ])
}

fn binary() -> PathBuf {
    let mut path = std::env::current_exe().expect("test binary path");
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.join("tress")
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("tress-e2e-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("scratch dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn isolated_command(dir: &Path) -> Command {
    let mut command = Command::new(binary());
    command
        .current_dir(dir)
        .env("XDG_CONFIG_HOME", dir.join("config"))
        .env_remove("TRESS_MODEL")
        .env_remove("TRESS_MAX_STEPS")
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_BASE_URL");
    command
}

fn run(dir: &Path, base_url: &str, prompt: &str) -> std::process::Output {
    isolated_command(dir)
        .arg("ask")
        .arg(prompt)
        .current_dir(dir)
        .env("ANTHROPIC_API_KEY", "test-key")
        .env("ANTHROPIC_BASE_URL", base_url)
        .env("TRESS_MODEL", "claude-sonnet-5")
        .output()
        .expect("run tress")
}

#[test]
fn attach_keeps_pipes_plain_even_when_ui_is_requested() {
    for flags in [vec![], vec!["--ui"], vec!["--plain"]] {
        let mut child = Command::new(binary())
            .args(["attach", "http://127.0.0.1:1"])
            .args(flags)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"/help\n/exit\n")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("/reconnect"));
        assert!(
            !stdout.contains("\x1b[?1049h"),
            "entered alternate screen on a pipe"
        );
        assert!(!stdout.contains("\x1b[?1000h"), "captured mouse on a pipe");
    }
}

#[test]
fn interactive_commands_do_not_call_the_model_or_change_files() {
    let scratch = Scratch::new("commands");
    let file = scratch.path().join("keep.txt");
    std::fs::write(&file, "unchanged").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut child = isolated_command(scratch.path())
        .env("ANTHROPIC_API_KEY", "test-key")
        .env(
            "ANTHROPIC_BASE_URL",
            format!("http://{}", listener.local_addr().unwrap()),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"/\n/files\n/status\n/not-a-command\n/clear\n/quit\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success());
    assert!(stdout.contains("/help"), "{stdout}");
    assert!(stdout.contains("keep.txt"), "{stdout}");
    assert!(
        stdout.contains("Local session\nStatus     idle\n"),
        "{stdout}"
    );
    assert!(
        stdout.contains("Unknown command: /not-a-command"),
        "{stdout}"
    );
    assert!(stdout.contains("Conversation cleared"), "{stdout}");
    assert_eq!(std::fs::read_to_string(file).unwrap(), "unchanged");
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn writes_a_file_then_reports_back() {
    let scratch = Scratch::new("write");
    let (base_url, server) = serve(vec![
        tool_reply(
            "write",
            serde_json::json!({"path": "hello.txt", "content": "hi from tress"}),
        ),
        text_reply("Created hello.txt."),
    ]);

    let output = run(
        scratch.path(),
        &base_url,
        "create hello.txt saying hi from tress",
    );
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("hello.txt")).unwrap(),
        "hi from tress"
    );
    assert!(stdout.contains("Created hello.txt."), "stdout: {stdout}");
    assert!(
        stdout.contains("write hello.txt"),
        "tool line missing: {stdout}"
    );

    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);

    let first: serde_json::Value = serde_json::from_str(&requests[0]).unwrap();
    assert_eq!(first["model"], "claude-sonnet-5");
    assert_eq!(first["stream"], true);
    let tool_names: Vec<&str> = first["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(tool_names, ["read", "write", "edit", "ls", "bash"]);

    let second: serde_json::Value = serde_json::from_str(&requests[1]).unwrap();
    let result = &second["messages"][2]["content"][0];
    assert_eq!(result["type"], "tool_result");
    assert_eq!(result["is_error"], false);
    assert_eq!(result["tool_use_id"], "call_1");
}

#[test]
fn reads_a_file_and_answers() {
    let scratch = Scratch::new("read");
    std::fs::write(scratch.path().join("note.md"), "the answer is 42").unwrap();
    let (base_url, server) = serve(vec![
        tool_reply("read", serde_json::json!({"path": "note.md"})),
        text_reply("The note says the answer is 42."),
    ]);

    let output = run(scratch.path(), &base_url, "what does note.md say?");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("answer is 42"), "stdout: {stdout}");

    let requests = server.join().unwrap();
    let second: serde_json::Value = serde_json::from_str(&requests[1]).unwrap();
    assert_eq!(
        second["messages"][2]["content"][0]["content"],
        "the answer is 42"
    );
}

#[test]
fn a_gated_command_is_denied_without_a_terminal() {
    let scratch = Scratch::new("gate");
    let (base_url, server) = serve(vec![
        tool_reply(
            "bash",
            serde_json::json!({"command": "touch should-not-exist"}),
        ),
        text_reply("Understood, I won't run it."),
    ]);

    let output = run(scratch.path(), &base_url, "run touch");
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        !scratch.path().join("should-not-exist").exists(),
        "denied command must not run"
    );
    assert!(stdout.contains("denied"), "stdout: {stdout}");

    let requests = server.join().unwrap();
    let second: serde_json::Value = serde_json::from_str(&requests[1]).unwrap();
    let result = &second["messages"][2]["content"][0];
    assert_eq!(result["is_error"], true);
    assert!(result["content"].as_str().unwrap().contains("denied"));
}

#[test]
fn a_tool_error_is_reported_to_the_model_not_fatal() {
    let scratch = Scratch::new("error");
    let (base_url, server) = serve(vec![
        tool_reply("read", serde_json::json!({"path": "missing.txt"})),
        text_reply("That file does not exist."),
    ]);

    let output = run(scratch.path(), &base_url, "read missing.txt");
    assert!(output.status.success());

    let requests = server.join().unwrap();
    let second: serde_json::Value = serde_json::from_str(&requests[1]).unwrap();
    assert_eq!(second["messages"][2]["content"][0]["is_error"], true);
}

#[test]
fn a_missing_key_fails_with_a_clear_message() {
    let scratch = Scratch::new("nokey");
    let output = isolated_command(scratch.path())
        .arg("ask")
        .arg("hi")
        .current_dir(scratch.path())
        .env_remove("ANTHROPIC_API_KEY")
        .output()
        .expect("run tress");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("ANTHROPIC_API_KEY"));
}

#[test]
fn saved_settings_are_used_after_clearing_a_conversation() {
    let scratch = Scratch::new("saved-clear");
    let (url, server) = serve(vec![text_reply("first reply"), text_reply("after clear")]);
    let mut setup = isolated_command(scratch.path())
        .args([
            "setup",
            "--key-stdin",
            "--model",
            "saved-model",
            "--base-url",
            &url,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    setup
        .stdin
        .take()
        .unwrap()
        .write_all(b"saved-test-key\n")
        .unwrap();
    assert!(setup.wait_with_output().unwrap().status.success());
    let mut child = isolated_command(scratch.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"hello\n/clear\nhello again\n/quit\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("after clear"));
    let requests = server.join().unwrap();
    for request in requests {
        let body: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(body["model"], "saved-model");
        assert_eq!(
            body["messages"].as_array().unwrap().len(),
            1,
            "clear must reset history"
        );
    }
}

#[test]
fn configured_step_limit_stops_the_real_binary() {
    let scratch = Scratch::new("step-limit");
    let (url, server) = serve(vec![tool_reply("ls", serde_json::json!({}))]);
    let output = isolated_command(scratch.path())
        .args(["ask", "--max-steps", "1", "list files"])
        .env("ANTHROPIC_API_KEY", "test-key")
        .env("ANTHROPIC_BASE_URL", url)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("stopped after 1 model steps"));
    assert_eq!(server.join().unwrap().len(), 1);
}
