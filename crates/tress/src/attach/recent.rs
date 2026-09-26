//! A small, private list of threads this terminal has attached to.

use std::{fs, io, path::PathBuf};

use serde::{Deserialize, Serialize};

const LIMIT: usize = 20;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RecentThread {
    pub url: String,
    pub title: String,
}

pub struct RecentThreads {
    path: Option<PathBuf>,
    pub items: Vec<RecentThread>,
}

pub fn attach_command(input: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(input) else {
        return String::new();
    };
    if let Some(id) = url.path().strip_prefix("/api/sessions/").map(str::to_owned) {
        if !id.contains('/') {
            url.set_path("");
            return format!(
                "tress attach {} -s {id}",
                url.as_str().trim_end_matches('/')
            );
        }
    }
    format!("tress attach {url}")
}

pub fn location(input: &str) -> String {
    attach_command(input)
        .trim_start_matches("tress attach ")
        .replace(" -s ", " · ")
}

fn valid_url(input: &str) -> bool {
    !input.chars().any(char::is_control)
        && reqwest::Url::parse(input).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        })
}

fn title_text(input: &str) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect()
}

fn fallback_title(input: &str) -> String {
    reqwest::Url::parse(input)
        .ok()
        .and_then(|url| {
            url.path()
                .strip_prefix("/api/sessions/")
                .map(|id| format!("Thread {}", id.chars().take(12).collect::<String>()))
        })
        .unwrap_or_else(|| location(input))
}

impl RecentThreads {
    pub fn load() -> Self {
        let path = std::env::var_os("XDG_STATE_HOME")
            .filter(|value| PathBuf::from(value).is_absolute())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
            })
            .map(|root| root.join("tress/threads.json"));
        Self::from_path(path)
    }

    fn from_path(path: Option<PathBuf>) -> Self {
        let mut items: Vec<RecentThread> = path
            .as_ref()
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        items.retain(|item| valid_url(&item.url));
        items.truncate(LIMIT);
        for item in &mut items {
            item.title = title_text(&item.title);
        }
        Self { path, items }
    }

    /// Keep the current thread first. Never store conversation text beyond its title.
    pub fn remember(&mut self, url: &str, title: Option<&str>) -> bool {
        if !valid_url(url) {
            return false;
        }
        let previous = self.items.iter().position(|item| item.url == url);
        let title = title
            .filter(|title| !title.trim().is_empty())
            .map(title_text)
            .or_else(|| previous.map(|index| self.items[index].title.clone()))
            .unwrap_or_else(|| fallback_title(url));
        let item = RecentThread {
            url: url.to_owned(),
            title,
        };
        if previous == Some(0) && self.items.first() == Some(&item) {
            return false;
        }
        self.items.retain(|item| item.url != url);
        self.items.insert(0, item);
        self.items.truncate(LIMIT);
        true
    }

    pub fn save(&self) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let parent = path.parent().unwrap();
        fs::create_dir_all(parent)?;
        // Pick up visits from other terminals before updating this one.
        let mut saved = Self::from_path(self.path.clone());
        for item in self.items.iter().skip(1) {
            if !saved.items.iter().any(|existing| existing.url == item.url) {
                saved.items.push(item.clone());
            }
        }
        if let Some(current) = self.items.first() {
            saved.remember(&current.url, Some(&current.title));
        }
        saved.items.truncate(LIMIT);
        // Attach IDs grant access to a thread, so keep this file private.
        let temporary = parent.join(format!(
            "threads.{}.tmp",
            statewire::transport::http::generate_client_id()
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let result = (|| {
            use io::Write;
            file.write_all(&serde_json::to_vec(&saved.items)?)?;
            fs::rename(&temporary, path)
        })();
        // Only remove our temporary file after it was successfully opened.
        if result.is_err() && temporary.exists() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recents_are_bounded_deduplicated_and_do_not_store_url_credentials() {
        let mut recent = RecentThreads::from_path(None);
        for n in 0..25 {
            recent.remember(&format!("https://example.com/api/sessions/{n:012}"), None);
        }
        assert_eq!(recent.items.len(), LIMIT);
        let url = recent.items[4].url.clone();
        assert!(recent.remember(&url, Some("A title\nwith whitespace")));
        assert_eq!(recent.items[0].title, "A title with whitespace");
        assert!(!recent.remember(&url, None));
        assert!(!recent.remember("https://user:secret@example.com/api/thread", None));
        assert!(!recent.remember("https://example.com/api/thread?token=secret", None));
        assert!(!recent.remember("https://example.com/\x1b[31m", None));
        assert!(!title_text("unsafe \x1b[31m title").contains('\x1b'));
        assert_eq!(
            recent.items.iter().filter(|item| item.url == url).count(),
            1
        );
    }

    #[test]
    fn attach_commands_keep_the_short_session_flag() {
        assert_eq!(
            attach_command("https://example.com/api/sessions/abcdefghijkl"),
            "tress attach https://example.com -s abcdefghijkl"
        );
        assert_eq!(
            attach_command("http://localhost:5311/api/thread"),
            "tress attach http://localhost:5311/api/thread"
        );
    }

    #[test]
    fn private_recents_survive_reopening() {
        let root = std::env::temp_dir().join(format!(
            "tress-recents-{}",
            statewire::transport::http::generate_client_id()
        ));
        let path = root.join("threads.json");
        let mut recent = RecentThreads::from_path(Some(path.clone()));
        recent.remember(
            "https://example.com/api/sessions/abcdefghijkl",
            Some("My thread"),
        );
        recent.save().unwrap();
        assert_eq!(
            RecentThreads::from_path(Some(path.clone())).items,
            recent.items
        );
        let mut other = RecentThreads::from_path(Some(path.clone()));
        other.remember(
            "https://example.com/api/sessions/bbbbbbbbbbbb",
            Some("Another terminal"),
        );
        other.save().unwrap();
        recent.remember(
            "https://example.com/api/sessions/cccccccccccc",
            Some("Latest thread"),
        );
        recent.save().unwrap();
        assert_eq!(RecentThreads::from_path(Some(path.clone())).items.len(), 3);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
