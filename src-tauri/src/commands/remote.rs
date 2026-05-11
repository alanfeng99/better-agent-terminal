// remote.* — cross-machine server / client. Forwards to the Node sidecar.
// The sidecar owns the TLS/WebSocket server/client lifecycle so the
// renderer-facing Tauri commands stay thin and nonblocking.

use crate::log_file::append_line;
use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, BridgeError, SidecarState};
use crate::{app_data, sidecar};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Default, Deserialize, PartialEq)]
struct RemoteAutoStartSettings {
    #[serde(default, rename = "remoteServerAutoStart")]
    auto_start: bool,
    #[serde(default, rename = "remoteServerPort")]
    port: Option<u16>,
    #[serde(default, rename = "remoteServerBindInterface")]
    bind_interface: Option<String>,
}

fn normalize_bind_interface(value: Option<&str>) -> String {
    match value {
        Some(value @ ("localhost" | "tailscale" | "all")) => value.to_string(),
        _ => "localhost".to_string(),
    }
}

fn parse_remote_auto_start_settings(raw: &str) -> RemoteAutoStartSettings {
    let parsed = serde_json::from_str::<RemoteAutoStartSettings>(raw).unwrap_or_default();
    RemoteAutoStartSettings {
        auto_start: parsed.auto_start,
        port: parsed.port,
        bind_interface: Some(normalize_bind_interface(parsed.bind_interface.as_deref())),
    }
}

fn read_remote_auto_start_settings(app: &AppHandle) -> RemoteAutoStartSettings {
    let Ok(dir) = app_data::app_data_dir(app) else {
        return RemoteAutoStartSettings::default();
    };
    let Ok(raw) = fs::read_to_string(dir.join("settings.json")) else {
        return RemoteAutoStartSettings::default();
    };
    parse_remote_auto_start_settings(&raw)
}

fn log_remote_auto_start(app: &AppHandle, message: &str) {
    let Ok(dir) = app_data::app_data_dir(app) else {
        return;
    };
    let _ = append_line(
        &dir.join("logs").join("tauri.log"),
        &format!("[RemoteServer] {message}\n"),
    );
}

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

fn maybe_auto_start_remote_server(app: AppHandle, state: SidecarState) -> Result<(), String> {
    let settings = read_remote_auto_start_settings(&app);
    if !settings.auto_start {
        return Ok(());
    }

    let status =
        call(&app, &state, "remote.serverStatus", Value::Null).map_err(|err| err.message)?;
    if status
        .get("running")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Ok(());
    }

    let port = settings.port.unwrap_or(9876);
    let bind_interface = normalize_bind_interface(settings.bind_interface.as_deref());
    let result = call(
        &app,
        &state,
        "remote.startServer",
        json!({ "options": { "port": port, "bindInterface": bind_interface } }),
    )
    .map_err(|err| err.message)?;

    if let Some(error) = result.get("error").and_then(|value| value.as_str()) {
        return Err(error.to_string());
    }
    log_remote_auto_start(
        &app,
        &format!(
            "auto-started on {}:{} (iface={})",
            result
                .get("boundHost")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
            result
                .get("port")
                .and_then(|value| value.as_u64())
                .unwrap_or(port as u64),
            result
                .get("bindInterface")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
        ),
    );
    Ok(())
}

pub fn spawn_auto_start_remote_server(app: AppHandle) {
    let state = app.state::<sidecar::SidecarState>().inner().clone();
    std::thread::spawn(move || {
        if let Err(err) = maybe_auto_start_remote_server(app.clone(), state) {
            log_remote_auto_start(&app, &format!("auto-start failed: {err}"));
        }
    });
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
pub async fn remote_start_server(
    app: AppHandle,
    state: State<'_, SidecarState>,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "remote.startServer",
        json!({ "options": options.unwrap_or(Value::Null) }),
    )
    .await
}

#[tauri::command]
pub async fn remote_stop_server(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "remote.stopServer", Value::Null).await
}

#[tauri::command]
pub async fn remote_server_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "remote.serverStatus", Value::Null).await
}

#[tauri::command]
pub async fn remote_connect(
    app: AppHandle,
    state: State<'_, SidecarState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
    label: Option<String>,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "remote.connect",
        json!({ "host": host, "port": port, "token": token, "fingerprint": fingerprint, "label": label }),
    )
    .await
}

#[tauri::command]
pub async fn remote_disconnect(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "remote.disconnect", Value::Null).await
}

#[tauri::command]
pub async fn remote_client_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "remote.clientStatus", Value::Null).await
}

#[tauri::command]
pub async fn remote_test_connection(
    app: AppHandle,
    state: State<'_, SidecarState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "remote.testConnection",
        json!({ "host": host, "port": port, "token": token, "fingerprint": fingerprint }),
    )
    .await
}

#[tauri::command]
pub async fn remote_list_profiles(
    app: AppHandle,
    state: State<'_, SidecarState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "remote.listProfiles",
        json!({ "host": host, "port": port, "token": token, "fingerprint": fingerprint }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_remote_auto_start_settings_reads_electron_shape() {
        let parsed = parse_remote_auto_start_settings(
            r#"{"remoteServerAutoStart":true,"remoteServerPort":12345,"remoteServerBindInterface":"all"}"#,
        );
        assert_eq!(
            parsed,
            RemoteAutoStartSettings {
                auto_start: true,
                port: Some(12345),
                bind_interface: Some("all".to_string()),
            }
        );
    }

    #[test]
    fn parse_remote_auto_start_settings_defaults_invalid_bind_interface() {
        let parsed = parse_remote_auto_start_settings(
            r#"{"remoteServerAutoStart":true,"remoteServerBindInterface":"public"}"#,
        );
        assert_eq!(parsed.bind_interface.as_deref(), Some("localhost"));
    }

    #[test]
    fn parse_remote_auto_start_settings_is_lenient() {
        let parsed = parse_remote_auto_start_settings("{not-json");
        assert_eq!(parsed.auto_start, false);
        assert_eq!(parsed.port, None);
        assert_eq!(parsed.bind_interface.as_deref(), Some("localhost"));
    }
}
