// tunnel.* — connection information for Mobile Connect.

use crate::network_addresses;
use crate::remote_server::RustRemoteServerState;
use crate::sidecar::BridgeError;
use serde_json::{json, Value};
use tauri::State;

fn not_running_connection() -> Value {
    json!({
        "error": "server not running - start the remote server before generating a QR code",
        "addresses": network_addresses::all_addresses("0.0.0.0"),
    })
}

#[tauri::command]
pub async fn tunnel_get_connection(
    remote_state: State<'_, RustRemoteServerState>,
) -> Result<Value, BridgeError> {
    let Some(info) = remote_state.connection_info() else {
        return Ok(not_running_connection());
    };
    let addresses = network_addresses::all_addresses(&info.bound_host);
    let Some(primary) = addresses.first() else {
        return Ok(json!({ "error": "No network interface found", "addresses": [] }));
    };
    Ok(json!({
        "url": format!("wss://{}:{}", primary.ip, info.port),
        "token": info.token,
        "fingerprint": info.fingerprint,
        "mode": primary.mode,
        "addresses": addresses,
    }))
}
