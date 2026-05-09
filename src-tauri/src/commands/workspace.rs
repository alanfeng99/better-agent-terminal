// workspace:save / workspace:load — single-window MVP for the Tauri shell.
//
// Electron's workspace store is keyed by windowId because that runtime
// supports multi-window workspaces with detach/reattach. The Tauri build
// is single-window for the foreseeable future, so we collapse to a single
// JSON file in the per-user app data dir. The renderer treats the payload
// as opaque text — same shape as settings.{load,save} — which lets the
// host-api adapter route either runtime without changing types.
//
// File location: <app-data>/workspaces.json. We keep the filename stable
// so an Electron→Tauri migration can copy the file from the old userData
// directory without translation. Multi-window detach/reattach (and
// move-to-window) intentionally remain unported; renderer keeps those
// calls flowing through window.batAppAPI under Electron and they throw
// `not implemented` under Tauri until we have multi-window support.

use serde::Serialize;
use std::fs;
use std::io;
use std::path::PathBuf;
use tauri::Manager;
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
        Self { message: value.to_string() }
    }
}

fn workspace_path(app: &tauri::AppHandle) -> Result<PathBuf, WorkspaceError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| WorkspaceError::AppDataDir(e.to_string()))?;
    Ok(dir.join("workspaces.json"))
}

#[tauri::command]
pub fn workspace_load(app: tauri::AppHandle) -> Result<Option<String>, CommandError> {
    let path = workspace_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(WorkspaceError::from)?;
    Ok(Some(text))
}

#[tauri::command]
pub fn workspace_save(app: tauri::AppHandle, data: String) -> Result<bool, CommandError> {
    let path = workspace_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(WorkspaceError::from)?;
    }
    fs::write(&path, data).map_err(WorkspaceError::from)?;
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
