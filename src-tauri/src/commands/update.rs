// update:* — version + GitHub release polling.
//
// Tauri owns the current app version, and Rust now performs the GitHub
// Releases request directly so update checks do not wake the Node sidecar.

use crate::sidecar::BridgeError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

const GITHUB_LATEST_RELEASE: &str =
    "https://api.github.com/repos/tony1223/better-agent-terminal/releases/latest";

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: Option<String>,
    html_url: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    assets: Option<Vec<GithubAsset>>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: Option<String>,
    browser_download_url: Option<String>,
}

#[tauri::command]
pub fn update_get_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Which bundle this binary was built as: "all-in-one" or "lightweight".
/// Baked at compile time by build.rs from the BAT_BUNDLE_MODE env var so the
/// auto-updater can fetch the matching update channel ("lightweight 用
/// lightweight"). Defaults to "all-in-one" for plain dev builds.
#[tauri::command]
pub fn update_get_bundle_mode() -> &'static str {
    let mode = env!("BAT_BUNDLE_MODE");
    if mode == "lightweight" {
        "lightweight"
    } else {
        "all-in-one"
    }
}

const MANIFEST_BASE: &str =
    "https://github.com/tony1223/better-agent-terminal/releases/download/manifests";

/// Resolve the Tauri-updater manifest URL for the requested channel and the
/// build's own bundle mode (so a lightweight install only ever upgrades to a
/// lightweight build, and vice versa).
fn manifest_endpoint(channel: &str) -> String {
    let mode = update_get_bundle_mode();
    let ch = if channel == "pre" { "pre" } else { "stable" };
    format!("{MANIFEST_BASE}/latest-{ch}-{mode}.json")
}

fn build_updater(
    app: &tauri::AppHandle,
    channel: &str,
) -> Result<tauri_plugin_updater::Updater, BridgeError> {
    let endpoint = manifest_endpoint(channel);
    let url = reqwest::Url::parse(&endpoint).map_err(|err| BridgeError {
        message: format!("invalid updater endpoint {endpoint}: {err}"),
    })?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|err| BridgeError {
            message: format!("updater endpoints rejected: {err}"),
        })?
        .build()
        .map_err(|err| BridgeError {
            message: format!("updater build failed: {err}"),
        })
}

/// Check the per-channel/per-mode manifest for a newer build. Returns
/// `{ available, currentVersion, version?, notes? }`. Does not download.
#[tauri::command]
pub async fn update_check_native(
    app: tauri::AppHandle,
    channel: String,
) -> Result<Value, BridgeError> {
    let current = app.package_info().version.to_string();
    let updater = build_updater(&app, &channel)?;
    match updater.check().await {
        Ok(Some(update)) => Ok(json!({
            "available": true,
            "currentVersion": current,
            "version": update.version,
            "notes": update.body,
            "channel": channel,
        })),
        Ok(None) => Ok(json!({
            "available": false,
            "currentVersion": current,
            "channel": channel,
        })),
        Err(err) => Err(BridgeError {
            message: format!("update check failed: {err}"),
        }),
    }
}

/// Download + install the latest build for this channel/mode in the
/// background. Emits `update://download-progress` and `update://download-finished`
/// events. Intentionally does NOT relaunch — the swapped bundle applies on the
/// next launch; the UI prompts the user to restart.
#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    channel: String,
) -> Result<Value, BridgeError> {
    let updater = build_updater(&app, &channel)?;
    let Some(update) = updater.check().await.map_err(|err| BridgeError {
        message: format!("update check failed: {err}"),
    })?
    else {
        return Ok(json!({ "installed": false, "reason": "up-to-date" }));
    };
    let version = update.version.clone();
    let progress_app = app.clone();
    let mut downloaded: usize = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk;
                let _ = progress_app.emit(
                    "update://download-progress",
                    json!({ "downloaded": downloaded, "total": total }),
                );
            },
            move || {
                let _ = app.emit("update://download-finished", json!({}));
            },
        )
        .await
        .map_err(|err| BridgeError {
            message: format!("update install failed: {err}"),
        })?;
    Ok(json!({ "installed": true, "version": version }))
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Value, BridgeError> {
    let current_version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || check_update_native(&current_version))
        .await
        .map_err(|err| BridgeError {
            message: format!("update.check worker failed: {err}"),
        })
}

fn check_update_native(current_version: &str) -> Value {
    let fallback = update_fallback(current_version);
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Better-Agent-Terminal")
        .build()
    {
        Ok(client) => client,
        Err(_) => return fallback,
    };
    let response = match client
        .get(GITHUB_LATEST_RELEASE)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
    {
        Ok(response) => response,
        Err(_) => return fallback,
    };
    if !response.status().is_success() {
        return fallback;
    }
    let Ok(release) = response.json::<GithubRelease>() else {
        return fallback;
    };
    let Some(tag_name) = release.tag_name.filter(|value| !value.trim().is_empty()) else {
        return fallback;
    };
    let latest_version = tag_name.trim_start_matches('v').to_string();
    let download_url = release.assets.as_ref().and_then(|assets| {
        assets.iter().find_map(|asset| {
            let name = asset.name.as_deref()?;
            if name.ends_with("-win.zip") || name.contains("win") {
                asset.browser_download_url.clone()
            } else {
                None
            }
        })
    });
    json!({
        "hasUpdate": compare_versions(current_version, &latest_version),
        "currentVersion": current_version,
        "latestRelease": {
            "version": latest_version,
            "tagName": tag_name,
            "htmlUrl": release.html_url,
            "downloadUrl": download_url,
            "body": release.body.unwrap_or_default(),
            "publishedAt": release.published_at,
        }
    })
}

fn update_fallback(current_version: &str) -> Value {
    json!({
        "hasUpdate": false,
        "currentVersion": current_version,
        "latestRelease": Value::Null,
    })
}

fn compare_versions(current: &str, latest: &str) -> bool {
    let current_parts = parse_version_parts(current);
    let latest_parts = parse_version_parts(latest);
    let len = current_parts.len().max(latest_parts.len());
    for index in 0..len {
        let current_part = current_parts.get(index).copied().unwrap_or(0);
        let latest_part = latest_parts.get(index).copied().unwrap_or(0);
        if latest_part > current_part {
            return true;
        }
        if latest_part < current_part {
            return false;
        }
    }
    false
}

fn parse_version_parts(version: &str) -> Vec<u64> {
    version
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_pkg_version_is_non_empty() {
        let v = env!("CARGO_PKG_VERSION");
        assert!(!v.is_empty(), "CARGO_PKG_VERSION must not be empty");
        assert!(v.contains('.'), "version should contain a dot: {v}");
    }

    #[test]
    fn compare_versions_matches_sidecar_semantics() {
        assert!(compare_versions("1.2.3", "1.2.4"));
        assert!(compare_versions("v1.2.3", "2.0.0"));
        assert!(!compare_versions("1.2.3", "1.2.3"));
        assert!(!compare_versions("1.2.3", "1.2.2"));
        assert!(!compare_versions("1.2.3", "1.2"));
        assert!(compare_versions("1.2", "1.2.1"));
    }

    #[test]
    fn fallback_keeps_renderer_shape() {
        let value = update_fallback("1.2.3");
        assert_eq!(value["hasUpdate"], false);
        assert_eq!(value["currentVersion"], "1.2.3");
        assert!(value["latestRelease"].is_null());
    }
}
