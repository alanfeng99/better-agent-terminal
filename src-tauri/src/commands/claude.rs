// claude.* — first cut of the Phase 2 sidecar surface.
//
// These commands forward to the Node sidecar over JSON-RPC. The actual
// Claude/agent logic lives in node-sidecar/src/server.mjs (and will grow
// as we move @anthropic-ai/claude-agent-sdk callsites out of the Electron
// main process). The Rust side is intentionally thin: pick a method name,
// pass through params, and return whatever the sidecar returns.
//
// MVP commands:
//   claude_ping            — round-trip probe used by tests.
//   claude_auth_status     — returns null until accounts are wired through.
//   claude_account_list    — returns [].
//
// Each one resolves the SpawnConfig from the AppHandle so the bridge can
// find both `node` on PATH and the bundled sidecar script. Failures bubble
// up as { message } strings to the renderer.

use crate::sidecar::{BridgeError, SidecarState, app_handle_emit_sink, resolve_spawn_config};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, State};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
// Long-running calls (startSession can boot the agent SDK, sendMessage may
// stream for minutes). 5 minutes is generous but bounded — callers that
// need true cancellation should issue abortSession through a separate
// invoke rather than relying on this timeout.
const SESSION_TIMEOUT: Duration = Duration::from_secs(300);

fn call(
    app: &AppHandle,
    state: &SidecarState,
    method: &str,
    params: Value,
) -> Result<Value, BridgeError> {
    call_with_timeout(app, state, method, params, DEFAULT_TIMEOUT)
}

fn call_with_timeout(
    app: &AppHandle,
    state: &SidecarState,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, BridgeError> {
    let cfg = resolve_spawn_config(app)?;
    let sink = app_handle_emit_sink(app.clone());
    state.call_with_emit(&cfg, Some(sink), method, params, timeout)
}

#[tauri::command]
pub fn claude_ping(
    app: AppHandle,
    state: State<'_, SidecarState>,
    payload: Option<Value>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "ping", payload.unwrap_or(Value::Null))
}

#[tauri::command]
pub fn claude_auth_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.authStatus", Value::Null)
}

#[tauri::command]
pub fn claude_account_list(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.accountList", Value::Null)
}

#[tauri::command]
pub fn claude_start_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    call_with_timeout(
        &app,
        &state,
        "claude.startSession",
        json!({ "sessionId": session_id, "options": options.unwrap_or(Value::Null) }),
        SESSION_TIMEOUT,
    )
}

#[tauri::command]
pub fn claude_send_message(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    prompt: String,
    images: Option<Vec<String>>,
    auto_compact_window: Option<i64>,
) -> Result<Value, BridgeError> {
    call_with_timeout(
        &app,
        &state,
        "claude.sendMessage",
        json!({
            "sessionId": session_id,
            "prompt": prompt,
            "images": images.unwrap_or_default(),
            "autoCompactWindow": auto_compact_window,
        }),
        SESSION_TIMEOUT,
    )
}

#[tauri::command]
pub fn claude_stop_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.stopSession", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_abort_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.abortSession", json!({ "sessionId": session_id }))
}

// --- account / auth ops ---------------------------------------------------

#[tauri::command]
pub fn claude_auth_login(app: AppHandle, state: State<'_, SidecarState>) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.authLogin", Value::Null)
}

#[tauri::command]
pub fn claude_auth_logout(app: AppHandle, state: State<'_, SidecarState>) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.authLogout", Value::Null)
}

#[tauri::command]
pub fn claude_account_import_current(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.accountImportCurrent", Value::Null)
}

#[tauri::command]
pub fn claude_account_login_new(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.accountLoginNew", Value::Null)
}

#[tauri::command]
pub fn claude_account_switch(
    app: AppHandle,
    state: State<'_, SidecarState>,
    account_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.accountSwitch", json!({ "accountId": account_id }))
}

#[tauri::command]
pub fn claude_account_remove(
    app: AppHandle,
    state: State<'_, SidecarState>,
    account_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.accountRemove", json!({ "accountId": account_id }))
}

#[tauri::command]
pub fn claude_account_mark_warning_shown(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.accountMarkWarningShown", Value::Null)
}

// --- read-only metadata ---------------------------------------------------

#[tauri::command]
pub fn claude_get_cli_path(app: AppHandle, state: State<'_, SidecarState>) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.getCliPath", Value::Null)
}

#[tauri::command]
pub fn claude_list_sessions(
    app: AppHandle,
    state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.listSessions", json!({ "cwd": cwd }))
}

#[tauri::command]
pub fn claude_get_supported_models(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.getSupportedModels", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_get_supported_commands(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.getSupportedCommands", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_get_supported_agents(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.getSupportedAgents", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_get_account_info(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.getAccountInfo", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_get_session_state(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.getSessionState", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_get_session_meta(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.getSessionMeta", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_get_context_usage(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.getContextUsage", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_get_worktree_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.getWorktreeStatus", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_scan_skills(
    app: AppHandle,
    state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.scanSkills", json!({ "cwd": cwd }))
}

#[tauri::command]
pub fn claude_cleanup_worktree(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    delete_branch: bool,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.cleanupWorktree", json!({
        "sessionId": session_id,
        "deleteBranch": delete_branch,
    }))
}

// --- per-session state -----------------------------------------------------

#[tauri::command]
pub fn claude_set_auto_continue(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    opts: Value,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.setAutoContinue", json!({
        "sessionId": session_id, "opts": opts,
    }))
}

#[tauri::command]
pub fn claude_get_auto_continue(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.getAutoContinue", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_set_permission_mode(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    mode: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.setPermissionMode", json!({
        "sessionId": session_id, "mode": mode,
    }))
}

#[tauri::command]
pub fn claude_set_model(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    model: String,
    auto_compact_window: Option<i64>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.setModel", json!({
        "sessionId": session_id, "model": model, "autoCompactWindow": auto_compact_window,
    }))
}

#[tauri::command]
pub fn claude_set_effort(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    effort: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.setEffort", json!({
        "sessionId": session_id, "effort": effort,
    }))
}

#[tauri::command]
pub fn claude_reset_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.resetSession", json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn claude_resolve_permission(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    tool_use_id: String,
    result: Value,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.resolvePermission", json!({
        "sessionId": session_id, "toolUseId": tool_use_id, "result": result,
    }))
}

#[tauri::command]
pub fn claude_resolve_ask_user(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    tool_use_id: String,
    answers: Value,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.resolveAskUser", json!({
        "sessionId": session_id, "toolUseId": tool_use_id, "answers": answers,
    }))
}
