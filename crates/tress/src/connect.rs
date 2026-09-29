//! An explicitly rooted file connector for the public site. Harness and model
//! credentials remain on the site; this process receives only scoped file jobs.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use cap_std::ambient_authority;
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};

#[derive(Debug)]
struct Options {
    site: reqwest::Url,
    root: PathBuf,
    label: String,
    writable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Offer<'a> {
    label: &'a str,
    root_label: &'a str,
    writable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Offered {
    code: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Poll {
    paired: bool,
    job: Option<Job>,
}

#[derive(Deserialize)]
struct Job {
    id: String,
    operation: String,
    path: String,
    content: Option<String>,
}

#[derive(Serialize)]
struct ResultBody<'a> {
    id: &'a str,
    result: JobResult,
}

#[derive(Serialize)]
struct JobResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
}

fn options(args: &[String]) -> Result<Options, String> {
    let mut site = None;
    let mut root = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut label = None;
    let mut writable = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--site" | "--root" | "--label" => {
                let key = args[index].as_str();
                let value = args.get(index + 1).ok_or(format!("{key} needs a value"))?;
                match key {
                    "--site" => site = Some(value.clone()),
                    "--root" => root = PathBuf::from(value),
                    _ => label = Some(value.clone()),
                }
                index += 2;
            }
            "--allow-write" => {
                writable = true;
                index += 1;
            }
            _ => return Err(format!("unknown option: {}", args[index])),
        }
    }
    let site = site.ok_or("use --site <https-url> to name the public Tress site")?;
    let parsed = reqwest::Url::parse(&site).map_err(|_| "invalid site URL")?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"));
    if (parsed.scheme() != "https" && !(local && parsed.scheme() == "http"))
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err("site must be an HTTPS origin (HTTP is allowed only for localhost)".into());
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("workspace root: {error}"))?;
    if !root.is_dir() {
        return Err("workspace root must be a directory".into());
    }
    let label = label.unwrap_or_else(|| {
        root.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "local folder".into())
    });
    if label.trim().is_empty() || label.len() > 80 {
        return Err("label must be 1–80 characters".into());
    }
    Ok(Options {
        site: parsed,
        root,
        label,
        writable,
    })
}

fn safe_path(root: &Dir, path: &str, directory: bool) -> Result<PathBuf, String> {
    if path.len() > 1024 || path.contains('\0') {
        return Err("invalid file path".into());
    }
    if path.is_empty() && directory {
        return Ok(PathBuf::from("."));
    }
    let relative = Path::new(path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("path must stay inside the connected folder".into());
    }
    let mut current = PathBuf::new();
    for part in relative.components() {
        current.push(part.as_os_str());
        match root.symlink_metadata(&current) {
            Ok(info) if info.file_type().is_symlink() => {
                return Err("symlinks are not available through a connected folder".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(current)
}

fn execute(root: &Dir, writable: bool, job: &Job) -> JobResult {
    let result: Result<serde_json::Value, String> = (|| match job.operation.as_str() {
        "read" => {
            let path = safe_path(root, &job.path, false)?;
            let metadata = root.metadata(&path).map_err(|error| error.to_string())?;
            if !metadata.is_file() {
                return Err("only regular files can be read".into());
            }
            if metadata.len() > 1_048_576 {
                return Err("file exceeds the 1 MB read limit".into());
            }
            let file = root.open(path).map_err(|error| error.to_string())?;
            let mut content = String::new();
            file.take(1_048_577)
                .read_to_string(&mut content)
                .map_err(|error| error.to_string())?;
            if content.len() > 1_048_576 {
                return Err("file exceeds the 1 MB read limit".into());
            }
            Ok(serde_json::Value::String(content))
        }
        "list" => {
            let path = safe_path(root, &job.path, true)?;
            let mut entries = Vec::new();
            for entry in root.read_dir(path).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let kind = entry.file_type().map_err(|error| error.to_string())?;
                if kind.is_symlink() {
                    continue;
                }
                entries.push(Entry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    kind: if kind.is_dir() { "directory" } else { "file" },
                });
                if entries.len() > 1000 {
                    return Err("directory has too many entries".into());
                }
            }
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            serde_json::to_value(entries).map_err(|error| error.to_string())
        }
        "write" => {
            if !writable {
                return Err("this connection is read-only".into());
            }
            let content = job.content.as_deref().ok_or("missing file content")?;
            if content.len() > 1_048_576 {
                return Err("file exceeds the 1 MB write limit".into());
            }
            let path = safe_path(root, &job.path, false)?;
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            if root.open_dir(parent).is_err() {
                return Err("parent directory does not exist".into());
            }
            root.write(path, content)
                .map_err(|error| error.to_string())?;
            Ok(serde_json::Value::String(format!("Wrote {}", job.path)))
        }
        _ => Err("unsupported local operation".into()),
    })();
    match result {
        Ok(value) => JobResult {
            ok: true,
            value: Some(value),
            error: None,
        },
        Err(error) => JobResult {
            ok: false,
            value: None,
            error: Some(error),
        },
    }
}

pub async fn run(args: &[String]) -> Result<(), String> {
    let options = options(args)?;
    // All file operations use this open directory capability, including when
    // a path is replaced with a symlink between validation and I/O.
    let root = Dir::open_ambient_dir(&options.root, ambient_authority())
        .map_err(|error| format!("workspace root: {error}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let endpoint = |name: &str| {
        options
            .site
            .join(&format!("api/connect/{name}"))
            .expect("validated site origin")
    };
    let root_label = options
        .root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".into());
    let response = client
        .post(endpoint("offer"))
        .json(&Offer {
            label: &options.label,
            root_label: &root_label,
            writable: options.writable,
        })
        .send()
        .await
        .map_err(|error| format!("cannot reach site: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "site refused connection offer: {}",
            response.status()
        ));
    }
    let offered: Offered = response.json().await.map_err(|error| error.to_string())?;
    println!("Pair this folder at {}", options.site);
    println!("Code: {} (expires in 5 minutes)", offered.code);
    println!("Folder: {}", options.root.display());
    println!(
        "Access: {}",
        if options.writable {
            "read and write"
        } else {
            "read-only"
        }
    );
    println!("Anyone with this thread's private attach link can ask the agent to use this folder.");
    println!(
        "File contents read by the agent may be sent to the model provider and Harness Cloud."
    );
    println!("No Harness key is stored here. Press Ctrl-C to disconnect.\n");
    let mut paired = false;
    let mut failures = 0u32;
    loop {
        let response = client
            .post(endpoint("poll"))
            .bearer_auth(&offered.token)
            .send()
            .await;
        let response = match response {
            Ok(response) if !response.status().is_server_error() => {
                if failures > 0 {
                    println!("Site connection restored.");
                    failures = 0;
                }
                response
            }
            _ => {
                if failures == 0 {
                    eprintln!("Site connection interrupted; retrying without a new pairing code.");
                }
                failures = failures.saturating_add(1);
                tokio::time::sleep(Duration::from_secs(1_u64 << failures.min(4))).await;
                continue;
            }
        };
        if response.status() == reqwest::StatusCode::GONE {
            return Err("pairing expired or this connection was revoked".into());
        }
        if !response.status().is_success() {
            return Err(format!("connection rejected: {}", response.status()));
        }
        let poll: Poll = response.json().await.map_err(|error| error.to_string())?;
        if poll.paired && !paired {
            println!("Connected. Browser requests can now use this folder.");
            paired = true;
        }
        if let Some(job) = poll.job {
            let body = ResultBody {
                id: &job.id,
                result: execute(&root, options.writable, &job),
            };
            // A result POST is idempotent. Do not fetch another job until it is acknowledged.
            loop {
                match client
                    .post(endpoint("result"))
                    .bearer_auth(&offered.token)
                    .json(&body)
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => break,
                    Ok(response) if response.status() == reqwest::StatusCode::GONE => {
                        return Err("connection was revoked".into())
                    }
                    Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => {
                        eprintln!("A file result arrived after its request expired; reconnecting.");
                        break;
                    }
                    Ok(response) if response.status().is_client_error() => {
                        return Err(format!(
                            "site rejected a file result: {}",
                            response.status()
                        ))
                    }
                    _ => tokio::time::sleep(Duration::from_secs(1)).await,
                }
            }
        } else {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn root() -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("tress-connect-test-{}-{id}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn file_jobs_are_rooted_and_writes_need_opt_in() {
        let path = root();
        std::fs::write(path.join("note.txt"), "hello").unwrap();
        let root = Dir::open_ambient_dir(&path, ambient_authority()).unwrap();
        let read = Job {
            id: "1".into(),
            operation: "read".into(),
            path: "note.txt".into(),
            content: None,
        };
        assert_eq!(
            execute(&root, false, &read).value,
            Some(serde_json::json!("hello"))
        );
        let write = Job {
            id: "2".into(),
            operation: "write".into(),
            path: "note.txt".into(),
            content: Some("changed".into()),
        };
        assert!(!execute(&root, false, &write).ok);
        assert!(execute(&root, true, &write).ok);
        assert_eq!(
            std::fs::read_to_string(path.join("note.txt")).unwrap(),
            "changed"
        );
        std::fs::write(path.join("large.txt"), vec![b'a'; 1_048_577]).unwrap();
        assert!(
            !execute(
                &root,
                false,
                &Job {
                    id: "3".into(),
                    operation: "read".into(),
                    path: "large.txt".into(),
                    content: None,
                }
            )
            .ok
        );
        assert!(
            !execute(
                &root,
                true,
                &Job {
                    path: "../outside".into(),
                    ..read
                }
            )
            .ok
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed() {
        use std::os::unix::fs::symlink;
        let path = root();
        symlink("/etc", path.join("escape")).unwrap();
        let root = Dir::open_ambient_dir(&path, ambient_authority()).unwrap();
        let job = Job {
            id: "1".into(),
            operation: "read".into(),
            path: "escape/passwd".into(),
            content: None,
        };
        assert!(!execute(&root, false, &job).ok);
        std::fs::remove_dir_all(path).unwrap();
    }
}
