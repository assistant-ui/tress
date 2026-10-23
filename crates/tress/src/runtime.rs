//! Launch the SDK host; the terminal remains a Harness protocol client.
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{attach, config, Style};

include!(concat!(env!("OUT_DIR"), "/runtime_assets.rs"));

pub const HELP: &str = "usage: tress serve [--root <path>] [--managed] [--allow-write] [--allow-exec] [--open] [--stop]\n\nRuns a persistent Harness SDK host on this machine. Node 22+ is required.\nRelease builds embed the runtime; source builds need packages/harness-host.\nCredentials stay on the host. --allow-exec permits native commands with your\npermissions. Stop and restart the host to change its settings or permissions.\n";

fn runtime_path(state: &Path) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("TRESS_HOST_RUNTIME") {
        return Ok(path.into());
    }
    if RUNTIME_ASSETS.is_empty() {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/harness-host/dist/host.mjs"));
    }
    let mut digest = Sha256::new();
    for (name, content) in RUNTIME_ASSETS {
        digest.update(name);
        digest.update(content);
    }
    let cache = state
        .join("runtime")
        .join(format!("{:x}", digest.finalize()));
    for (name, content) in RUNTIME_ASSETS {
        let target = cache.join(name);
        if fs::read(&target).ok().as_deref() == Some(*content) {
            continue;
        }
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        let temporary = target.with_extension(format!("{}.tmp", std::process::id()));
        fs::write(&temporary, content).map_err(|e| e.to_string())?;
        fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
    }
    Ok(cache.join("host.mjs"))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

struct Connection {
    origin: String,
    endpoint: String,
    browser_url: String,
    headers: PathBuf,
}

fn directory(root: &Path, managed: bool) -> Result<PathBuf, String> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/state")))
        .ok_or("Set HOME or XDG_STATE_HOME for durable local threads.")?;
    if !base.is_absolute() {
        return Err("State directory must be absolute.".into());
    }
    let identity = serde_json::json!([
        root,
        managed,
        if managed {
            std::env::var("HARNESS_ORIGIN").ok()
        } else {
            None
        },
        if managed {
            std::env::var("HARNESS_WORKSPACE").ok()
        } else {
            None
        },
        if managed {
            std::env::var("HARNESS_THREAD_ID").ok()
        } else {
            None
        }
    ]);
    let hash = format!("{:x}", Sha256::digest(identity.to_string().as_bytes()));
    Ok(base.join("tress/harness").join(&hash[..24]))
}

async fn existing(dir: &Path) -> Option<Connection> {
    let saved: Value = serde_json::from_slice(&fs::read(dir.join("host.json")).ok()?).ok()?;
    let origin = saved["origin"].as_str()?;
    let url = reqwest::Url::parse(origin).ok()?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.path() != "/" {
        return None;
    }
    let response = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?
        .get(format!("{origin}/api/info"))
        .bearer_auth(saved["token"].as_str()?)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let info: Value = response.json().await.ok()?;
    if info["root"] != saved["binding"]["root"] {
        return None;
    }
    Some(Connection {
        origin: origin.into(),
        endpoint: format!("{origin}/api/threads/main"),
        browser_url: format!("{origin}/#{}", saved["token"].as_str()?),
        headers: dir.join("headers.json"),
    })
}

async fn start(
    root: &Path,
    settings: &config::Resolved,
    managed: bool,
    write: bool,
    exec: bool,
) -> Result<Connection, String> {
    let dir = directory(root, managed)?;
    if let Some(connection) = existing(&dir).await {
        return Ok(connection);
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let runtime = runtime_path(&dir)?;
    if !runtime.is_file() {
        return Err("Build the Harness host runtime first: see docs/local-harness.md. Set TRESS_HOST_RUNTIME to its dist/host.mjs. No conversation was started. Use --ephemeral only for an unsaved standalone run.".into());
    }
    let mut log_options = OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        log_options.mode(0o600);
    }
    let log = log_options
        .open(dir.join("host.log"))
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(std::env::var_os("TRESS_NODE").unwrap_or_else(|| "node".into()));
    command
        .arg(runtime)
        .arg("--root")
        .arg(root)
        .arg("--state-dir")
        .arg(&dir)
        .env("ANTHROPIC_API_KEY", settings.key()?)
        .env("TRESS_MODEL", &settings.model.value)
        .env("TRESS_MAX_STEPS", settings.max_steps.value.to_string())
        .env("ANTHROPIC_BASE_URL", &settings.base_url.value)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    if managed {
        command.arg("--managed");
    }
    if write {
        command.arg("--allow-write");
    }
    if exec {
        command.arg("--allow-exec");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot launch the Harness host with Node 22+: {e}"))?;
    for _ in 0..200 {
        if let Some(connection) = existing(&dir).await {
            return Ok(connection);
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "Harness host exited ({status}). See {}",
                dir.join("host.log").display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    Err(format!(
        "Harness host did not start. See {}",
        dir.join("host.log").display()
    ))
}

pub async fn local(
    root: &Path,
    settings: &config::Resolved,
    prompt: Option<&str>,
    style: &Style,
) -> Result<(), String> {
    let managed = match std::env::var("TRESS_THREAD_MODE").as_deref() {
        Ok("cloud") => true,
        Ok("local") | Err(_) => false,
        Ok(_) => return Err("TRESS_THREAD_MODE must be local or cloud.".into()),
    };
    let connection = start(
        &root.canonicalize().map_err(|e| e.to_string())?,
        settings,
        managed,
        true,
        false,
    )
    .await?;
    eprintln!("Harness workspace: {}\nBrowser: {}\nThe host stays running after you leave. Stop it with tress serve --stop{}.", root.display(), connection.browser_url, if managed { " --managed" } else { "" });
    let headers = connection
        .headers
        .to_str()
        .ok_or("Credential path must be UTF-8")?;
    let result = match prompt {
        Some(prompt) => attach::ask(&connection.endpoint, style, None, prompt, Some(headers)).await,
        None => {
            attach::run(
                &connection.endpoint,
                style,
                false,
                None,
                Some(headers),
                None,
            )
            .await
        }
    };
    let credentials: Value =
        serde_json::from_slice(&fs::read(&connection.headers).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    http_client()?
        .post(format!("{}/api/flush", connection.origin))
        .header(
            "Authorization",
            credentials["Authorization"]
                .as_str()
                .ok_or("Invalid host credential")?,
        )
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("Could not persist the final thread state: {e}"))?;
    result
}

pub async fn serve(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let mut root = std::env::current_dir().map_err(|e| e.to_string())?;
    let (mut managed, mut write, mut exec, mut open, mut stop) =
        (false, false, false, false, false);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => root = args.next().ok_or("--root needs a path")?.into(),
            "--managed" => managed = true,
            "--allow-write" => write = true,
            "--allow-exec" => exec = true,
            "--open" => open = true,
            "--stop" => stop = true,
            _ => return Err(format!("Unknown host option: {arg}. {HELP}")),
        }
    }
    root = root.canonicalize().map_err(|e| e.to_string())?;
    if stop {
        let connection = existing(&directory(&root, managed)?)
            .await
            .ok_or("No running Harness host for this workspace.")?;
        let headers: Value =
            serde_json::from_slice(&fs::read(connection.headers).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        http_client()?
            .post(format!("{}/api/stop", connection.origin))
            .header(
                "Authorization",
                headers["Authorization"]
                    .as_str()
                    .ok_or("Invalid host credential")?,
            )
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        println!("Harness host stopping; saved thread and files remain.");
        return Ok(());
    }
    let settings = config::Resolved::load(
        &config::Paths::discover(&root)?,
        &config::UserConfig::default(),
    )?;
    let connection = start(&root, &settings, managed, write, exec).await?;
    println!("Browser: {}\nTerminal: tress attach {} --headers-file {}\nHost stays running. Stop with: tress serve --root {} --stop{}", connection.browser_url, connection.endpoint, shell_quote(&connection.headers.to_string_lossy()), shell_quote(&root.to_string_lossy()), if managed { " --managed" } else { "" });
    if open {
        #[cfg(target_os = "macos")]
        {
            let _ = Command::new("open").arg(connection.browser_url).spawn();
        }
        #[cfg(target_os = "linux")]
        {
            let _ = Command::new("xdg-open").arg(connection.browser_url).spawn();
        }
    }
    Ok(())
}
