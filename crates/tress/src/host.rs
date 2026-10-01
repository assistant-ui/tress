//! Saved client connections. Provider and Harness credentials stay on the host.
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{self, Paths};

pub const DEFAULT_HOST: &str = "https://tress-theta.vercel.app";

#[derive(Deserialize)]
pub struct HealthReport {
    pub ok: bool,
    pub checks: Vec<HealthCheck>,
}

#[derive(Deserialize)]
pub struct HealthCheck {
    pub name: String,
    pub status: String,
    pub message: String,
}

/// Diagnostics use only server-held credentials and never generate a completion.
pub async fn diagnose(connection: &Connection) -> Result<HealthReport, String> {
    let mut url =
        reqwest::Url::parse(&format!("{}/api/health", validate_host(&connection.host)?)).unwrap();
    if let Some(id) = &connection.session {
        validate_session(id)?;
        url.query_pairs_mut().append_pair("session", id);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot create host client")?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Cannot reach host diagnostics. Check the host address and connection.")?;
    if !response.status().is_success() && response.status().as_u16() != 503 {
        return Err(match response.status().as_u16() {
            404 => "Host diagnostics are unavailable. Update the host or check the saved session.".into(),
            410 => "This demo session has expired. Run `tress setup` and choose a new session.".into(),
            401 | 403 => "Host diagnostics require access. Check host authentication or deployment protection.".into(),
            _ => format!("Host diagnostics failed (HTTP {}).", response.status()),
        });
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Cannot read host diagnostics")?
    {
        if body.len() + chunk.len() > 65_536 {
            return Err("Host diagnostics are too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    let report: HealthReport =
        serde_json::from_slice(&body).map_err(|_| "Invalid host diagnostics response")?;
    if report.checks.is_empty()
        || report.checks.len() > 10
        || report
            .checks
            .iter()
            .any(|item| !matches!(item.status.as_str(), "ok" | "error" | "unknown"))
    {
        return Err("Invalid host diagnostics response".into());
    }
    Ok(report)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub host: String,
    pub session: Option<String>,
}

impl Connection {
    pub fn load(paths: &Paths) -> Result<Option<Self>, String> {
        let Some(dir) = &paths.directory else {
            return Ok(None);
        };
        let mut connection: Option<Self> = config::read_json(&dir.join("connection.json"), true)?;
        if let Some(value) = &mut connection {
            value.host = validate_host(&value.host)?;
            if let Some(id) = &value.session {
                validate_session(id)?;
            }
        }
        Ok(connection)
    }

    pub fn save(&self, paths: &Paths) -> Result<(), String> {
        let dir = config::private_directory(paths)?;
        #[cfg(not(unix))]
        return Err("Saving a session currently requires macOS or Linux; use `tress attach <host> -s <id>` on this platform.".into());
        #[cfg(unix)]
        config::write_json(&dir.join("connection.json"), self)
    }

    pub fn browser_url(&self) -> String {
        match &self.session {
            Some(id) => format!("{}/?session={id}", self.host),
            None => self.host.clone(),
        }
    }

    pub fn public_view(&self) -> Value {
        json!({ "mode": "host", "host": self.host, "session": if self.session.is_some() { "saved (hidden)" } else { "shared thread" }, "model": "managed by host", "credentials": "managed by host", "workspace": "on host" })
    }
}

pub fn validate_session(id: &str) -> Result<(), String> {
    if !matches!(id.len(), 12 | 32)
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("Invalid session ID; copy the complete ID from the site".into());
    }
    Ok(())
}

pub fn validate_host(input: &str) -> Result<String, String> {
    let normalized = config::validate_url(input)?;
    let url = reqwest::Url::parse(&normalized).map_err(|_| "Invalid host URL")?;
    if !matches!(url.path(), "" | "/") {
        return Err(
            "Use the host origin, for example https://tress-theta.vercel.app (no path)".into(),
        );
    }
    Ok(normalized)
}

pub fn configured_host(paths: &Paths) -> Result<Option<Connection>, String> {
    let saved = Connection::load(paths)?;
    let session = std::env::var("TRESS_SESSION")
        .map(Some)
        .or_else(|error| match error {
            std::env::VarError::NotPresent => Ok(None),
            _ => Err("TRESS_SESSION must be valid UTF-8"),
        })?;
    if let Some(id) = &session {
        validate_session(id)?;
    }
    if let Some(value) = std::env::var_os("TRESS_HOST") {
        let host = validate_host(value.to_str().ok_or("TRESS_HOST must be valid UTF-8")?)?;
        // A session capability never travels to a different host implicitly.
        let saved_session = saved
            .filter(|saved| saved.host == host)
            .and_then(|saved| saved.session);
        return Ok(Some(Connection {
            host,
            session: session.or(saved_session),
        }));
    }
    if session.is_some() && saved.is_none() {
        return Err("TRESS_SESSION requires TRESS_HOST or a saved host connection".into());
    }
    Ok(saved.map(|mut connection| {
        if session.is_some() {
            connection.session = session;
        }
        connection
    }))
}

/// Read the site's public configuration. Without an ID, setup creates a fresh
/// isolated demo session; diagnostics always send the saved session ID.
pub async fn discover(host: &str, session: Option<&str>) -> Result<Connection, String> {
    let host = validate_host(host)?;
    let mut url = reqwest::Url::parse(&format!("{host}/api/mode")).unwrap();
    if let Some(id) = session {
        validate_session(id)?;
        url.query_pairs_mut().append_pair("session", id);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot create host client")?;
    let mut response = client.get(url).send().await.map_err(|_| "Cannot reach the host. Check its address and connection; local model credentials are not used.")?;
    let status = response.status();
    if !status.is_success() {
        let hint = match status.as_u16() {
            401 | 403 => "The host requires access. Check its login or deployment protection with the host operator.",
            404 => "The host or session was not found. Copy the host and session ID from the site.",
            410 => "This demo session has expired. Run `tress setup` and choose a new session.",
            429 => "The demo's daily new-session limit has been reached. Try again after midnight UTC.",
            300..=399 => "The host redirected. Use its final address; session IDs are not forwarded through redirects.",
            _ => "The host is unavailable. Try again later.",
        };
        return Err(format!("Host check failed (HTTP {status}). {hint}"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Cannot read host configuration")?
    {
        if body.len() + chunk.len() > 65_536 {
            return Err("Host configuration is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| "This address did not return a tress host configuration")?;
    if !matches!(value["kind"].as_str(), Some("cloud" | "local"))
        || !value["configured"].is_boolean()
    {
        return Err("This address did not return a tress host configuration".into());
    }
    if value["configured"] != true {
        return Err("The host has no model credential configured. The host operator must configure it; no personal API key is needed in this terminal.".into());
    }
    let returned = value
        .get("session")
        .map(|value| {
            value["attachId"]
                .as_str()
                .ok_or("Invalid session returned by the host")
        })
        .transpose()?;
    if let Some(id) = returned {
        validate_session(id)?;
    }
    if session.is_some()
        && (returned.is_none() || session.is_some_and(|id| id.len() == 12) && session != returned)
    {
        return Err("The host did not confirm the requested session".into());
    }
    Ok(Connection {
        host,
        session: returned.map(str::to_owned),
    })
}

pub fn target(
    paths: &Paths,
    explicit_host: Option<&str>,
    session: Option<&str>,
) -> Result<Connection, String> {
    if let Some(host) = explicit_host {
        return Ok(Connection {
            host: host.to_owned(),
            session: session.map(str::to_owned),
        });
    }
    let mut saved = configured_host(paths)?.ok_or("No host configured. Run `tress setup`, or `tress attach <host> -s <id>`. No personal API key is needed.")?;
    if let Some(id) = session {
        saved.session = Some(id.to_owned());
    }
    Ok(saved)
}
