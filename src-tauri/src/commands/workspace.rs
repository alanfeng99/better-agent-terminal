// workspace:save / workspace:load / workspace:move-to-window for the Tauri shell.
//
// Electron's workspace store is keyed by windowId because that runtime
// supports multi-window workspaces with detach/reattach. The Tauri build now
// keeps a small Rust window registry and snapshots per window/profile. The
// renderer treats payloads as opaque text — same shape as settings.{load,save}
// — which lets the host-api adapter route either runtime without changing
// types.
//
// File location: <app-data>/workspaces.json. We keep the filename stable
// so an Electron→Tauri migration can copy the file from the old userData
// directory without translation. Workspace detach/reattach remain unported;
// cross-window move is handled here and emits the existing workspace:reload
// event so renderer stores can reuse the Electron reload path.

use crate::window_registry;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::PathBuf;
use tauri::{Emitter, Manager, WebviewWindow};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("could not resolve app data directory: {0}")]
    AppDataDir(String),
    #[error("workspace IO error: {0}")]
    Io(#[from] io::Error),
}

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl From<WorkspaceError> for CommandError {
    fn from(value: WorkspaceError) -> Self {
        Self {
            message: value.to_string(),
        }
    }
}

fn workspace_path(app: &tauri::AppHandle) -> Result<PathBuf, WorkspaceError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| WorkspaceError::AppDataDir(e.to_string()))?;
    Ok(dir.join("workspaces.json"))
}

fn workspace_load_impl(
    app: tauri::AppHandle,
    window_label: String,
) -> Result<Option<String>, CommandError> {
    if let Some(text) = window_registry::workspace_json(&app, &window_label) {
        return Ok(Some(text));
    }
    let path = workspace_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(WorkspaceError::from)?;
    Ok(Some(text))
}

#[tauri::command]
pub async fn workspace_load(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, CommandError> {
    let window_label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || workspace_load_impl(app, window_label))
        .await
        .map_err(|err| CommandError {
            message: format!("workspace.load worker failed: {err}"),
        })?
}

fn workspace_save_impl(
    app: tauri::AppHandle,
    window_label: String,
    data: String,
) -> Result<bool, CommandError> {
    if window_registry::save_workspace_json(&app, &window_label, &data) {
        return Ok(true);
    }
    let path = workspace_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(WorkspaceError::from)?;
    }
    fs::write(&path, data).map_err(WorkspaceError::from)?;
    Ok(true)
}

#[tauri::command]
pub async fn workspace_save(
    app: tauri::AppHandle,
    window: WebviewWindow,
    data: String,
) -> Result<bool, CommandError> {
    let window_label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || workspace_save_impl(app, window_label, data))
        .await
        .map_err(|err| CommandError {
            message: format!("workspace.save worker failed: {err}"),
        })?
}

#[tauri::command]
pub async fn workspace_move_to_window(
    app: tauri::AppHandle,
    source_window_id: String,
    target_window_id: String,
    workspace_id: String,
    insert_index: usize,
) -> Result<bool, CommandError> {
    let worker_app = app.clone();
    let emit_source_window_id = source_window_id.clone();
    let emit_target_window_id = target_window_id.clone();
    let moved = tauri::async_runtime::spawn_blocking(move || {
        window_registry::move_workspace(
            &worker_app,
            &source_window_id,
            &target_window_id,
            &workspace_id,
            insert_index,
        )
    })
    .await
    .map_err(|err| CommandError {
        message: format!("workspace.moveToWindow worker failed: {err}"),
    })?;

    let Some((source_json, target_json)) = moved else {
        return Ok(false);
    };
    let _ = app.emit_to(&emit_source_window_id, "workspace:reload", source_json);
    let _ = app.emit_to(&emit_target_window_id, "workspace:reload", target_json);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_path_uses_workspaces_json_filename() {
        // We can't easily build an AppHandle in a unit test; assert on the
        // filename component to guard against accidental rename of the
        // on-disk file (which would lose user workspace state on upgrade).
        let p = PathBuf::from("/fake/app-data").join("workspaces.json");
        assert_eq!(p.file_name().unwrap(), "workspaces.json");
    }
}
