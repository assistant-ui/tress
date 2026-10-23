//! Application thread discovery over the existing Harness thread-list protocol.
use std::collections::HashSet;
use std::io::{IsTerminal, Write};

use harness_threads::threads_list::{EntryStatus, ThreadsDocument};
use serde::Deserialize;
use statewire::session::{Config, Event};
use statewire::transport::http::generate_client_id;
use statewire::{VersionRange, WIRE_VERSION};

use super::{connection::Connector, recent::RecentThread};

pub const HELP: &str = "usage: tress threads <app-origin> [--api-key-env <NAME> | --headers-file <path>] [--json | --open <thread-id>] [--ui]\n\nLists every thread the application grants this credential, including archived threads.\nInteractive terminals can choose a thread; --open selects one directly.\nThe app publishes /.well-known/tress.json and a Harness thread-list endpoint.\nNo credential is needed if the app explicitly allows anonymous access.\n";

#[derive(Deserialize)]
struct Manifest {
    version: u32,
    threads: String,
    thread: String,
}

pub struct Catalog {
    origin: reqwest::Url,
    list_url: String,
    template: String,
    pub document: ThreadsDocument,
}

fn endpoint(origin: &reqwest::Url, path: &str) -> Result<reqwest::Url, String> {
    let url = origin.join(path).map_err(|_| "Invalid thread endpoint")?;
    if url.origin() != origin.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Thread endpoints must be on the application origin, without URL credentials, queries or fragments.".into());
    }
    Ok(url)
}

impl Catalog {
    fn from_manifest(origin: reqwest::Url, manifest: Manifest) -> Result<Self, String> {
        if manifest.version != 1 || manifest.thread.matches("{id}").count() != 1 {
            return Err(
                "Unsupported discovery document: expected version 1 and one {id} in thread.".into(),
            );
        }
        let list_url = endpoint(&origin, &manifest.threads)?.to_string();
        let marker = endpoint(
            &origin,
            &manifest.thread.replace("{id}", "tress-thread-placeholder"),
        )?;
        if !marker.path().contains("tress-thread-placeholder") {
            return Err("The thread template must contain {id} in its path.".into());
        }
        Ok(Self {
            origin,
            list_url,
            template: manifest.thread,
            document: ThreadsDocument { threads: vec![] },
        })
    }

    fn thread_url(&self, id: &str) -> Result<String, String> {
        if id.is_empty()
            || id == "."
            || id == ".."
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._~-".contains(&c))
        {
            return Err("The host returned an unsupported thread ID.".into());
        }
        Ok(endpoint(&self.origin, &self.template.replace("{id}", id))?.to_string())
    }

    pub fn select(&self, id: &str) -> Result<String, String> {
        if !self.document.threads.iter().any(|thread| thread.id == id) {
            return Err("That thread is not in this application's accessible thread list.".into());
        }
        self.thread_url(id)
    }

    pub fn attach_command(&self, connector: &Connector) -> String {
        connector.attach_command(self.origin.as_str())
    }

    pub fn items(&self) -> Vec<RecentThread> {
        self.document
            .threads
            .iter()
            .filter_map(|thread| {
                let title = thread.title.as_deref().unwrap_or(&thread.id);
                let title = title
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(120)
                    .collect::<String>();
                Some(RecentThread {
                    url: self.thread_url(&thread.id).ok()?,
                    title: format!(
                        "{}{}",
                        title,
                        if thread.status == EntryStatus::Archived {
                            " [archived]"
                        } else {
                            ""
                        }
                    ),
                })
            })
            .collect()
    }

    pub async fn refresh(&mut self, connector: &Connector) -> Result<(), String> {
        // Never retain another user's old list after rejection or loss of access.
        self.document.threads.clear();
        let config = Config {
            client_id: generate_client_id(),
            wire: VersionRange::exact(WIRE_VERSION),
            offers: vec![harness_threads::threads_offer()],
        };
        let document = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let (client, mut events) = connector.connect(&self.list_url, config).await?;
            while let Some(event) = events.recv().await {
                if matches!(event, Event::Finished { .. }) {
                    return Err::<ThreadsDocument, String>(
                        "The application closed thread-list access.".into(),
                    );
                }
                if let Some(value) = client.main_value(harness_threads::THREADS_PROTOCOL).await {
                    return serde_json::from_value::<ThreadsDocument>(value)
                        .map_err(|_| "Invalid Harness thread-list document.".into());
                }
            }
            Err("The application closed the thread list.".into())
        })
        .await
        .map_err(|_| "The application thread list did not become ready within 15 seconds.")??;
        let mut ids = HashSet::new();
        for thread in &document.threads {
            self.thread_url(&thread.id)?;
            if !ids.insert(&thread.id) {
                return Err("The application returned duplicate thread IDs.".into());
            }
        }
        self.document = document;
        Ok(())
    }

    pub fn print(&self) {
        if self.document.threads.is_empty() {
            println!("No accessible threads.");
        }
        for (index, (thread, item)) in self.document.threads.iter().zip(self.items()).enumerate() {
            println!("  {}. {}\n     {}", index + 1, item.title, thread.id);
        }
    }
}

pub async fn run(args: &[String], style: &crate::Style) -> Result<(), String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let (mut app, mut file, mut variable, mut open) = (None, None, None, None);
    let (mut json, mut ui) = (false, false);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--headers-file" | "--api-key-env" | "--open" => {
                let slot = match arg.as_str() {
                    "--headers-file" => &mut file,
                    "--api-key-env" => &mut variable,
                    _ => &mut open,
                };
                if slot.is_some() {
                    return Err(format!("Provide {arg} only once."));
                }
                *slot = Some(
                    args.next()
                        .filter(|value| !value.starts_with('-'))
                        .ok_or_else(|| format!("{arg} needs a value"))?
                        .as_str(),
                );
            }
            "--json" => json = true,
            "--ui" => ui = true,
            value if !value.starts_with('-') && app.is_none() => app = Some(value),
            _ => return Err(HELP.into()),
        }
    }
    if json && (open.is_some() || ui) {
        return Err("--json cannot be combined with --open or --ui.".into());
    }
    let origin = reqwest::Url::parse(app.ok_or(HELP)?)
        .map_err(|_| "Provide an HTTP(S) application origin.")?;
    if !matches!(origin.scheme(), "http" | "https")
        || !matches!(origin.path(), "" | "/")
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return Err(
            "Use the application's HTTP(S) origin, without a path, query, or credentials.".into(),
        );
    }
    let connector = Connector::with_api_key_env(origin.as_str(), file, variable)?;
    let discovery = connector
        .discovery(
            origin.join("/.well-known/tress.json").unwrap().as_str(),
            false,
        )
        .await?;
    let discovery = discovery.ok_or("This application does not expose /.well-known/tress.json.")?;
    let manifest =
        serde_json::from_value(discovery).map_err(|_| "Invalid Tress discovery document.")?;
    let mut catalog = Catalog::from_manifest(origin, manifest)?;
    catalog.refresh(&connector).await?;
    browse(catalog, connector, open, json, ui, style).await
}

async fn browse(
    catalog: Catalog,
    connector: Connector,
    open: Option<&str>,
    json: bool,
    ui: bool,
    style: &crate::Style,
) -> Result<(), String> {
    if json {
        println!("{}", serde_json::to_string(&catalog.document).unwrap());
        return Ok(());
    }
    let selected = if let Some(id) = open {
        catalog.select(id)?
    } else {
        catalog.print();
        if catalog.document.threads.is_empty() {
            return Ok(());
        }
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            println!("Use tress threads {} --open <thread-id> with the same authentication to continue a conversation.", catalog.origin);
            return Ok(());
        }
        print!("\nOpen thread number (Enter to leave): ");
        std::io::stdout().flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        std::io::stdin()
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            return Ok(());
        }
        let index = line
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|n| n.checked_sub(1))
            .ok_or("Choose a listed thread number.")?;
        let thread = catalog
            .document
            .threads
            .get(index)
            .ok_or("Choose a listed thread number.")?;
        catalog.select(&thread.id)?
    };
    super::run_catalog(&selected, style, ui, connector, catalog).await
}

/// Application origins discover the complete permitted list on ordinary attach.
/// A direct thread URL or legacy Tress site still follows its existing path.
pub async fn attach(
    app: &str,
    style: &crate::Style,
    ui: bool,
    file: Option<&str>,
    variable: Option<&str>,
) -> Result<bool, String> {
    let origin = reqwest::Url::parse(app).map_err(|_| "Invalid application URL")?;
    if !matches!(origin.path(), "" | "/") || origin.query().is_some() || origin.fragment().is_some()
    {
        if variable.is_some() {
            return Err("Use the application origin with --api-key-env.".into());
        }
        return Ok(false);
    }
    if !matches!(origin.scheme(), "http" | "https")
        || !origin.username().is_empty()
        || origin.password().is_some()
    {
        return Err("Use an HTTP(S) application origin without URL credentials.".into());
    }
    let connector = Connector::with_api_key_env(app, file, variable)?;
    let Some(discovery) = connector
        .discovery(
            origin.join("/.well-known/tress.json").unwrap().as_str(),
            variable.is_none(),
        )
        .await?
    else {
        if variable.is_some() {
            return Err("This application does not expose /.well-known/tress.json.".into());
        }
        return Ok(false);
    };
    let manifest =
        serde_json::from_value(discovery).map_err(|_| "Invalid Tress discovery document.")?;
    let mut catalog = Catalog::from_manifest(origin, manifest)?;
    catalog.refresh(&connector).await?;
    browse(catalog, connector, None, false, ui, style).await?;
    Ok(true)
}

pub fn extract_key_env(args: &[String]) -> Result<(Vec<String>, Option<String>), String> {
    let mut rest = Vec::new();
    let mut variable = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if arg == "--api-key-env" {
            if variable.is_some() {
                return Err("Provide --api-key-env only once.".into());
            }
            variable = Some(
                args.next()
                    .filter(|value| !value.starts_with('-'))
                    .ok_or("--api-key-env needs a variable name")?
                    .clone(),
            );
        } else {
            rest.push(arg.clone());
        }
    }
    Ok((rest, variable))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(template: &str) -> Result<Catalog, String> {
        Catalog::from_manifest(
            reqwest::Url::parse("https://app.example").unwrap(),
            Manifest {
                version: 1,
                threads: "/api/thread-list".into(),
                thread: template.into(),
            },
        )
    }

    #[test]
    fn discovery_cannot_redirect_credentials_or_escape_thread_paths() {
        for template in [
            "https://other.example/{id}",
            "https://user:pass@app.example/{id}",
            "/api/{id}?key=secret",
            "/api/{id}#fragment",
            "/api/static",
            "https://{id}.example/api/thread",
        ] {
            assert!(catalog(template).is_err(), "{template}");
        }
        let c = catalog("/api/threads/{id}").unwrap();
        for id in [
            "..",
            ".",
            "../private",
            "a/b",
            "a%2fb",
            "a?query",
            "a#fragment",
            "\x1b",
        ] {
            assert!(c.thread_url(id).is_err());
        }
        assert_eq!(
            c.thread_url("thread-123").unwrap(),
            "https://app.example/api/threads/thread-123"
        );
        assert!(c.select("thread-123").is_err());
    }
}
