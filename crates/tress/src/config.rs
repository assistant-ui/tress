//! Native CLI configuration. Project files can select a model, never a
//! credential, API destination, or shell approval policy.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

use tress::engine::DEFAULT_MAX_STEPS;

pub const DEFAULT_MODEL: &str = "claude-sonnet-5";
const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const MAX_FILE_BYTES: u64 = 65_536;

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UserConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectConfig {
    model: Option<String>,
    max_steps: Option<usize>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    anthropic_api_key: String,
}

pub struct Paths {
    pub directory: Option<PathBuf>,
    pub project: PathBuf,
}

impl Paths {
    pub fn discover(root: &Path) -> Result<Self, String> {
        let directory = match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            Some(path) => Some(PathBuf::from(path).join("tress")),
            None => std::env::var_os("HOME")
                .filter(|v| !v.is_empty())
                .map(|home| PathBuf::from(home).join(".config/tress")),
        };
        if directory.as_ref().is_some_and(|path| !path.is_absolute()) {
            return Err("XDG_CONFIG_HOME / HOME must be an absolute path".into());
        }
        Ok(Self {
            directory,
            project: root.join(".tress.json"),
        })
    }

    pub fn user_config(&self) -> Option<PathBuf> {
        self.directory.as_ref().map(|dir| dir.join("config.json"))
    }

    pub fn credentials(&self) -> Option<PathBuf> {
        self.directory
            .as_ref()
            .map(|dir| dir.join("credentials.json"))
    }

    pub fn read_user(&self) -> Result<UserConfig, String> {
        self.user_config()
            .map(|path| read_json(&path, false))
            .transpose()
            .map(|config| config.flatten().unwrap_or_default())
    }
}

pub struct Setting<T> {
    pub value: T,
    pub source: &'static str,
}

pub struct Resolved {
    pub model: Setting<String>,
    pub max_steps: Setting<NonZeroUsize>,
    pub base_url: Setting<String>,
    // Deliberately not serializable or Debug: diagnostics never include this value.
    pub api_key: Option<String>,
    pub key_source: &'static str,
}

impl Resolved {
    pub fn load(paths: &Paths, flags: &UserConfig) -> Result<Self, String> {
        let user = paths.read_user()?;
        let project: ProjectConfig = read_json(&paths.project, false)?.unwrap_or_default();
        let model = select(
            flags.model.clone(),
            env("TRESS_MODEL")?,
            project.model,
            user.model,
            DEFAULT_MODEL.to_owned(),
        );
        validate_model(&model.value)?;
        let steps = select(
            flags.max_steps.map(|v| v.to_string()),
            env("TRESS_MAX_STEPS")?,
            project.max_steps.map(|v| v.to_string()),
            user.max_steps.map(|v| v.to_string()),
            DEFAULT_MAX_STEPS.to_string(),
        );
        let max_steps = Setting {
            value: validate_steps(parse_steps(&steps.value)?)?,
            source: steps.source,
        };
        let mut base_url = select(
            flags.base_url.clone(),
            env("ANTHROPIC_BASE_URL")?,
            None,
            user.base_url,
            DEFAULT_BASE_URL.to_owned(),
        );
        base_url.value = validate_url(&base_url.value)?;
        let (api_key, key_source) = credential(paths)?;
        Ok(Self {
            model,
            max_steps,
            base_url,
            api_key,
            key_source,
        })
    }

    pub fn key(&self) -> Result<&str, String> {
        self.api_key.as_deref().ok_or_else(|| {
            "No Anthropic API key. Run `tress setup` or set ANTHROPIC_API_KEY.".into()
        })
    }

    pub fn public_view(&self, paths: &Paths, root: &Path) -> Value {
        json!({
            "model": { "value": self.model.value, "source": self.model.source },
            "max_steps": { "value": self.max_steps.value.get(), "source": self.max_steps.source },
            "base_url": { "value": self.base_url.value, "source": self.base_url.source },
            "credential": { "configured": self.api_key.is_some(), "source": self.key_source },
            "user_config": paths.user_config(),
            "project_config": paths.project,
            "workspace": root,
        })
    }
}

fn select<T>(
    flag: Option<T>,
    env: Option<T>,
    project: Option<T>,
    user: Option<T>,
    default: T,
) -> Setting<T> {
    for (value, source) in [
        (flag, "flag"),
        (env, "environment"),
        (project, "project"),
        (user, "user"),
    ] {
        if let Some(value) = value {
            return Setting { value, source };
        }
    }
    Setting {
        value: default,
        source: "default",
    }
}

fn env(name: &str) -> Result<Option<String>, String> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(_) => Err(format!("{name} must contain valid UTF-8")),
    }
}

pub fn credential(paths: &Paths) -> Result<(Option<String>, &'static str), String> {
    if let Some(key) = env("ANTHROPIC_API_KEY")? {
        validate_key(&key)?;
        return Ok((Some(key), "environment"));
    }
    if let Some(path) = paths.credentials() {
        if let Some(saved) = read_json::<Credentials>(&path, true)? {
            validate_key(&saved.anthropic_api_key)?;
            return Ok((Some(saved.anthropic_api_key), "saved"));
        }
    }
    Ok((None, "missing"))
}

pub fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 4096 || !key.bytes().all(|c| c.is_ascii_graphic()) {
        return Err("Invalid Anthropic API key: expected a nonempty key without spaces or control characters.".into());
    }
    Ok(())
}

pub fn validate_model(model: &str) -> Result<(), String> {
    if model.is_empty()
        || model.len() > 256
        || !model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
    {
        return Err(
            "Invalid model: use a model ID containing letters, numbers, '-', '_', '.', or ':'."
                .into(),
        );
    }
    Ok(())
}

pub fn parse_steps(value: &str) -> Result<usize, String> {
    let steps = value
        .parse()
        .map_err(|_| "max_steps must be an integer between 1 and 1024")?;
    validate_steps(steps)?;
    Ok(steps)
}

fn validate_steps(steps: usize) -> Result<NonZeroUsize, String> {
    if !(1..=1024).contains(&steps) {
        return Err("max_steps must be an integer between 1 and 1024".into());
    }
    Ok(NonZeroUsize::new(steps).unwrap())
}

pub fn validate_url(value: &str) -> Result<String, String> {
    let url =
        reqwest::Url::parse(value).map_err(|_| "Invalid base_url: expected an HTTP(S) API URL")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Invalid base_url: use HTTP(S) without credentials, query parameters, or a fragment"
                .into(),
        );
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// Consume just the leading settings flags. Prompt text after the first
/// positional argument is left intact, including strings such as --model.
pub fn parse_flags<'a>(
    mut args: &'a [String],
    flags: &mut UserConfig,
) -> Result<&'a [String], String> {
    while let Some(flag) = args.first() {
        match flag.as_str() {
            "--model" | "--max-steps" | "--base-url" => {
                let value = args.get(1).ok_or_else(|| format!("{flag} needs a value"))?;
                match flag.as_str() {
                    "--model" => {
                        validate_model(value)?;
                        flags.model = Some(value.clone());
                    }
                    "--max-steps" => flags.max_steps = Some(parse_steps(value)?),
                    _ => flags.base_url = Some(validate_url(value)?),
                }
                args = &args[2..];
            }
            _ => break,
        }
    }
    Ok(args)
}

fn read_json<T: DeserializeOwned>(path: &Path, private: bool) -> Result<Option<T>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read {}: {error}", path.display())),
    };
    if !metadata.is_file() && (private || !metadata.file_type().is_symlink()) {
        return Err(format!("{} must be a regular file", path.display()));
    }
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!(
                "{} must be private (chmod 600), or use ANTHROPIC_API_KEY",
                path.display()
            ));
        }
    }
    let file =
        File::open(path).map_err(|error| format!("Cannot open {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("{} is too large (maximum 64 KiB)", path.display()));
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        let keys = if private {
            "anthropic_api_key"
        } else if path.file_name().is_some_and(|name| name == ".tress.json") {
            "model, max_steps"
        } else {
            "model, max_steps, base_url"
        };
        // Serde's full error can contain input values; never echo them.
        format!(
            "Invalid JSON configuration in {} at line {}, column {}. Allowed keys: {keys}.",
            path.display(),
            error.line(),
            error.column()
        )
    })
}

pub fn save(paths: &Paths, config: &UserConfig, key: Option<&str>) -> Result<(), String> {
    if let Some(model) = &config.model {
        validate_model(model)?;
    }
    if let Some(steps) = config.max_steps {
        validate_steps(steps)?;
    }
    if let Some(url) = &config.base_url {
        validate_url(url)?;
    }
    if let Some(key) = key {
        validate_key(key)?;
    }
    let dir = paths
        .directory
        .as_ref()
        .ok_or("Set HOME or XDG_CONFIG_HOME before running setup")?;
    if let Ok(metadata) = fs::symlink_metadata(dir) {
        if !metadata.is_dir() {
            return Err(format!(
                "{} must be a directory, not a symlink",
                dir.display()
            ));
        }
    }
    fs::create_dir_all(dir).map_err(|error| format!("Cannot create {}: {error}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Cannot make config directory private: {error}"))?;
    }
    #[cfg(not(unix))]
    if key.is_some() {
        return Err("Saving credentials currently requires macOS or Linux; use ANTHROPIC_API_KEY on this platform.".into());
    }
    // Write each file atomically: an interruption never truncates an existing key.
    if let Some(key) = key {
        write_json(
            &dir.join("credentials.json"),
            &Credentials {
                anthropic_api_key: key.to_owned(),
            },
        )?;
    }
    write_json(&dir.join("config.json"), config)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_extension(format!("{}.{}.tmp", std::process::id(), nonce));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Cannot create private config file: {error}"))?;
    let result = (|| -> Result<(), String> {
        serde_json::to_writer_pretty(&mut file, value)
            .map_err(|_| "Cannot encode configuration")?;
        file.write_all(b"\n")
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Cannot save configuration: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Cannot replace {}: {error}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
