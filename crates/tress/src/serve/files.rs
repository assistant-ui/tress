//! Read the machine's workspace through the same scoped handles as the connector.
use std::io::Read;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::Shared;
use crate::connect::{open_regular_file, safe_path};

const MAX_DOWNLOAD: u64 = 32 * 1024 * 1024;

#[derive(Deserialize)]
pub(super) struct FileQuery {
    session: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    preview: bool,
}

pub(super) async fn browse(State(host): State<Shared>, Query(query): Query<FileQuery>) -> Response {
    if query.session != host.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let root = host.files.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let path = safe_path(&root, &query.path, true, None)?;
        let mut entries = Vec::new();
        for entry in root.read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if !kind.is_file() && !kind.is_dir() { continue; }
            entries.push(json!({"name":entry.file_name().to_string_lossy(), "type":if kind.is_dir() {"directory"} else {"file"}, "size":entry.metadata().map_err(|e| e.to_string())?.len()}));
            if entries.len() > 1000 { return Err("This directory has more than 1,000 entries. Open a smaller project folder.".into()); }
        }
        entries.sort_by(|a,b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(json!({"path":query.path,"entries":entries}))
    }).await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub(super) async fn download(
    State(host): State<Shared>,
    Query(query): Query<FileQuery>,
) -> Response {
    if query.session != host.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let root = host.files.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Response, String> {
        let path = safe_path(&root, &query.path, false, None)?;
        let file = open_regular_file(&root, &path, false)?;
        let limit = if query.preview {
            1024 * 1024
        } else {
            MAX_DOWNLOAD
        };
        if file.metadata().map_err(|e| e.to_string())?.len() > limit {
            return Err(if query.preview {
                "Preview is limited to 1 MiB. Download the file instead."
            } else {
                "Downloads are limited to 32 MiB. Open larger files directly on the host."
            }
            .into());
        }
        let mut bytes = Vec::new();
        file.take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > limit {
            return Err("File grew beyond the size limit.".into());
        }
        if query.preview {
            let content = String::from_utf8(bytes)
                .map_err(|_| "Binary file. Download it to open in a suitable application.")?;
            return Ok(Json(json!({"path":query.path,"content":content})).into_response());
        }
        // Always download untrusted workspace bytes. Never serve HTML/SVG as
        // executable content on the authenticated host origin.
        let name = path.file_name().unwrap().to_string_lossy();
        let encoded: String = name
            .as_bytes()
            .iter()
            .map(|b| format!("%{b:02X}"))
            .collect();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            "application/octet-stream".parse().unwrap(),
        );
        headers.insert(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename*=UTF-8''{encoded}")
                .parse()
                .unwrap(),
        );
        Ok((headers, bytes).into_response())
    })
    .await;
    match result {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
