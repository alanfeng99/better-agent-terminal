// worktree.* — forwards to the Node sidecar.
//
// 5 methods (create, remove, status, merge, rehydrate). Stubbed in the
// sidecar today. agent-tied: the real implementation lives in
// electron/worktree-manager.ts and ports over with the rest of the
// agent runtime.

use crate::sidecar::{BridgeError, SidecarState, app_handle_emit_sink, resolve_spawn_config};
use serde_json::{Value, json};
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

#[tauri::command]
pub fn worktree_create(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    cwd: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "worktree.create", json!({ "sessionId": session_id, "cwd": cwd }))
}

#[tauri::command]
pub fn worktree_remove(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    delete_branch: bool,
) -> Result<Value, BridgeError> {
    call(
        &app,
        &state,
        "worktree.remove",
        json!({ "sessionId": session_id, "deleteBranch": delete_branch }),
    )
}

#[tauri::command]
pub fn worktree_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "worktree.status", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn worktree_merge(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    strategy: String,
) -> Result<Value, BridgeError> {
    call(
        &app,
        &state,
        "worktree.merge",
        json!({ "sessionId": session_id, "strategy": strategy }),
    )
}

#[tauri::command]
pub fn worktree_rehydrate(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    cwd: String,
    worktree_path: String,
    branch_name: String,
) -> Result<Value, BridgeError> {
    call(
        &app,
        &state,
        "worktree.rehydrate",
        json!({
            "sessionId": session_id,
            "cwd": cwd,
            "worktreePath": worktree_path,
            "branchName": branch_name,
        }),
    )
}
