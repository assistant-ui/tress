//! Exercise onboarding through the real CLI in isolated homes, using only fake
//! credentials and local HTTP fixtures. No external API calls or paid turns.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "tress-setup-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(path.join("workspace")).unwrap();
        Self(path)
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tress"));
        command
            .current_dir(self.0.join("workspace"))
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("ANTHROPIC_BASE_URL")
            .env_remove("TRESS_MODEL")
            .env_remove("TRESS_MAX_STEPS");
        command
    }
    fn run(&self, args: &[&str]) -> Output {
        self.command().args(args).output().unwrap()
    }
    fn setup(&self, extra: &[&str], key: &[u8]) -> Output {
        let mut child = self
            .command()
            .args(["setup", "--key-stdin"])
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(key).unwrap();
        child.wait_with_output().unwrap()
    }
    fn user(&self, value: Value) {
        fs::create_dir_all(self.0.join("config/tress")).unwrap();
        fs::write(self.0.join("config/tress/config.json"), value.to_string()).unwrap();
    }
    fn project(&self, value: Value) {
        fs::write(self.0.join("workspace/.tress.json"), value.to_string()).unwrap();
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn success(output: &Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn settings(output: Output) -> Value {
    success(&output);
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn config_precedence_and_sources_are_visible_without_a_key() {
    let home = Home::new();
    let defaults = settings(home.run(&["config", "--json"]));
    assert_eq!(
        defaults["model"],
        json!({"value":"claude-sonnet-5", "source":"default"})
    );
    assert_eq!(defaults["max_steps"]["value"], 64);
    assert_eq!(defaults["credential"]["configured"], false);
    assert!(
        !home.0.join("config").exists(),
        "read-only commands must not create config"
    );
    home.user(
        json!({"model":"personal-model", "max_steps":8, "base_url":"http://localhost:9876/proxy/"}),
    );
    let user = settings(home.run(&["config", "--json"]));
    assert_eq!(user["model"]["source"], "user");
    assert_eq!(user["max_steps"]["value"], 8);
    home.project(json!({"model":"project-model", "max_steps":4}));
    let project = settings(home.run(&["config", "--json"]));
    assert_eq!(
        project["model"],
        json!({"value":"project-model", "source":"project"})
    );
    assert_eq!(project["max_steps"]["value"], 4);
    let env = settings(
        home.command()
            .args(["config", "--json"])
            .env("TRESS_MODEL", "env-model")
            .env("TRESS_MAX_STEPS", "2")
            .output()
            .unwrap(),
    );
    assert_eq!(
        env["model"],
        json!({"value":"env-model", "source":"environment"})
    );
    assert_eq!(env["max_steps"]["value"], 2);
    let flags = settings(
        home.command()
            .args([
                "config",
                "--json",
                "--model",
                "flag-model",
                "--max-steps",
                "1",
            ])
            .env("TRESS_MODEL", "env-model")
            .env("TRESS_MAX_STEPS", "2")
            .output()
            .unwrap(),
    );
    assert_eq!(
        flags["model"],
        json!({"value":"flag-model", "source":"flag"})
    );
    assert_eq!(flags["max_steps"]["value"], 1);
    assert_eq!(flags["base_url"]["value"], "http://localhost:9876/proxy");
}

#[test]
fn setup_saves_private_files_and_diagnostics_never_print_keys() {
    let home = Home::new();
    let output = home.setup(
        &["--model", "saved-model", "--max-steps", "6"],
        b"fake-secret-123\n",
    );
    success(&output);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("fake-secret-123"));
    let personal = fs::read_to_string(home.0.join("config/tress/config.json")).unwrap();
    assert!(!personal.contains("fake-secret"));
    assert_eq!(
        serde_json::from_str::<Value>(&personal).unwrap()["max_steps"],
        6
    );
    let credentials = home.0.join("config/tress/credentials.json");
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&credentials).unwrap()).unwrap()
            ["anthropic_api_key"],
        "fake-secret-123"
    );
    assert!(!home.0.join("workspace/.tress.json").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&credentials).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(home.0.join("config/tress"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    for args in [vec!["config"], vec!["config", "--json"], vec!["doctor"]] {
        let output = home.run(&args);
        success(&output);
        assert!(!String::from_utf8_lossy(&output.stdout).contains("fake-secret"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("fake-secret"));
    }
    let from_env = settings(
        home.command()
            .args(["config", "--json"])
            .env("ANTHROPIC_API_KEY", "env-secret")
            .output()
            .unwrap(),
    );
    assert_eq!(from_env["credential"]["source"], "environment");
    let empty_env = home
        .command()
        .args(["config"])
        .env("ANTHROPIC_API_KEY", "")
        .output()
        .unwrap();
    assert!(
        !empty_env.status.success(),
        "explicit invalid env must not fall back silently"
    );
    success(&home.setup(&[], b"replacement-secret\n"));
    assert!(!fs::read_to_string(credentials)
        .unwrap()
        .contains("fake-secret-123"));
    assert_eq!(
        fs::read_dir(home.0.join("config/tress")).unwrap().count(),
        2,
        "temporary files cleaned up"
    );
    let current = settings(home.run(&["config", "--json"]));
    assert_eq!(
        current["model"]["value"], "saved-model",
        "setup preserves existing preferences"
    );
}

#[test]
fn invalid_inputs_leave_existing_credentials_unchanged() {
    let home = Home::new();
    success(&home.setup(&[], b"keep-this-key\n"));
    let path = home.0.join("config/tress/credentials.json");
    let before = fs::read(&path).unwrap();
    for (args, key) in [
        (vec![], b"invalid key".as_slice()),
        (vec!["--max-steps", "0"], b"replacement".as_slice()),
        (vec!["--model", ""], b"replacement".as_slice()),
    ] {
        let output = home.setup(&args, key);
        assert!(!output.status.success());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    let output = home.run(&["setup"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("needs a terminal"));
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn project_config_cannot_redirect_keys_or_disable_approvals() {
    let home = Home::new();
    for value in [
        json!({"base_url":"https://untrusted.example"}),
        json!({"anthropic_api_key":"must-not-echo"}),
        json!({"always_allow":true}),
        json!({"must-not-echo":true}),
    ] {
        home.project(value);
        let output = home
            .command()
            .arg("config")
            .env("ANTHROPIC_API_KEY", "private-test-key")
            .output()
            .unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains("Allowed keys: model, max_steps."));
        assert!(!error.contains("must-not-echo"));
        assert!(!error.contains("private-test-key"));
    }
    for command in ["setup", "config", "doctor"] {
        success(&home.run(&[command, "--help"]));
    }
    // An invalid project file must not prevent repairing personal setup.
    success(&home.setup(&[], b"new-key\n"));
}

#[test]
fn invalid_settings_and_unknown_cli_flags_fail_before_network_access() {
    let home = Home::new();
    for args in [
        vec!["--unknown"],
        vec!["ask", "--model"],
        vec!["ask", "--max-steps", "0", "hello"],
        vec!["ask"],
        vec!["doctor", "--json"],
        vec!["config", "--base-url", "https://user:secret@host.test"],
    ] {
        let output = home.run(&args);
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("user:secret"));
    }
    for config in [
        json!({"max_steps":0}),
        json!({"max_steps":1025}),
        json!({"max_steps":"six"}),
        json!({"model":"bad model"}),
        json!({"model":""}),
        json!({"base_url":"file:///tmp/api"}),
        json!({"base_url":"https://host.test?key=secret"}),
    ] {
        home.user(config);
        assert!(!home.run(&["config"]).status.success());
    }
}

#[cfg(unix)]
#[test]
fn insecure_or_symlinked_credentials_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let home = Home::new();
    success(&home.setup(&[], b"private-secret\n"));
    let path = home.0.join("config/tress/credentials.json");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let output = home.run(&["doctor"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("chmod 600"));
    let target = home.0.join("target.json");
    fs::rename(&path, &target).unwrap();
    symlink(&target, &path).unwrap();
    assert!(!home.run(&["doctor"]).status.success());
    success(&home.setup(&[], b"replacement\n"));
    assert!(fs::symlink_metadata(&path).unwrap().is_file());
    assert!(
        fs::read_to_string(target)
            .unwrap()
            .contains("private-secret"),
        "setup must replace the link, never overwrite its target"
    );
}

#[test]
fn doctor_offline_does_not_contact_the_api_and_missing_key_is_actionable() {
    let home = Home::new();
    let missing = home.run(&["doctor"]);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("tress setup"));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let output = home
        .command()
        .arg("doctor")
        .env("ANTHROPIC_API_KEY", "test-key")
        .env(
            "ANTHROPIC_BASE_URL",
            format!("http://{}", listener.local_addr().unwrap()),
        )
        .output()
        .unwrap();
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("API access not checked"));
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn doctor_checks_the_models_api_without_generation_or_secret_disclosure() {
    for status in [200, 401, 403, 404, 429, 500, 302] {
        let home = Home::new();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(error) => panic!("No doctor request: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            let body = if status == 200 {
                "{\"id\":\"test-model\",\"type\":\"model\"}"
            } else {
                "test-secret-must-not-leak"
            };
            write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nLocation: http://{address}/redirected\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            request
        });
        let output = home
            .command()
            .args(["doctor", "--check-api", "--model", "test-model"])
            .env("ANTHROPIC_API_KEY", "test-secret-must-not-leak")
            .env("ANTHROPIC_BASE_URL", format!("http://{address}/proxy"))
            .output()
            .unwrap();
        assert_eq!(output.status.success(), status == 200);
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!combined.contains("test-secret-must-not-leak"));
        if status != 200 {
            assert!(combined.contains(&status.to_string()), "{combined}");
        }
        if status == 302 {
            assert!(combined.contains("redirected"));
        }
        let request = server.join().unwrap().to_lowercase();
        assert!(request.starts_with("get /proxy/v1/models/test-model http/1.1"));
        assert!(request.contains("x-api-key: test-secret-must-not-leak"));
        assert!(request.contains("anthropic-version: 2023-06-01"));
        assert!(!request.contains("/messages"));
    }
}

#[test]
fn home_fallback_and_environment_only_use_work() {
    let home = Home::new();
    let fallback = settings(
        home.command()
            .args(["config", "--json"])
            .env_remove("XDG_CONFIG_HOME")
            .output()
            .unwrap(),
    );
    assert_eq!(
        fallback["user_config"],
        home.0
            .join(".config/tress/config.json")
            .to_string_lossy()
            .as_ref()
    );
    let env_only = settings(
        home.command()
            .args(["config", "--json"])
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("HOME")
            .env("ANTHROPIC_API_KEY", "test-key")
            .output()
            .unwrap(),
    );
    assert!(env_only["user_config"].is_null());
    assert_eq!(env_only["credential"]["source"], "environment");
}
