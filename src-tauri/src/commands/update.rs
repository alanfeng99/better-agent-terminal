// update:* — version + GitHub release polling.
//
// Tauri owns the current app version, and Rust now performs the GitHub
// Releases request directly so update checks do not wake the Node sidecar.

use crate::sidecar::BridgeError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

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
