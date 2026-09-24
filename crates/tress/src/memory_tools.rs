//! An in-memory workspace.
//!
//! [`MemoryTools`] implements the same [`Tools`] surface as the native one
//! without touching the filesystem or spawning a process, so it runs
//! anywhere the core runs — a browser build, a sandbox, a test. It offers no
//! `bash`: a surface advertises only the tools it can honor.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::tools::{schemas_for, truncated, ToolOutcome, Tools};

/// A flat map of path to contents, with `read`, `write`, `edit`, and `ls`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MemoryTools {
    files: BTreeMap<String, String>,
}

impl MemoryTools {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seeds the workspace with existing files.
    pub fn with_files<K: Into<String>, V: Into<String>>(
        files: impl IntoIterator<Item = (K, V)>,
    ) -> Self {
        Self {
            files: files
                .into_iter()
                .map(|(path, content)| (normalize(&path.into()), content.into()))
                .collect(),
        }
    }

    pub fn get(&self, path: &str) -> Option<&str> {
        self.files.get(&normalize(path)).map(String::as_str)
    }

    pub fn insert(&mut self, path: impl Into<String>, content: impl Into<String>) {
        self.files.insert(normalize(&path.into()), content.into());
    }

    /// Every path in the workspace, sorted.
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.files.keys().map(String::as_str)
    }
}

/// Strips `./` and leading slashes so lookups agree however a path is typed.
fn normalize(path: &str) -> String {
    path.trim_start_matches("./")
        .trim_start_matches('/')
        .to_owned()
}

impl Tools for MemoryTools {
    fn schemas(&self) -> Vec<Value> {
        schemas_for(false)
    }

    fn needs_approval(&self, _name: &str, _input: &Value) -> bool {
        false
    }

    fn execute(&mut self, name: &str, input: &Value) -> ToolOutcome {
        let arg = |key: &str| {
            input
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("missing {key}"))
        };
        let result = match name {
            "read" => arg("path").and_then(|path| {
                self.get(path)
                    .map(str::to_owned)
                    .ok_or_else(|| format!("{path}: not found"))
            }),
            "write" => arg("path").and_then(|path| {
                let content = arg("content")?;
                self.insert(path, content);
                Ok(format!("wrote {} bytes to {path}", content.len()))
            }),
            "edit" => arg("path").and_then(|path| {
                let old = arg("old")?;
                let new = arg("new")?;
                let text = self
                    .get(path)
                    .ok_or_else(|| format!("{path}: not found"))?
                    .to_owned();
                match text.matches(old).count() {
                    0 => Err(format!("{path}: `old` not found")),
                    1 => {
                        self.insert(path, text.replacen(old, new, 1));
                        Ok(format!("edited {path}"))
                    }
                    n => Err(format!("{path}: `old` occurs {n} times; add context")),
                }
            }),
            "ls" => {
                let prefix = normalize(input.get("path").and_then(Value::as_str).unwrap_or(""));
                let mut names: Vec<String> = self
                    .files
                    .keys()
                    .filter_map(|path| {
                        let rest = if prefix.is_empty() {
                            Some(path.as_str())
                        } else {
                            path.strip_prefix(&prefix)?.strip_prefix('/')
                        }?;
                        Some(match rest.split_once('/') {
                            Some((dir, _)) => format!("{dir}/"),
                            None => rest.to_owned(),
                        })
                    })
                    .collect();
                names.dedup();
                Ok(names.join("\n"))
            }
            _ => Err(format!("unknown tool {name}")),
        };
        match result {
            Ok(content) => ToolOutcome::ok(truncated(content)),
            Err(message) => ToolOutcome::error(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn offers_no_shell() {
        let names: Vec<String> = MemoryTools::new()
            .schemas()
            .iter()
            .map(|schema| schema["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(names, ["read", "write", "edit", "ls"]);
        assert!(!MemoryTools::new().needs_approval("write", &json!({})));
    }

    #[test]
    fn write_read_edit_round_trip() {
        let mut tools = MemoryTools::new();
        assert!(
            !tools
                .execute("write", &json!({"path": "a.txt", "content": "hello world"}))
                .is_error
        );
        assert!(
            !tools
                .execute(
                    "edit",
                    &json!({"path": "a.txt", "old": "world", "new": "tress"})
                )
                .is_error
        );
        assert_eq!(
            tools.execute("read", &json!({"path": "a.txt"})).content,
            "hello tress"
        );
    }

    #[test]
    fn seeded_files_are_readable_however_the_path_is_typed() {
        let mut tools = MemoryTools::with_files([("src/main.rs", "fn main() {}")]);
        for path in ["src/main.rs", "./src/main.rs", "/src/main.rs"] {
            assert_eq!(
                tools.execute("read", &json!({"path": path})).content,
                "fn main() {}",
                "{path}"
            );
        }
    }

    #[test]
    fn missing_and_ambiguous_edits_are_errors() {
        let mut tools = MemoryTools::with_files([("a.txt", "aa aa")]);
        assert!(tools.execute("read", &json!({"path": "nope.txt"})).is_error);
        assert!(
            tools
                .execute("edit", &json!({"path": "a.txt", "old": "aa", "new": "x"}))
                .is_error
        );
        assert!(
            tools
                .execute("edit", &json!({"path": "a.txt", "old": "zz", "new": "x"}))
                .is_error
        );
    }

    #[test]
    fn ls_collapses_directories() {
        let mut tools =
            MemoryTools::with_files([("src/main.rs", ""), ("src/lib.rs", ""), ("README.md", "")]);
        assert_eq!(tools.execute("ls", &json!({})).content, "README.md\nsrc/");
        assert_eq!(
            tools.execute("ls", &json!({"path": "src"})).content,
            "lib.rs\nmain.rs"
        );
    }
}
