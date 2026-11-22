//! Drives the real binary's attach path against a scripted Statewire
//! WebSocket host: the CLI dials `<thread>/ws`, keeps credentials out of the
//! URL, sends them on the upgrade and in the first message, and ends
//! cleanly when the host refuses them.

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use tungstenite::handshake::server::{Request, Response};
use tungstenite::Message;

fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_tress"))
}

struct Attach {
    uri: String,
    upgrade_authorization: Option<String>,
    first_message: serde_json::Value,
}

/// Accepts one attach, records it, then refuses it as unauthorized.
fn refusing_host() -> (u16, mpsc::Receiver<Attach>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (attaches, received) = mpsc::channel();
    let host = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut uri = String::new();
        let mut upgrade_authorization = None;
        #[allow(clippy::result_large_err)]
        let callback = |request: &Request, mut response: Response| {
            uri = request.uri().to_string();
            upgrade_authorization = request
                .headers()
                .get("authorization")
                .map(|value| value.to_str().unwrap().to_owned());
            response
                .headers_mut()
                .insert("sec-websocket-protocol", "statewire.v1".parse().unwrap());
            Ok(response)
        };
        let mut socket = tungstenite::accept_hdr(stream, callback).unwrap();
        let first = socket.read().unwrap();
        let first_message = serde_json::from_str(first.to_text().unwrap()).unwrap();
        socket
            .send(Message::text(r#"{"fin":{"reason":"unauthorized"}}"#))
            .unwrap();
        attaches
            .send(Attach {
                uri,
                upgrade_authorization,
                first_message,
            })
            .unwrap();
        let _ = socket.close(None);
        // A refused credential must not be retried.
        listener.set_nonblocking(true).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        assert!(listener.accept().is_err(), "the CLI retried a refusal");
    });
    (port, received, host)
}

#[test]
fn ask_sends_credentials_in_band_and_stops_on_refusal() {
    let (port, attaches, host) = refusing_host();
    let dir = std::env::temp_dir().join(format!("tress-ws-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let headers = dir.join("headers.json");
    std::fs::write(&headers, r#"{"Authorization":"Bearer fixture-only"}"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&headers, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let output = Command::new(binary())
        .args(["ask", "--host"])
        .arg(format!("http://127.0.0.1:{port}/api/threads/main"))
        .arg("--headers-file")
        .arg(&headers)
        .arg("hello")
        .env("XDG_CONFIG_HOME", dir.join("config"))
        .env_remove("TRESS_HOST")
        .env_remove("TRESS_SESSION")
        .output()
        .unwrap();
    std::fs::remove_dir_all(&dir).unwrap();

    let attach = attaches.recv_timeout(Duration::from_secs(5)).unwrap();
    let (path, query) = attach.uri.split_once('?').unwrap();
    assert_eq!(path, "/api/threads/main/ws");
    let client = query.strip_prefix("client=").unwrap();
    assert_eq!(client.len(), 32, "only the client id is in the URL");
    assert_eq!(
        attach.upgrade_authorization.as_deref(),
        Some("Bearer fixture-only")
    );
    let headers = &attach.first_message["headers"];
    assert_eq!(headers["authorization"], "Bearer fixture-only");
    assert!(headers["Statewire-Protocol"].is_string());

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("detached"), "stderr: {stderr}");
    assert!(!stderr.contains("fixture-only"), "stderr: {stderr}");
    host.join().unwrap();
}
