//! A self-contained, single-project host. All clients control the same engine.
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use tress::{
    engine::{Approval, Engine, Event},
    provider::Anthropic,
    tools::{NativeTools, ToolOutcome, Tools},
};

use crate::config;
mod files;
mod wire;

const HELP: &str = "Self-host one project and one shared conversation.\n\n\
Usage: tress serve [options]\n\n\
  --root <path>         project directory (default: current directory)\n\
  --listen <ip:port>    bind address (default: 127.0.0.1:5311; port 0 is automatic)\n\
  --state-dir <path>    private session storage outside the project\n\
  --allow-write         enable file creation and editing\n\
  --allow-exec          enable native shell with browser approval per command\n\
  --open                open the browser on this machine\n\
  --model <id>          model override\n\
  --base-url <url>      Anthropic-compatible endpoint\n\
  --max-steps <n>       model requests per turn\n\n\
Uses local model credentials (environment or tress setup --local).\n\
Files and artifacts stay on this machine; conversation state is saved separately.\n\
No managed service or database required. Keep the printed session link private.\n\
Closing a client leaves work running. Interrupted turns are not replayed.\n";

#[derive(Default)]
struct Options {
    root: Option<PathBuf>,
    listen: Option<SocketAddr>,
    state_dir: Option<PathBuf>,
    write: bool,
    open: bool,
    exec: bool,
    flags: config::UserConfig,
}
impl Options {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut result = Self::default();
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--allow-write" => result.write = true,
                "--open" => result.open = true,
                "--allow-exec" => result.exec = true,
                "--root" | "--listen" | "--state-dir" | "--model" | "--base-url"
                | "--max-steps" => {
                    let value = args.next().ok_or_else(|| format!("{arg} needs a value"))?;
                    match arg.as_str() {
                        "--root" => result.root = Some(value.into()),
                        "--listen" => {
                            result.listen = Some(value.parse().map_err(|_| {
                                "--listen needs an IP:port, for example 127.0.0.1:5311"
                            })?)
                        }
                        "--state-dir" => result.state_dir = Some(value.into()),
                        "--model" => result.flags.model = Some(value.clone()),
                        "--base-url" => result.flags.base_url = Some(value.clone()),
                        "--max-steps" => {
                            result.flags.max_steps = Some(
                                value
                                    .parse()
                                    .map_err(|_| "--max-steps needs a positive integer")?,
                            )
                        }
                        _ => unreachable!(),
                    }
                }
                _ => return Err(format!("Unknown option {arg}. See tress serve --help.")),
            }
        }
        Ok(result)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Checkpoint {
    token: String,
    root: PathBuf,
    entries: Vec<Value>,
    messages: Vec<Value>,
    runs: u64,
    #[serde(default)]
    interrupted: bool,
}

struct Store {
    dir: PathBuf,
    _lock: File,
}
impl Store {
    fn open(dir: PathBuf, root: &Path) -> Result<(Self, Checkpoint), String> {
        fs::create_dir_all(&dir).map_err(|e| format!("Cannot create state directory: {e}"))?;
        let dir = dir.canonicalize().map_err(|e| e.to_string())?;
        if dir.starts_with(root) {
            return Err("--state-dir must be outside the workspace; it holds private session access and history".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let lock = private_file(&dir.join("host.lock"), false)?;
        lock.try_lock_exclusive()
            .map_err(|_| "This state directory is already in use by another host")?;
        let store = Self { dir, _lock: lock };
        let path = store.dir.join("session.json");
        let mut checkpoint: Checkpoint = match read_checkpoint(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                "Invalid session checkpoint; preserve it and use another --state-dir"
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Checkpoint {
                token: id(),
                root: root.to_owned(),
                entries: vec![],
                messages: vec![],
                runs: 0,
                interrupted: false,
            },
            Err(e) => return Err(format!("Cannot read session checkpoint: {e}")),
        };
        if checkpoint.root != root {
            return Err("This state directory belongs to another workspace".into());
        }
        crate::host::validate_session(&checkpoint.token)?;
        if checkpoint.interrupted {
            checkpoint.entries.push(json!({"id":id(),"role":"agent","text":"The host stopped during a run. Files may have changed. Inspect them before continuing; interrupted tools are not replayed.","tools":[],"error":true}));
            checkpoint.interrupted = false;
        }
        store.save(&checkpoint)?;
        Ok((store, checkpoint))
    }
    fn save(&self, checkpoint: &Checkpoint) -> Result<(), String> {
        let path = self.dir.join("session.tmp");
        let mut file = private_file(&path, true)?;
        serde_json::to_writer(&mut file, checkpoint).map_err(|e| e.to_string())?;
        file.flush()
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(path, self.dir.join("session.json")).map_err(|e| e.to_string())?;
        File::open(&self.dir)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())
    }
}
fn private_file(path: &Path, truncate: bool) -> Result<File, String> {
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = opts
        .open(path)
        .map_err(|e| format!("Private state file: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Private state must use regular files".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    if truncate {
        file.set_len(0).map_err(|e| e.to_string())?;
    }
    Ok(file)
}
fn read_checkpoint(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = opts.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other("Checkpoint must be a regular file"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}
fn id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

type Shared = Arc<Host>;
struct Host {
    token: String,
    origin: String,
    model: String,
    state: watch::Sender<Value>,
    gate: Mutex<Gate>,
    jobs: mpsc::Sender<Job>,
    leases: Mutex<HashMap<String, wire::Lease>>,
    files: Arc<cap_std::fs::Dir>,
    shutdown: watch::Sender<bool>,
    store: Store,
    checkpoint: Mutex<Checkpoint>,
}
#[derive(Default)]
struct Gate {
    busy: bool,
    storage_failed: bool,
    approval: Option<(String, mpsc::SyncSender<bool>)>,
}
enum Job {
    Send(String),
    Reset,
}

impl Host {
    fn change(&self, edit: impl FnOnce(&mut Value)) {
        self.state.send_modify(edit);
    }
    fn command(&self, method: &str, params: &[Value]) -> Result<(), String> {
        let mut gate = self.gate.lock().unwrap();
        if method == "approve" {
            if params.len() != 2 {
                return Err("Expected approval ID and boolean".into());
            }
            let request = params[0].as_str().ok_or("Expected approval ID")?;
            let allow = params[1].as_bool().ok_or("Expected approval decision")?;
            if gate.approval.as_ref().map(|p| p.0.as_str()) != Some(request) {
                return Err("Approval is no longer pending".into());
            }
            let (_, tx) = gate.approval.take().unwrap();
            tx.send(allow).map_err(|_| "Approval expired")?;
            return Ok(());
        }
        if gate.storage_failed {
            return Err(
                "Checkpoint storage failed. Repair storage and restart the host before continuing."
                    .into(),
            );
        }
        if gate.busy {
            return Err("The host is busy. Wait for the current run.".into());
        }
        let job = match method {
            "send" if params.len() == 1 => {
                let prompt = params[0].as_str().ok_or("Expected prompt text")?;
                if prompt.trim().is_empty() || prompt.len() > 64 * 1024 {
                    return Err("Prompt must contain 1–65536 bytes".into());
                }
                Job::Send(prompt.to_owned())
            }
            "reset" if params.is_empty() => Job::Reset,
            _ => return Err("Unknown command or invalid arguments".into()),
        };
        // Acknowledgement means the prompt/reset is on disk before any model
        // or tool runs. Only the worker writes the completion checkpoint.
        let mut checkpoint = self.checkpoint.lock().unwrap();
        let mut next = checkpoint.clone();
        match &job {
            Job::Send(prompt) => {
                next.entries.extend([
                    json!({"id":id(),"role":"user","text":prompt,"tools":[]}),
                    json!({"id":id(),"role":"agent","text":"","tools":[]}),
                ]);
                next.interrupted = true;
            }
            Job::Reset => {
                next.entries.clear();
                next.messages.clear();
                next.runs = 0;
            }
        }
        if let Err(error) = self.store.save(&next) {
            gate.storage_failed = true;
            self.change(|state| state["storageError"] = json!("Could not save the conversation. Repair host storage and restart before continuing."));
            eprintln!("Checkpoint failed: {error}");
            return Err("Could not save this request. No work was started.".into());
        }
        *checkpoint = next;
        gate.busy = true;
        self.change(|state| {
            state["status"] = json!("running");
            state["attention"] = Value::Null;
            state["entries"] = json!(checkpoint.entries);
            state["runs"] = json!(checkpoint.runs);
        });
        if self.jobs.send(job).is_err() {
            gate.busy = false;
            gate.storage_failed = true;
            self.change(|state| {
                state["status"] = json!("idle");
                state["storageError"] = json!("Agent worker stopped. Restart the host.");
            });
            return Err("Agent worker stopped. Restart the host.".into());
        }
        Ok(())
    }
}

struct HostTools {
    native: NativeTools,
    write: bool,
    exec: bool,
}
impl Tools for HostTools {
    fn schemas(&self) -> Vec<Value> {
        self.native
            .schemas()
            .into_iter()
            .filter(|schema| match schema["name"].as_str() {
                Some("bash") => self.exec,
                Some("write" | "edit") => self.write,
                Some("read" | "ls") => true,
                _ => false,
            })
            .collect()
    }
    fn needs_approval(&self, name: &str, input: &Value) -> bool {
        self.exec && self.native.needs_approval(name, input)
    }
    fn execute(&mut self, name: &str, input: &Value) -> ToolOutcome {
        if (name == "bash" && !self.exec) || (matches!(name, "write" | "edit") && !self.write) {
            return ToolOutcome::error("This tool is disabled on the host.");
        }
        self.native.execute(name, input)
    }
}

fn agent_worker(
    host: Shared,
    jobs: mpsc::Receiver<Job>,
    settings: config::Resolved,
    write: bool,
    exec: bool,
) {
    let initial = host.checkpoint.lock().unwrap().clone();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("worker runtime");
    let mut engine = Engine::new(
        Anthropic::new(settings.key().unwrap().to_owned(), settings.model.value)
            .with_base_url(settings.base_url.value),
        HostTools {
            native: NativeTools::new(initial.root.clone()),
            write,
            exec,
        },
    )
    .with_max_steps(settings.max_steps.value);
    engine.restore_messages(initial.messages);
    for job in jobs {
        match job {
            Job::Reset => {
                engine.restore_messages(vec![]);
            }
            Job::Send(prompt) => {
                let mut event = |event| {
                    host.change(|state| {
                        let reply = state["entries"].as_array_mut().unwrap().last_mut().unwrap();
                        match event {
                            Event::Text(text) => {
                                let current = reply["text"].as_str().unwrap().to_owned();
                                reply["text"] = json!(current + &text);
                            }
                            Event::ToolStarted { summary, .. } => {
                                reply["tools"].as_array_mut().unwrap().push(json!(summary))
                            }
                            Event::ToolDenied { name } => reply["tools"]
                                .as_array_mut()
                                .unwrap()
                                .push(json!(format!("{name}: denied"))),
                            Event::ToolFinished {
                                name,
                                is_error: true,
                            } => reply["tools"]
                                .as_array_mut()
                                .unwrap()
                                .push(json!(format!("{name}: failed"))),
                            _ => {}
                        }
                    })
                };
                let mut approve = |_name: &str, summary: &str| {
                    let request = id();
                    let (tx, rx) = mpsc::sync_channel(1);
                    host.gate.lock().unwrap().approval = Some((request.clone(), tx));
                    host.change(|state| {
                        state["approval"] = json!({"id":request,"summary":summary});
                        state["attention"] =
                            json!("Approve or deny the shell command in the browser.");
                    });
                    // The engine is on its own OS thread; HTTP and streaming stay responsive.
                    let allowed = rx.recv_timeout(Duration::from_secs(300)).unwrap_or(false);
                    host.gate.lock().unwrap().approval = None;
                    host.change(|state| {
                        state["approval"] = Value::Null;
                        state["attention"] = Value::Null;
                    });
                    if allowed {
                        Approval::Once
                    } else {
                        Approval::Deny
                    }
                };
                if let Err(error) = runtime.block_on(engine.send(&prompt, &mut event, &mut approve))
                {
                    host.change(|state| {
                            let reply = state["entries"].as_array_mut().unwrap().last_mut().unwrap();
                            reply["error"] = json!(true);
                            // Provider bodies may contain credentials; keep details on the operator side.
                            reply["text"] = json!(format!("{}\nThe agent run failed. Check the host terminal and model configuration.", reply["text"].as_str().unwrap()));
                        });
                    host.change(|state| state["attention"] = json!("The agent run failed. Check the host terminal and model configuration."));
                    eprintln!("Agent run failed: {error}");
                }
            }
        }
        let (runs, failure) = {
            let mut checkpoint = host.checkpoint.lock().unwrap();
            checkpoint.messages = engine.messages().to_vec();
            checkpoint.entries = host.state.borrow()["entries"].as_array().unwrap().clone();
            if checkpoint.interrupted {
                checkpoint.runs += 1;
            }
            checkpoint.interrupted = false;
            (checkpoint.runs, host.store.save(&checkpoint).err())
        };
        let mut gate = host.gate.lock().unwrap();
        gate.busy = false;
        gate.storage_failed = failure.is_some();
        host.change(|state| {
            state["status"] = json!("idle"); state["runs"] = json!(runs);
            if failure.is_some() { state["storageError"] = json!("Could not save the conversation. Repair host storage and restart before continuing."); state["attention"] = state["storageError"].clone(); }
        });
        if let Some(error) = failure {
            eprintln!("Checkpoint failed: {error}");
        }
    }
}

pub async fn run(args: &[String]) -> Result<(), String> {
    if args == ["--help"] || args == ["-h"] {
        print!("{HELP}");
        return Ok(());
    }
    let options = Options::parse(args)?;
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let root = options
        .root
        .clone()
        .unwrap_or(cwd)
        .canonicalize()
        .map_err(|e| format!("Workspace: {e}"))?;
    if !root.is_dir() {
        return Err("Workspace must be a directory".into());
    }
    let paths = config::Paths::discover(&root)?;
    let settings = config::Resolved::load(&paths, &options.flags)?;
    settings.key()?;
    let dir = options
        .state_dir
        .or_else(|| {
            std::env::var_os("XDG_STATE_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
                })
                .map(|base| {
                    base.join("tress/hosts").join(format!(
                        "{:x}",
                        Sha256::digest(root.to_string_lossy().as_bytes())
                    ))
                })
        })
        .ok_or("Set HOME or pass --state-dir")?;
    let (store, checkpoint) = Store::open(dir, &root)?;
    let address = options
        .listen
        .unwrap_or_else(|| "127.0.0.1:5311".parse().unwrap());
    if !address.ip().is_loopback() {
        return Err(
            "This single-owner host listens on loopback. Use SSH port forwarding to access a VM."
                .into(),
        );
    }
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|e| format!("Cannot listen: {e}"))?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let origin = format!("http://{address}");
    let files = Arc::new(
        cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority())
            .map_err(|e| e.to_string())?,
    );
    let (shutdown, _) = watch::channel(false);
    let (state, _) = watch::channel(json!({
        "entries": checkpoint.entries, "status":"idle", "runs":checkpoint.runs,
        "files":{}, "clients":[], "approval":null,
        "workspace":{"mode":"local","root":root,"writable":options.write,"shell":options.exec},
    }));
    let (tx, rx) = mpsc::channel();
    let host = Arc::new(Host {
        token: checkpoint.token.clone(),
        origin: origin.clone(),
        model: settings.model.value.clone(),
        state,
        gate: Mutex::new(Gate::default()),
        jobs: tx,
        leases: Mutex::new(HashMap::new()),
        files,
        shutdown,
        store,
        checkpoint: Mutex::new(checkpoint),
    });
    let worker_host = host.clone();
    std::thread::spawn(move || {
        agent_worker(worker_host, rx, settings, options.write, options.exec)
    });
    let app = Router::new()
        .route(
            "/",
            get(|| async { Html(include_str!("serve/index.html")) }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("serve/app.js"),
                )
            }),
        )
        .route(
            "/app.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("serve/app.css"),
                )
            }),
        )
        .route("/api/files", get(files::browse))
        .route("/api/file", get(files::download))
        .route("/api/mode", get(mode))
        .route("/api/health", get(health))
        .route("/api/sessions/{token}/stream", get(wire::stream))
        .route(
            "/api/sessions/{token}/frames",
            axum::routing::post(wire::frames),
        )
        .layer(DefaultBodyLimit::max(128 * 1024))
        .layer(middleware::from_fn_with_state(host.clone(), guard))
        .with_state(host.clone());
    let url = format!("{origin}/?session={}", host.token);
    println!("tress self-hosted · {}\nWorkspace: {}\nAccess: {}\nBrowser: {url}\nTerminal: tress attach {origin} -s {} --chat-only\nKeep this link private; it grants control of this project.\nStop the host with Ctrl-C. Completed turns are saved.", host.model, root.display(), if options.write { "file edits enabled" } else { "read-only file tools" }, host.token);
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    println!(
        "Native shell: {}",
        if options.exec {
            "enabled; approve each command in the browser"
        } else {
            "disabled"
        }
    );
    if options.open {
        open_browser(&url);
    }
    let stopping = host.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            stopping.shutdown.send_replace(true);
            if let Some((_, decision)) = stopping.gate.lock().unwrap().approval.take() {
                let _ = decision.send(false);
            }
        })
        .await
        .map_err(|e| e.to_string())
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let command = "open";
    #[cfg(target_os = "linux")]
    let command = "xdg-open";
    #[cfg(target_os = "windows")]
    let command = "explorer";
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    if let Err(error) = std::process::Command::new(command).arg(url).spawn() {
        eprintln!("Could not open browser: {error}. Open the printed URL manually.");
    }
}

#[derive(Deserialize)]
struct SessionQuery {
    session: Option<String>,
}
async fn mode(State(host): State<Shared>, Query(query): Query<SessionQuery>) -> Response {
    if query.session.as_deref() != Some(&host.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({"kind":"local","configured":true,"model":host.model,"selfHosted":true,"session":{"attachId":host.token},"host":host.origin})).into_response()
}
async fn health(State(host): State<Shared>, Query(query): Query<SessionQuery>) -> Response {
    if query.session.as_deref() != Some(&host.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let failed = host.gate.lock().unwrap().storage_failed;
    Json(json!({"ok":!failed,"checks":[{"name":"host","status":if failed {"error"} else {"ok"},"message":if failed {"Checkpoint storage failed"} else {"Self-hosted worker configured; model API not probed"}}]})).into_response()
}

async fn guard(
    State(host): State<Shared>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let authority = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok());
    if authority != host.origin.strip_prefix("http://") {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        if origin.to_str().ok() != Some(host.origin.as_str()) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'".parse().unwrap());
    response
}
