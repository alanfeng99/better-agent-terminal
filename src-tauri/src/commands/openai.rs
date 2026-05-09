// openai.* — forwards to the Node sidecar.
//
// Mirrors the Electron preload contract: 5 methods (getApiKeyStatus,
// setApiKey, clearApiKey, listSessions, compactNow). All stubbed in the
// sidecar today; real impls land when the OpenAI agent manager moves
// over.

use crate::sidecar::{BridgeError, SidecarState, app_handle_emit_sink, resolve_spawn_config};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, State};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

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
pub fn openai_get_api_key_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "openai.getApiKeyStatus", Value::Null)
}

#[tauri::command]
pub fn openai_set_api_key(
    app: AppHandle,
    state: State<'_, SidecarState>,
    api_key: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "openai.setApiKey", json!({ "apiKey": api_key }))
}

#[tauri::command]
pub fn openai_clear_api_key(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "openai.clearApiKey", Value::Null)
}

#[tauri::command]
pub fn openai_list_sessions(
    app: AppHandle,
    state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "openai.listSessions", json!({ "cwd": cwd }))
}

#[tauri::command]
pub fn openai_compact_now(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call(&app, &state, "openai.compactNow", json!({ "sessionId": session_id }))
}
