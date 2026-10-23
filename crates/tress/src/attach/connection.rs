//! Both legacy Tress hosts and existing Harness hosts render through one view.

use std::collections::{BTreeMap, HashSet};

use harness_threads::commands::{Command, QueuePlacement, RunEnqueue, UserMessage};
use harness_threads::{HARNESS_PROTOCOL, MAIN_NS};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};
use statewire::session::{Config, Event, Session};
use statewire::transport::http::{connect_with_headers, generate_client_id};

#[derive(Clone)]
pub struct Connector {
    origin: String,
    headers: HeaderMap,
    credential_args: String,
}

impl Connector {
    pub fn with_api_key_env(
        url: &str,
        file: Option<&str>,
        variable: Option<&str>,
    ) -> Result<Self, String> {
        if file.is_some() && variable.is_some() {
            return Err("Choose --headers-file or --api-key-env, not both.".into());
        }
        let mut connector = Self::new(url, file)?;
        if let Some(variable) = variable {
            if variable.is_empty()
                || !variable
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            {
                return Err("--api-key-env needs an environment variable name.".into());
            }
            let destination = reqwest::Url::parse(url).map_err(|_| "Invalid application URL")?;
            let host = destination
                .host_str()
                .unwrap_or_default()
                .trim_matches(['[', ']']);
            let loopback = host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback());
            if destination.scheme() != "https" && !(destination.scheme() == "http" && loopback) {
                return Err(
                    "App credentials require HTTPS, or HTTP on loopback for local development."
                        .into(),
                );
            }
            let key = std::env::var(variable).map_err(|_| {
                format!("Set {variable} to your application's API key or bearer token.")
            })?;
            if key.trim().is_empty() || key.len() > 16 * 1024 {
                return Err("Application credential is empty or too large.".into());
            }
            let mut header = HeaderValue::from_str(&format!("Bearer {key}"))
                .map_err(|_| "Invalid application credential")?;
            header.set_sensitive(true);
            connector
                .headers
                .insert(reqwest::header::AUTHORIZATION, header);
            connector.credential_args = format!(" --api-key-env {variable}");
        }
        Ok(connector)
    }

    pub async fn discovery(&self, url: &str, optional: bool) -> Result<Option<Value>, String> {
        let destination = reqwest::Url::parse(url).map_err(|_| "Invalid discovery URL")?;
        if destination.origin().ascii_serialization() != self.origin {
            return Err("Discovery must stay on the application's origin.".into());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .get(destination)
            .headers(self.headers.clone())
            .send()
            .await;
        let mut response = match response {
            // Legacy attachment permits an offline host so /help and /reconnect
            // remain usable. Authentication and invalid manifests still fail.
            Err(error) if optional && error.is_connect() => return Ok(None),
            result => result.map_err(|error| error.to_string())?,
        };
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("Application discovery returned HTTP {}. The app must expose /.well-known/tress.json and accept this credential.", response.status().as_u16()));
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .eq_ignore_ascii_case("application/json")
            })
        {
            // Older sites may serve their HTML shell for unknown paths.
            return Ok(None);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > 16 * 1024 {
                return Err("Application discovery is too large.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Invalid Tress discovery document.".into())
    }

    pub fn new(url: &str, headers_file: Option<&str>) -> Result<Self, String> {
        let url = reqwest::Url::parse(url).map_err(|_| "Invalid thread URL")?;
        let mut headers = HeaderMap::new();
        if let Some(path) = headers_file {
            let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
            let loopback = host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback());
            if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
                return Err(
                    "App credentials require HTTPS, or HTTP on loopback for local development."
                        .into(),
                );
            }
            let file = std::fs::File::open(path)
                .map_err(|error| format!("Could not open credential file: {error}"))?;
            let metadata = file.metadata().map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err("Credential file must be private. Run chmod 600 on it.".into());
                }
            }
            if !metadata.is_file() || metadata.len() > 16 * 1024 {
                return Err("Credential file must be a JSON file smaller than 16 KiB.".into());
            }
            let values: BTreeMap<String, String> = serde_json::from_reader(file).map_err(|_| {
                "Credential file must be a JSON object of HTTP header names and values."
            })?;
            if values.is_empty() {
                return Err("Credential file contains no headers.".into());
            }
            for (name, value) in values {
                let name = HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| "Invalid credential header name")?;
                let mut value =
                    HeaderValue::from_str(&value).map_err(|_| "Invalid credential header value")?;
                value.set_sensitive(true);
                headers.insert(name, value);
            }
        }
        Ok(Self {
            origin: url.origin().ascii_serialization(),
            headers,
            credential_args: headers_file.map_or_else(String::new, |path| {
                format!(" --headers-file '{}'", path.replace('\'', "'\\''"))
            }),
        })
    }

    pub fn attach_command(&self, url: &str) -> String {
        format!(
            "{}{}",
            super::recent::attach_command(url),
            self.credential_args
        )
    }

    pub async fn connect(
        &self,
        url: &str,
        config: Config,
    ) -> Result<(Client, tokio::sync::mpsc::UnboundedReceiver<Event>), String> {
        let destination = reqwest::Url::parse(url).map_err(|_| "Invalid thread URL")?;
        if !self.headers.is_empty() && destination.origin().ascii_serialization() != self.origin {
            return Err("These credentials belong to a different application. Attach explicitly with that app's credential file.".into());
        }
        let (client, events) = connect_with_headers(url, config, self.headers.clone())
            .await
            .map_err(|error| error.to_string())?;
        Ok((Client(client), events))
    }
}

pub struct Client(statewire::transport::Client);

impl Client {
    pub async fn with_session<T>(&self, read: impl FnOnce(&Session) -> T) -> T {
        self.0.with_session(read).await
    }

    pub async fn main_value(&self, protocol: &str) -> Option<Value> {
        self.0
            .with_session(|session| {
                let docs = session.documents();
                if let Some(legacy) = docs.main(protocol) {
                    return Some(legacy.value.clone());
                }
                let main = &docs.main(HARNESS_PROTOCOL)?.value;
                let messages = docs.iter().filter_map(|(_, doc)| {
                    let key = doc.key.as_ref()?;
                    (doc.protocol == HARNESS_PROTOCOL && key.len() == 3 && key[1] == MAIN_NS)
                        .then_some(&doc.value)
                });
                Some(harness_view(main, messages))
            })
            .await
    }

    pub async fn can_reset(&self) -> bool {
        self.0.main_value(HARNESS_PROTOCOL).await.is_none()
    }

    pub async fn command(&self, protocol: &str, method: &str, params: Vec<Value>) -> u64 {
        if method == "send" {
            if let Some(state) = self.0.main_value(HARNESS_PROTOCOL).await {
                let command = RunEnqueue {
                    run_id: generate_client_id(),
                    message: Some(UserMessage::text(
                        generate_client_id(),
                        params[0].as_str().unwrap_or_default(),
                    )),
                    message_id: None,
                    run_anchor_message_id: Some(
                        state["threads"][MAIN_NS]["headId"]
                            .as_str()
                            .map(str::to_owned),
                    ),
                    placement: QueuePlacement::default(),
                };
                let (method, params) = command.statement();
                return self.0.command(HARNESS_PROTOCOL, method, params).await;
            }
        }
        self.0.command(protocol, method, params).await
    }
}

fn harness_view<'a>(main: &Value, messages: impl Iterator<Item = &'a Value>) -> Value {
    let docs: BTreeMap<_, _> = messages
        .filter_map(|value| Some((value["id"].as_str()?, value)))
        .collect();
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut head = main["threads"][MAIN_NS]["headId"].as_str();
    while let Some(id) = head {
        if !seen.insert(id) {
            break;
        }
        let Some(message) = docs.get(id) else {
            break;
        };
        chain.push(*message);
        head = message["parentId"].as_str();
    }
    chain.reverse();
    let revision = chain
        .iter()
        .filter_map(|m| m["seq"].as_u64())
        .max()
        .map_or(0, |seq| seq.saturating_add(1));
    let status = main["status"].as_str().unwrap_or("ready");
    let error = status == "error" || main["threads"][MAIN_NS]["error"].is_string();
    let entries: Vec<_> = chain.iter().map(|message| {
        let parts = message["parts"].as_array().map(Vec::as_slice).unwrap_or_default();
        let text: String = parts.iter().filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str()).collect();
        let tools: Vec<_> = parts.iter().filter(|part| part["type"] == "tool")
            .filter_map(|part| part["toolName"].as_str().map(|name| {
                if part["state"] == "pendingApproval" { format!("{name} · approval needed in browser") }
                else { name.to_owned() }
            })).collect();
        json!({"id":message["id"],"role":if message["role"] == "user" {"user"} else {"agent"},"text":text,"tools":tools,"error":error && message["id"] == main["threads"][MAIN_NS]["headId"]})
    }).collect();
    json!({
        "entries": entries,
        "status": if matches!(status, "running" | "stopping" | "input-required") { "running" } else { status },
        "runs": revision,
        "attention": (status == "input-required").then_some("The application needs input. Open this thread in its browser UI to continue."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn credentials_stay_private_and_bound_to_the_application_origin() {
        let path =
            std::env::temp_dir().join(format!("tress-headers-{}.json", generate_client_id()));
        let path_str = path.to_str().unwrap();
        std::fs::write(&path, r#"{"Authorization":"Bearer fixture-only"}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(Connector::new("https://app.example/thread", Some(path_str))
                .err()
                .unwrap()
                .contains("private"));
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(Connector::new("http://app.example/thread", Some(path_str)).is_err());
        let connector = Connector::new("https://app.example/thread", Some(path_str)).unwrap();
        assert!(connector.headers["authorization"].is_sensitive());
        let denied = connector
            .connect(
                "https://another.example/thread",
                super::super::connection_config(),
            )
            .await;
        assert!(denied.err().unwrap().contains("different application"));
        assert!(Connector::new("http://127.0.0.1:3000/thread", Some(path_str)).is_ok());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn renders_only_the_active_branch_and_marks_pending_approval() {
        let main = json!({"threads":{"main":{"headId":"a2"}},"status":"input-required"});
        let messages = [
            json!({"id":"u1","parentId":null,"seq":51,"role":"user","parts":[{"type":"text","text":"hello"}]}),
            json!({"id":"old","parentId":"u1","seq":52,"role":"assistant","parts":[{"type":"text","text":"old branch"}]}),
            json!({"id":"a2","parentId":"u1","seq":53,"role":"assistant","parts":[{"type":"text","text":"new branch"},{"type":"tool","toolName":"write","state":"pendingApproval"}]}),
        ];
        let view = harness_view(&main, messages.iter());
        assert_eq!(view["entries"].as_array().unwrap().len(), 2);
        assert_eq!(view["entries"][1]["text"], "new branch");
        assert_eq!(
            view["entries"][1]["tools"][0],
            "write · approval needed in browser"
        );
        assert_eq!(view["runs"], 54);
        assert_eq!(view["status"], "running");
        assert!(view["attention"].is_string());
    }
}
