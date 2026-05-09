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
