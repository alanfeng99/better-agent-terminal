use crate::commands::claude::resolve_claude_cli_path;
use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, BridgeError, SidecarState};
use serde_json::{json, Map, Value};
use std::time::Duration;
use tauri::{AppHandle, State};

const CHANNEL_TIMEOUT: Duration = Duration::from_secs(15);

fn call_channel(
    app: &AppHandle,
    state: &SidecarState,
    method: &str,
    mut params: Value,
) -> Result<Value, BridgeError> {
    if let Value::Object(map) = &mut params {
        map.entry("cliPath".to_string())
            .or_insert_with(|| Value::String(resolve_claude_cli_path(app)));
    }
    let cfg = resolve_spawn_config(app)?;
    let sink = app_handle_emit_sink(app.clone());
    state.call_with_emit(&cfg, Some(sink), method, params, CHANNEL_TIMEOUT)
}

async fn call_channel_blocking(
    app: AppHandle,
    state: State<'_, SidecarState>,
    method: &'static str,
    params: Value,
) -> Result<Value, BridgeError> {
    let sidecar = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || call_channel(&app, &sidecar, method, params))
        .await
        .map_err(|err| BridgeError {
            message: format!("{method} worker failed: {err}"),
        })?
}

#[tauri::command]
pub async fn claude_channel_get_capabilities(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_channel_blocking(app, state, "claudeChannel.getCapabilities", json!({})).await
}

#[tauri::command]
pub async fn claude_channel_start_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    let mut params = match options {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    params.insert("sessionId".into(), Value::String(session_id));
    call_channel_blocking(
        app,
        state,
        "claudeChannel.startSession",
        Value::Object(params),
    )
    .await
}

#[tauri::command]
pub async fn claude_channel_send_message(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    prompt: String,
    message_id: Option<String>,
) -> Result<Value, BridgeError> {
    call_channel_blocking(
        app,
        state,
        "claudeChannel.sendMessage",
        json!({
            "sessionId": session_id,
            "prompt": prompt,
            "messageId": message_id,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_channel_stop_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call_channel_blocking(
        app,
        state,
        "claudeChannel.stopSession",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_channel_get_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call_channel_blocking(
        app,
        state,
        "claudeChannel.getStatus",
        json!({ "sessionId": session_id }),
    )
    .await
}
