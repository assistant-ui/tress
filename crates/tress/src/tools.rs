//! Tools the agent can call.
//!
//! The [`Tools`] trait is the seam that keeps the engine portable: the
//! native implementation below uses the real filesystem and shell, while a
//! wasm or embedded build supplies its own. Approval policy lives in the
//! engine, not here.

#[cfg(not(target_arch = "wasm32"))]
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// One tool's result, returned to the model.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutcome {
    pub content: String,
    pub is_error: bool,
}

impl ToolOutcome {
    pub fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
        }
    }

    pub fn error(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
        }
    }
}

/// The tool surface an engine drives.
#[allow(async_fn_in_trait)]
pub trait Tools {
    /// Tool definitions in Claude API shape: `name`, `description`,
    /// `input_schema`.
    fn schemas(&self) -> Vec<Value>;

    /// Whether a call needs the user's approval before running.
    fn needs_approval(&self, name: &str, input: &Value) -> bool;

    /// Runs one tool call.
    fn execute(&mut self, _name: &str, _input: &Value) -> ToolOutcome {
        ToolOutcome::error("This tool requires asynchronous execution.")
    }

    /// Override for remote I/O or host callbacks. Existing synchronous
    /// implementations continue to work without changes.
    async fn execute_async(&mut self, name: &str, input: &Value) -> ToolOutcome {
        self.execute(name, input)
    }

    /// A one-line human summary of a call, for the UI.
    fn describe(&self, name: &str, input: &Value) -> String {
        let arg = ["path", "command"]
            .iter()
            .find_map(|key| input.get(*key).and_then(Value::as_str))
            .unwrap_or("");
        format!("{name} {arg}").trim_end().to_owned()
    }
}

/// Output larger than this is truncated before it reaches the model.
const MAX_TOOL_OUTPUT: usize = 30_000;

/// Tool definitions shared by every surface, minus the ones a surface
/// cannot offer.
pub(crate) fn schemas_for(shell: bool) -> Vec<Value> {
    let object = |properties: Value, required: Value| json!({"type": "object", "properties": properties, "required": required});
    let mut schemas = vec![
        json!({
            "name": "read",
            "description": "Read a file. Returns its full contents.",
            "input_schema": object(json!({"path": {"type": "string"}}), json!(["path"])),
        }),
        json!({
            "name": "write",
            "description": "Create or overwrite a file with the given contents.",
            "input_schema": object(
                json!({"path": {"type": "string"}, "content": {"type": "string"}}),
                json!(["path", "content"]),
            ),
        }),
        json!({
            "name": "edit",
            "description": "Replace an exact string in a file. `old` must occur exactly once; include surrounding lines to disambiguate.",
            "input_schema": object(
                json!({"path": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"}}),
                json!(["path", "old", "new"]),
            ),
        }),
        json!({
            "name": "ls",
            "description": "List a directory. Defaults to the workspace root.",
            "input_schema": object(json!({"path": {"type": "string"}}), json!([])),
        }),
    ];
    if shell {
        schemas.push(json!({
            "name": "bash",
            "description": "Run a shell command in the workspace root and return its output. The user approves each command.",
            "input_schema": object(json!({"command": {"type": "string"}}), json!(["command"])),
        }));
    }
    schemas
}

/// Filesystem and shell tools rooted at one directory.
///
/// File tools refuse paths that resolve outside the root. `bash` runs
/// through `sh -c` in the root and always needs approval.
#[cfg(not(target_arch = "wasm32"))]
pub struct NativeTools {
    root: PathBuf,
}

#[cfg(not(target_arch = "wasm32"))]
impl NativeTools {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let root = self
            .root
            .canonicalize()
            .map_err(|error| format!("workspace root: {error}"))?;
        let joined = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            root.join(path)
        };

        let mut normalized = PathBuf::new();
        for component in joined.components() {
            match component {
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                std::path::Component::CurDir => {}
                other => normalized.push(other.as_os_str()),
            }
        }
        if !normalized.starts_with(&root) {
            return Err(format!("{path}: outside the workspace"));
        }

        // A symlink inside the root can still point out of it, and the
        // target may not exist yet, so check the deepest ancestor that does.
        let mut existing = normalized.as_path();
        while !existing.exists() {
            match existing.parent() {
                Some(parent) => existing = parent,
                None => break,
            }
        }
        if existing
            .canonicalize()
            .is_ok_and(|real| !real.starts_with(&root))
        {
            return Err(format!("{path}: outside the workspace"));
        }
        Ok(normalized)
    }
}

pub(crate) fn truncated(mut text: String) -> String {
    if text.len() > MAX_TOOL_OUTPUT {
        let mut cut = MAX_TOOL_OUTPUT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n[output truncated]");
    }
    text
}

#[cfg(not(target_arch = "wasm32"))]
impl Tools for NativeTools {
    fn schemas(&self) -> Vec<Value> {
        schemas_for(true)
    }

    fn needs_approval(&self, name: &str, _input: &Value) -> bool {
        name == "bash"
    }

    fn execute(&mut self, name: &str, input: &Value) -> ToolOutcome {
        let text_arg = |key: &str| {
            input
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("missing {key}"))
        };
        let result = match name {
            "read" => text_arg("path").and_then(|path| {
                let resolved = self.resolve(path)?;
                std::fs::read_to_string(&resolved).map_err(|error| format!("{path}: {error}"))
            }),
            "write" => text_arg("path").and_then(|path| {
                let content = text_arg("content")?;
                let resolved = self.resolve(path)?;
                if let Some(parent) = resolved.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| format!("{path}: {error}"))?;
                }
                std::fs::write(&resolved, content)
                    .map(|()| format!("wrote {} bytes to {path}", content.len()))
                    .map_err(|error| format!("{path}: {error}"))
            }),
            "edit" => text_arg("path").and_then(|path| {
                let old = text_arg("old")?;
                let new = text_arg("new")?;
                let resolved = self.resolve(path)?;
                let text = std::fs::read_to_string(&resolved)
                    .map_err(|error| format!("{path}: {error}"))?;
                match text.matches(old).count() {
                    0 => Err(format!("{path}: `old` not found")),
                    1 => {
                        let updated = text.replacen(old, new, 1);
                        std::fs::write(&resolved, updated)
                            .map(|()| format!("edited {path}"))
                            .map_err(|error| format!("{path}: {error}"))
                    }
                    n => Err(format!("{path}: `old` occurs {n} times; add context")),
                }
            }),
            "ls" => {
                let path = input.get("path").and_then(Value::as_str).unwrap_or(".");
                self.resolve(path).and_then(|resolved| {
                    let mut names: Vec<String> = std::fs::read_dir(&resolved)
                        .map_err(|error| format!("{path}: {error}"))?
                        .filter_map(|entry| entry.ok())
                        .map(|entry| {
                            let mut name = entry.file_name().to_string_lossy().into_owned();
                            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                                name.push('/');
                            }
                            name
                        })
                        .collect();
                    names.sort();
                    Ok(names.join("\n"))
                })
            }
            "bash" => text_arg("command").and_then(|command| {
                let output = std::process::Command::new("sh")
                    .arg("-c")
                    .arg(command)
                    .current_dir(&self.root)
                    .output()
                    .map_err(|error| format!("sh: {error}"))?;
                let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stderr.trim().is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(&stderr);
                }
                if !output.status.success() {
                    text.push_str(&format!("\n[exit status: {}]", output.status));
                }
                Ok(text)
            }),
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

    fn tools() -> (NativeTools, tempdir::TempDir) {
        let dir = tempdir::TempDir::new().unwrap();
        (NativeTools::new(dir.path().to_owned()), dir)
    }

    mod tempdir {
        use std::path::{Path, PathBuf};

        pub struct TempDir(PathBuf);

        impl TempDir {
            pub fn new() -> std::io::Result<Self> {
                let path = std::env::temp_dir().join(format!(
                    "tress-test-{}-{:?}",
                    std::process::id(),
                    std::time::Instant::now()
                ));
                std::fs::create_dir_all(&path)?;
                Ok(Self(path))
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn write_read_edit_round_trip() {
        let (mut tools, _dir) = tools();
        let write = tools.execute(
            "write",
            &serde_json::json!({"path": "src/a.txt", "content": "hello world"}),
        );
        assert!(!write.is_error, "{}", write.content);
        let edit = tools.execute(
            "edit",
            &serde_json::json!({"path": "src/a.txt", "old": "world", "new": "tress"}),
        );
        assert!(!edit.is_error, "{}", edit.content);
        let read = tools.execute("read", &serde_json::json!({"path": "src/a.txt"}));
        assert_eq!(read.content, "hello tress");
    }

    #[test]
    fn edit_rejects_ambiguous_and_missing() {
        let (mut tools, _dir) = tools();
        tools.execute(
            "write",
            &serde_json::json!({"path": "b.txt", "content": "aa aa"}),
        );
        let ambiguous = tools.execute(
            "edit",
            &serde_json::json!({"path": "b.txt", "old": "aa", "new": "x"}),
        );
        assert!(ambiguous.is_error);
        let missing = tools.execute(
            "edit",
            &serde_json::json!({"path": "b.txt", "old": "zz", "new": "x"}),
        );
        assert!(missing.is_error);
    }

    #[test]
    fn paths_outside_the_root_are_refused() {
        let (mut tools, _dir) = tools();
        let outcome = tools.execute("read", &serde_json::json!({"path": "../../etc/hosts"}));
        assert!(outcome.is_error);
        assert!(outcome.content.contains("outside the workspace"));
    }

    #[test]
    fn bash_runs_and_needs_approval() {
        let (mut tools, _dir) = tools();
        assert!(tools.needs_approval("bash", &serde_json::json!({"command": "true"})));
        assert!(!tools.needs_approval("read", &serde_json::json!({"path": "x"})));
        let outcome = tools.execute("bash", &serde_json::json!({"command": "echo hi"}));
        assert_eq!(outcome.content.trim(), "hi");
        let failing = tools.execute("bash", &serde_json::json!({"command": "exit 3"}));
        assert!(failing.content.contains("exit status"));
    }

    #[test]
    fn ls_lists_sorted_with_dir_markers() {
        let (mut tools, _dir) = tools();
        tools.execute(
            "write",
            &serde_json::json!({"path": "z.txt", "content": ""}),
        );
        tools.execute(
            "write",
            &serde_json::json!({"path": "sub/a.txt", "content": ""}),
        );
        let outcome = tools.execute("ls", &serde_json::json!({}));
        assert_eq!(outcome.content, "sub/\nz.txt");
    }

    #[test]
    fn long_output_is_truncated() {
        assert!(truncated("x".repeat(40_000)).ends_with("[output truncated]"));
    }
}
