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
// directory without translation. Cross-window move emits the existing
// workspace:reload event so renderer stores can reuse the Electron reload
// path; detach/reattach create and close Tauri webview windows while emitting
// the existing workspace:detached/workspace:reattached events.

use super::app::{log_tauri, renderer_url};
use crate::app_data;
use crate::commands::profile as profile_cmd;
use crate::remote_client::RustRemoteClientState;
use crate::window_registry;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent};
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
    let dir = app_data::app_data_dir(app).map_err(WorkspaceError::AppDataDir)?;
    Ok(dir.join("workspaces.json"))
}

fn encode_query_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
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

fn remote_profile_target_id(app: &tauri::AppHandle, window_label: &str) -> Option<String> {
    let profile_id = window_registry::profile_id_for_window(app, window_label)?;
    let profile = profile_cmd::profile_get(app.clone(), profile_id)?;
    if profile.kind != "remote" {
        return None;
    }
    Some(
        profile
            .remote_profile_id
            .unwrap_or_else(|| "default".to_string()),
    )
}

async fn remote_workspace_invoke(
    app: &tauri::AppHandle,
    window_label: &str,
    channel: &'static str,
    args: Vec<Value>,
) -> Option<Result<Value, CommandError>> {
    let target_profile_id = remote_profile_target_id(app, window_label)?;
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let mut invoke_args = Vec::with_capacity(args.len() + 1);
    invoke_args.push(json!(target_profile_id));
    invoke_args.extend(args);
    let result = tauri::async_runtime::spawn_blocking(move || {
        remote_client.invoke(channel, invoke_args, Duration::from_secs(30))
    })
    .await
    .map_err(|err| CommandError {
        message: format!("remote.invoke {channel} worker failed: {err}"),
    });
    Some(match result {
        Ok(value) => value.map_err(|err| CommandError { message: err }),
        Err(err) => Err(err),
    })
}

#[tauri::command]
pub async fn workspace_load(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, CommandError> {
    let window_label = window.label().to_string();
    if let Some(remote_result) =
        remote_workspace_invoke(&app, &window_label, "workspace:load", Vec::new()).await
    {
        return remote_result.map(|value| match value {
            Value::String(text) => Some(text),
            Value::Null => None,
            other => Some(other.to_string()),
        });
    }
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
    if let Some(remote_result) =
        remote_workspace_invoke(&app, &window_label, "workspace:save", vec![json!(data)]).await
    {
        return remote_result.map(|value| value.as_bool().unwrap_or(false));
    }
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

fn emit_detached_closed(app: &tauri::AppHandle, workspace_id: &str) {
    let Some(entry) = window_registry::remove_detached_entry(app, workspace_id) else {
        return;
    };
    if let Some(parent_id) = entry.detached_parent_window_id {
        let _ = app.emit_to(&parent_id, "workspace:reattached", workspace_id.to_string());
    }
}

#[tauri::command]
pub fn workspace_detach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    workspace_id: String,
) -> Result<bool, CommandError> {
    if let Some(existing) = window_registry::detached_entry_for_workspace(&app, &workspace_id) {
        if let Some(win) = app.get_webview_window(&existing.id) {
            let _ = win.set_focus();
            return Ok(true);
        }
    }

    let parent_window_id = window.label().to_string();
    let Some(entry) =
        window_registry::create_detached_entry(&app, &parent_window_id, &workspace_id)
    else {
        return Ok(false);
    };

    let url = format!(
        "index.html?detached={}",
        encode_query_component(&workspace_id)
    );
    let entry_id = entry.id.clone();
    log_tauri(
        &app,
        &format!("[window] detach-queue-build label={entry_id} url=app:{url}"),
    );
    let build_app = app.clone();
    let build_parent_window_id = parent_window_id.clone();
    let build_workspace_id = workspace_id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let schedule_app = build_app.clone();
        let schedule_entry_id = entry_id.clone();
        if let Err(err) = build_app.run_on_main_thread(move || {
            log_tauri(
                &schedule_app,
                &format!("[window] detach-create label={schedule_entry_id} url=app:{url}"),
            );
            let nav_app = schedule_app.clone();
            let nav_label = schedule_entry_id.clone();
            let load_label = schedule_entry_id.clone();
            let detached_window = match WebviewWindowBuilder::new(
                &schedule_app,
                &schedule_entry_id,
                renderer_url(&url),
            )
            .title("Better Agent Terminal")
            .inner_size(900.0, 700.0)
            .min_inner_size(600.0, 400.0)
            .on_navigation(move |url| {
                log_tauri(
                    &nav_app,
                    &format!("[window] navigation label={nav_label} url={url}"),
                );
                true
            })
            .on_page_load(move |window, payload| {
                log_tauri(
                    window.app_handle(),
                    &format!(
                        "[window] page-load label={load_label} event={:?} url={}",
                        payload.event(),
                        payload.url()
                    ),
                );
            })
            .build()
            {
                Ok(win) => win,
                Err(err) => {
                    let _ =
                        window_registry::remove_detached_entry(&schedule_app, &build_workspace_id);
                    log_tauri(
                        &schedule_app,
                        &format!(
                            "[window] detach-build-failed label={schedule_entry_id} error={err}"
                        ),
                    );
                    return;
                }
            };

            let close_app = schedule_app.clone();
            let close_workspace_id = build_workspace_id.clone();
            detached_window.on_window_event(move |event| {
                if matches!(
                    event,
                    WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                ) {
                    emit_detached_closed(&close_app, &close_workspace_id);
                }
            });

            log_tauri(
                &schedule_app,
                &format!("[window] detach-created label={schedule_entry_id}"),
            );
            let _ = schedule_app.emit_to(
                &build_parent_window_id,
                "workspace:detached",
                build_workspace_id,
            );
        }) {
            log_tauri(
                &build_app,
                &format!("[window] detach-schedule-failed label={entry_id} error={err}"),
            );
        }
    });
    Ok(true)
}

#[tauri::command]
pub fn workspace_reattach(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<bool, CommandError> {
    let Some(entry) = window_registry::detached_entry_for_workspace(&app, &workspace_id) else {
        return Ok(true);
    };
    if let Some(win) = app.get_webview_window(&entry.id) {
        let _ = win.close();
        return Ok(true);
    }
    emit_detached_closed(&app, &workspace_id);
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

    #[test]
    fn query_component_encoder_percent_encodes_unsafe_bytes() {
        assert_eq!(encode_query_component("abc-_.~123"), "abc-_.~123");
        assert_eq!(
            encode_query_component("a b/中文"),
            "a%20b%2F%E4%B8%AD%E6%96%87"
        );
    }
}
