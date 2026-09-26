//! Small, native-only setup and diagnostics; no background service or login daemon.

use std::io::{IsTerminal, Read, Write};
use std::path::Path;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};

use crate::config::{self, Mode, Paths, Resolved, UserConfig};
use crate::host;

pub fn help(command: &str) -> &'static str {
    match command {
        "setup" => "usage: tress setup [--host <url>] [-s <id>]\n       tress setup --local [--model <id>] [--max-steps <n>] [--base-url <url>] [--key-stdin]\n\nDefault: connect to a tress host using its model credentials. No personal API key needed.\nUse --local explicitly to configure standalone Anthropic execution.\n",
        "config" => "usage: tress config [--json] [--local]\n\nShow the saved host connection, or local settings when local mode is selected.\nCredentials and saved session IDs are never printed.\n",
        _ => "usage: tress doctor [--check-api] [--local]\n\nCheck the selected host connection or explicit local setup. --check-api also contacts\nthe host (or Anthropic Models API in local mode); it does not generate a response.\n",
    }
}

pub async fn run(command: &str, mut args: &[String], root: &Path) -> Result<(), String> {
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        print!("{}", help(command));
        return Ok(());
    }
    let mut flags = UserConfig::default();
    let mut special = false;
    let mut host_url = None;
    let mut session = None;
    while !args.is_empty() {
        args = config::parse_flags(args, &mut flags)?;
        let Some(arg) = args.first() else { break };
        match (command, arg.as_str()) {
            ("setup", "--key-stdin") | ("config", "--json") | ("doctor", "--check-api") => {
                special = true
            }
            ("setup", "--host") | ("setup", "-s" | "--session") => {
                let value = args.get(1).ok_or_else(|| format!("{arg} needs a value"))?;
                if arg == "--host" {
                    host_url = Some(host::validate_host(value)?);
                } else {
                    host::validate_session(value)?;
                    session = Some(value.clone());
                }
                args = &args[1..];
            }
            _ => {
                return Err(format!(
                    "Unexpected argument {arg}. See `tress {command} --help`."
                ))
            }
        }
        args = &args[1..];
    }
    let paths = Paths::discover(root)?;
    let explicit_local = flags.mode == Some(Mode::Local);
    if command == "setup" && !explicit_local {
        if special || flags.model.is_some() || flags.max_steps.is_some() || flags.base_url.is_some()
        {
            return Err("Model settings and --key-stdin require `tress setup --local`. Hosted setup uses the host's credentials.".into());
        }
        return setup_host(&paths, host_url, session).await;
    }
    if host_url.is_some() || session.is_some() {
        return Err("Choose hosted setup or --local, not both".into());
    }
    if command == "setup" {
        return setup(&paths, flags, special);
    }
    if !config::local_mode(&paths, explicit_local)? {
        if flags.model.is_some() || flags.max_steps.is_some() || flags.base_url.is_some() {
            return Err(
                "Model settings are managed by the host. Use --local for standalone settings."
                    .into(),
            );
        }
        return inspect_host(command, &paths, special).await;
    }
    let resolved = Resolved::load(&paths, &flags)?;
    if command == "config" {
        if special {
            println!(
                "{}",
                serde_json::to_string_pretty(&resolved.public_view(&paths, root)).unwrap()
            );
        } else {
            println!(
                "Model       {} ({})",
                resolved.model.value, resolved.model.source
            );
            println!(
                "Max steps   {} ({})",
                resolved.max_steps.value, resolved.max_steps.source
            );
            println!(
                "API         {} ({})",
                resolved.base_url.value, resolved.base_url.source
            );
            println!("Credential  {}", resolved.key_source);
            println!("Workspace   {}", root.display());
            if let Some(path) = paths.user_config() {
                println!("Personal    {}", path.display());
            }
            println!("Project     {} (optional)", paths.project.display());
        }
        return Ok(());
    }
    std::fs::read_dir(root).map_err(|error| format!("Cannot read workspace: {error}"))?;
    println!("ok  Configuration is valid");
    println!("ok  Workspace: {}", root.display());
    resolved.key()?;
    println!("ok  Anthropic key is configured ({})", resolved.key_source);
    println!("ok  Model: {}", resolved.model.value);
    println!("ok  API: {}", resolved.base_url.value);
    if special {
        check_api(&resolved).await?;
        println!("ok  Models API confirms access to this model");
    } else {
        println!("API access not checked. Run `tress doctor --check-api` to verify.");
    }
    Ok(())
}

async fn setup_host(
    paths: &Paths,
    host_url: Option<String>,
    session: Option<String>,
) -> Result<(), String> {
    if paths.directory.is_none() {
        return Err("Set HOME or XDG_CONFIG_HOME before running setup".into());
    }
    let interactive = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    if !interactive && host_url.is_none() && session.is_none() {
        return Err("Setup needs a terminal, or supply `tress setup --host <url> [-s <id>]`. No personal API key is required.".into());
    }
    let saved = host::configured_host(paths)?;
    let default_host = saved
        .as_ref()
        .map_or(host::DEFAULT_HOST, |saved| saved.host.as_str());
    let host = match host_url {
        Some(host) => host,
        None if interactive => {
            println!("tress setup\n\nConnect to a host. The host supplies the model and workspace; API keys stay there.\n");
            prompt(&format!("Host [{default_host}]: "))?.unwrap_or_else(|| default_host.to_owned())
        }
        None => default_host.to_owned(),
    };
    let host = host::validate_host(&host)?;
    let previous = saved
        .filter(|saved| saved.host == host)
        .and_then(|saved| saved.session);
    let session = match session {
        Some(session) => Some(session),
        None if interactive => {
            let label = if previous.is_some() {
                "Session ID [Enter to keep saved; 'new' for a fresh thread]: "
            } else {
                "Session ID [Enter for a fresh thread]: "
            };
            match prompt(label)? {
                Some(value) if value == "new" => None,
                Some(value) => Some(value),
                None => previous,
            }
        }
        None => previous,
    };
    let connection = host::discover(&host, session.as_deref()).await?;
    let mut user = paths.read_user()?;
    user.mode = Some(Mode::Host);
    connection.save(paths)?;
    config::save(paths, &user, None)?;
    println!("\nConnected to {}", connection.host);
    println!("Model and workspace are managed by the host. No personal API key needed.");
    println!("Browser: {}", connection.browser_url());
    println!("\nRun `tress` to join this thread, or `tress --ui` for the terminal interface.");
    println!("To join another thread: tress attach -s <id>");
    Ok(())
}

async fn inspect_host(command: &str, paths: &Paths, special: bool) -> Result<(), String> {
    let connection = host::configured_host(paths)?;
    if command == "config" {
        let value = connection.as_ref().map_or_else(
            || serde_json::json!({"mode":"host", "host":null, "session":"not configured", "credentials":"managed by host", "next":"tress setup"}),
            host::Connection::public_view,
        );
        if special {
            println!("{}", serde_json::to_string_pretty(&value).unwrap());
        } else {
            println!(
                "Mode        host\nHost        {}\nSession     {}\nCredentials managed by host",
                value["host"]
                    .as_str()
                    .unwrap_or("not configured; run tress setup"),
                value["session"].as_str().unwrap_or("not configured")
            );
            println!("Workspace   on host");
        }
        return Ok(());
    }
    let connection = connection
        .ok_or("No host configured. Run `tress setup`. A personal model key is not required.")?;
    println!(
        "ok  Host: {}\nok  Model credentials are managed by the host",
        connection.host
    );
    if special {
        host::discover(&connection.host, connection.session.as_deref()).await?;
        println!("ok  Host is reachable and reports model credentials configured (no generation performed)");
    } else {
        println!("Host access not checked. Run `tress doctor --check-api` to verify.");
    }
    Ok(())
}

fn setup(paths: &Paths, flags: UserConfig, key_stdin: bool) -> Result<(), String> {
    if paths.directory.is_none() {
        return Err("Set HOME or XDG_CONFIG_HOME before running setup".into());
    }
    if !key_stdin && (!std::io::stdin().is_terminal() || !std::io::stdout().is_terminal()) {
        return Err(
            "Setup needs a terminal. For automation, pipe a key into `tress setup --local --key-stdin`."
                .into(),
        );
    }
    let mut user = paths.read_user()?;
    let model = flags
        .model
        .or(user.model.clone())
        .unwrap_or_else(|| config::DEFAULT_MODEL.into());
    let key = if key_stdin {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(4099)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read API key from stdin")?;
        if bytes.len() > 4098 {
            return Err("API key is too long; nothing saved".into());
        }
        let key = String::from_utf8(bytes).map_err(|_| "API key must be valid UTF-8")?;
        let key = key.trim_end_matches(['\r', '\n']).to_owned();
        config::validate_key(&key)?;
        user.model = Some(model);
        Some(key)
    } else {
        println!("tress setup\n\nProvider: Anthropic\nKeys stay in your private user configuration, outside the project.\n");
        let model = prompt(&format!("Model [{model}]: "))?.unwrap_or(model);
        config::validate_model(&model)?;
        user.model = Some(model);
        // A broken saved credential can be replaced without editing files by hand.
        let existing = match config::credential(paths) {
            Ok((key, source)) => {
                if source == "environment" {
                    println!("ANTHROPIC_API_KEY takes priority; Enter keeps using it without saving a copy.");
                }
                key.is_some()
            }
            Err(error) => {
                println!("{error}\nEnter a replacement key below.");
                false
            }
        };
        let key = secret(if existing {
            "API key [Enter to keep current]: "
        } else {
            "API key: "
        })?;
        if key.is_empty() && existing {
            None
        } else {
            config::validate_key(&key)?;
            Some(key)
        }
    };
    if flags.max_steps.is_some() {
        user.max_steps = flags.max_steps;
    }
    if flags.base_url.is_some() {
        user.base_url = flags.base_url;
    }
    user.mode = Some(Mode::Local);
    config::save(paths, &user, key.as_deref())?;
    println!("\nSaved {}", paths.user_config().unwrap().display());
    if key.is_some() {
        println!("API key saved privately (not shown).");
    }
    if [
        "TRESS_MODEL",
        "TRESS_MAX_STEPS",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_API_KEY",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some())
    {
        println!(
            "Environment variables still take priority. `tress config` shows effective settings."
        );
    }
    println!("\nNext:\n  cd your-project\n  tress doctor --check-api\n  tress");
    Ok(())
}

fn prompt(label: &str) -> Result<Option<String>, String> {
    print!("{label}");
    std::io::stdout()
        .flush()
        .map_err(|_| "Cannot write prompt")?;
    let mut value = String::new();
    if std::io::stdin()
        .read_line(&mut value)
        .map_err(|_| "Cannot read input")?
        == 0
    {
        return Err("Setup cancelled; nothing saved".into());
    }
    let value = value.trim();
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

struct SecretInput;
impl Drop for SecretInput {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
        let _ = crossterm::execute!(std::io::stdout(), event::DisableBracketedPaste);
        println!();
    }
}

fn secret(label: &str) -> Result<String, String> {
    crossterm::terminal::enable_raw_mode().map_err(|_| "Cannot hide API key input")?;
    let _guard = SecretInput;
    crossterm::execute!(std::io::stdout(), event::EnableBracketedPaste)
        .map_err(|_| "Cannot enable key input")?;
    // Hide input before displaying the prompt, including for a fast paste.
    print!("{label}");
    std::io::stdout()
        .flush()
        .map_err(|_| "Cannot write prompt")?;
    let mut value = String::new();
    loop {
        match event::read().map_err(|_| "Cannot read API key")? {
            Event::Key(key) if key.kind != KeyEventKind::Release => match key.code {
                KeyCode::Enter => return Ok(value),
                KeyCode::Esc => return Err("Setup cancelled; nothing saved".into()),
                KeyCode::Char('c' | 'd') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    return Err("Setup cancelled; nothing saved".into())
                }
                KeyCode::Backspace => {
                    value.pop();
                }
                KeyCode::Char(c)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    value.push(c);
                }
                _ => {}
            },
            Event::Paste(text) => value.push_str(text.trim_end_matches(['\r', '\n'])),
            _ => {}
        }
        if value.len() > 4096 {
            return Err("API key is too long; nothing saved".into());
        }
    }
}

async fn check_api(config: &Resolved) -> Result<(), String> {
    let mut url = reqwest::Url::parse(&config.base_url.value).map_err(|_| "Invalid API URL")?;
    url.path_segments_mut()
        .map_err(|_| "Invalid API URL")?
        .pop_if_empty()
        .extend(["v1", "models", &config.model.value]);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot create API client")?;
    let mut response = client
        .get(url)
        .header("x-api-key", config.key()?)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|_| {
            "Cannot reach the API within 10 seconds. Check your connection and base_url."
        })?;
    let status = response.status();
    if status.is_success() {
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Cannot read Models API response")?
        {
            if body.len() + chunk.len() > 65_536 {
                return Err("Unexpected Models API response; check base_url".into());
            }
            body.extend_from_slice(&chunk);
        }
        let model: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|_| "Unexpected Models API response; check base_url")?;
        if model["type"] != "model" || model["id"].as_str().is_none_or(|id| id.is_empty()) {
            return Err("Unexpected Models API response; check base_url".into());
        }
        return Ok(());
    }
    let hint = match status.as_u16() {
        401 | 403 => "Check your API key and model access; rerun `tress setup` to replace the saved key.",
        404 | 405 => "Check the model ID. Custom endpoints may not support the Models API even when generation works.",
        429 => "Rate limited; try again shortly.",
        300..=399 => "The endpoint redirected. Set the final API base_url explicitly; credentials are never forwarded through redirects.",
        _ => "The API could not verify model access. Check the endpoint and provider status.",
    };
    // Do not print the response body: an endpoint could echo credentials in it.
    Err(format!("API check failed (HTTP {status}). {hint}"))
}
