// update:* — version + release-poll helpers.
//
// `update_get_version` reads the package version Tauri compiled in.
// `update_check` forwards to the sidecar's update.check handler with
// the current version baked in, so the renderer can reuse the same
// {hasUpdate, currentVersion, latestRelease} shape it consumed under
// Electron. Sidecar uses Node's built-in fetch so we don't pay for a
// Rust HTTP client / TLS stack here.

use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, BridgeError, SidecarState};
use serde_json::{json, Value};
use std::time::Duration;

#[tauri::command]
pub fn update_get_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    let current_version = app.package_info().version.to_string();
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = resolve_spawn_config(&app)?;
        let sink = app_handle_emit_sink(app.clone());
        state.call_with_emit(
            &cfg,
            Some(sink),
            "update.check",
            json!({ "currentVersion": current_version }),
            Duration::from_secs(15),
        )
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("update.check worker failed: {err}"),
    })?
}

#[cfg(test)]
mod tests {
    // The real version string comes from PackageInfo at runtime; we can
    // at least confirm that the Cargo.toml version we build with parses
    // as a valid semver-ish string. This guards against accidental
    // version-bump typos in tauri.conf.json / Cargo.toml drift.
    #[test]
    fn cargo_pkg_version_is_non_empty() {
        let v = env!("CARGO_PKG_VERSION");
        assert!(!v.is_empty(), "CARGO_PKG_VERSION must not be empty");
        assert!(v.contains('.'), "version should contain a dot: {v}");
    }
}
