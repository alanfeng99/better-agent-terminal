// tunnel.* — single read-only method (getConnection) forwarded to the sidecar.
// Stubbed; real impl lands with Phase 3.

use crate::sidecar::{BridgeError, SidecarState, app_handle_emit_sink, resolve_spawn_config};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, State};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

#[tauri::command]
pub fn tunnel_get_connection(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    let cfg = resolve_spawn_config(&app)?;
    let sink = app_handle_emit_sink(app.clone());
    state.call_with_emit(&cfg, Some(sink), "tunnel.getConnection", Value::Null, DEFAULT_TIMEOUT)
}
