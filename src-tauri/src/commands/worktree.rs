// worktree.* — forwards to the Node sidecar.
//
// 5 methods (create, remove, status, merge, rehydrate). Stubbed in the
// sidecar today. agent-tied: the real implementation lives in
// electron/worktree-manager.ts and ports over with the rest of the
// agent runtime.

use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, BridgeError, SidecarState};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, State};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

fn call(
    app: &AppHandle,
    state: &SidecarState,
    method: &str,
    params: Value,
) -> Result<Value, BridgeError> {
    let cfg = resolve_spawn_config(app)?;
    let sink = app_handle_emit_sink(app.clone());
    state.call_with_emit(&cfg, Some(sink), method, params, DEFAULT_TIMEOUT)
}

async fn call_blocking(
    app: AppHandle,
    state: State<'_, SidecarState>,
    method: &'static str,
    params: Value,
) -> Result<Value, BridgeError> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || call(&app, &state, method, params))
        .await
        .map_err(|err| BridgeError {
            message: format!("{method} worker failed: {err}"),
        })?
}

#[tauri::command]
pub async fn worktree_create(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    cwd: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "worktree.create",
        json!({ "sessionId": session_id, "cwd": cwd }),
    )
    .await
}

#[tauri::command]
pub async fn worktree_remove(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    delete_branch: bool,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "worktree.remove",
        json!({ "sessionId": session_id, "deleteBranch": delete_branch }),
    )
    .await
}

#[tauri::command]
pub async fn worktree_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "worktree.status",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn worktree_merge(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    strategy: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "worktree.merge",
        json!({ "sessionId": session_id, "strategy": strategy }),
    )
    .await
}

#[tauri::command]
pub async fn worktree_rehydrate(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    cwd: String,
    worktree_path: String,
    branch_name: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "worktree.rehydrate",
        json!({
            "sessionId": session_id,
            "cwd": cwd,
            "worktreePath": worktree_path,
            "branchName": branch_name,
        }),
    )
    .await
}
