// agent.* — single read-only method (listPresets) forwarded to the sidecar.
//
// Returns an empty list until presets are wired in the sidecar.

use crate::sidecar::{BridgeError, SidecarState, app_handle_emit_sink, resolve_spawn_config};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, State};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

#[tauri::command]
pub fn agent_list_presets(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    let cfg = resolve_spawn_config(&app)?;
    let sink = app_handle_emit_sink(app.clone());
    state.call_with_emit(&cfg, Some(sink), "agent.listPresets", Value::Null, DEFAULT_TIMEOUT)
}
