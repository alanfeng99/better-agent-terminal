// remote.* — cross-machine server / client. Forwards to the Node sidecar.
//
// All 8 methods stubbed in the sidecar today; real implementations land
// in Phase 3 alongside the mDNS + TLS pin work.

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
pub fn remote_start_server(
    app: AppHandle,
    state: State<'_, SidecarState>,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    call(
        &app,
        &state,
        "remote.startServer",
        json!({ "options": options.unwrap_or(Value::Null) }),
    )
}

#[tauri::command]
pub fn remote_stop_server(app: AppHandle, state: State<'_, SidecarState>) -> Result<Value, BridgeError> {
    call(&app, &state, "remote.stopServer", Value::Null)
}

#[tauri::command]
pub fn remote_server_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "remote.serverStatus", Value::Null)
}

#[tauri::command]
pub fn remote_connect(
    app: AppHandle,
    state: State<'_, SidecarState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
    label: Option<String>,
) -> Result<Value, BridgeError> {
    call(
        &app,
        &state,
        "remote.connect",
        json!({ "host": host, "port": port, "token": token, "fingerprint": fingerprint, "label": label }),
    )
}

#[tauri::command]
pub fn remote_disconnect(app: AppHandle, state: State<'_, SidecarState>) -> Result<Value, BridgeError> {
    call(&app, &state, "remote.disconnect", Value::Null)
}

#[tauri::command]
pub fn remote_client_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "remote.clientStatus", Value::Null)
}

#[tauri::command]
pub fn remote_test_connection(
    app: AppHandle,
    state: State<'_, SidecarState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
) -> Result<Value, BridgeError> {
    call(
        &app,
        &state,
        "remote.testConnection",
        json!({ "host": host, "port": port, "token": token, "fingerprint": fingerprint }),
    )
}

#[tauri::command]
pub fn remote_list_profiles(
    app: AppHandle,
    state: State<'_, SidecarState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
) -> Result<Value, BridgeError> {
    call(
        &app,
        &state,
        "remote.listProfiles",
        json!({ "host": host, "port": port, "token": token, "fingerprint": fingerprint }),
    )
}
