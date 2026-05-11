// openai.* — Codex auth fallback key storage.
//
// OpenAI Direct runtime is retired. These commands remain only for the
// settings/auth surface that can provide Codex-compatible credentials.
// Keep this in Rust so settings does not wake the Node sidecar.

use keyring::use_native_store;
use keyring_core::Entry;
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::{app_data, sidecar::BridgeError};

const OPENAI_KEY_FILE: &str = "openai-api-key.bin";
const KEYRING_SERVICE: &str = "better-agent-terminal:openai-api-key";
const KEYRING_ACCOUNT: &str = "default";

static SAFE_STORE_INIT: OnceLock<Result<(), String>> = OnceLock::new();

fn bridge_error(err: impl std::fmt::Display) -> BridgeError {
    BridgeError {
        message: err.to_string(),
    }
}

fn ensure_safe_store() -> Result<(), String> {
    SAFE_STORE_INIT
        .get_or_init(|| use_native_store(false).map_err(|err| format!("{err:?}")))
        .clone()
}

fn safe_entry() -> Result<Entry, String> {
    ensure_safe_store()?;
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|err| format!("could not create keyring entry: {err:?}"))
}

fn key_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(OPENAI_KEY_FILE)
}

fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        return Some(PathBuf::from(home));
    }
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

fn load_keyring_key() -> Option<String> {
    let key = safe_entry().ok()?.get_password().ok()?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn save_keyring_key(api_key: &str) -> Result<(), String> {
    safe_entry()?
        .set_password(api_key)
        .map_err(|err| format!("could not save OpenAI key: {err:?}"))
}

fn delete_keyring_key() {
    if let Ok(entry) = safe_entry() {
        let _ = entry.delete_credential();
    }
}

fn load_legacy_file_key(data_dir: &Path) -> Option<String> {
    let raw = fs::read(key_file_path(data_dir)).ok()?;
    let text = String::from_utf8(raw).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn configured_openai_key_for_runtime(app: &AppHandle) -> Option<String> {
    if let Some(key) = load_keyring_key() {
        return Some(key);
    }
    if let Some(data_dir) = app_data::app_data_dir_opt(app) {
        if let Some(key) = load_legacy_file_key(&data_dir) {
            return Some(key);
        }
    }
    std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|key| !key.is_empty())
}

fn save_legacy_file_key(data_dir: &Path, api_key: &str) -> io::Result<()> {
    fs::create_dir_all(data_dir)?;
    let path = key_file_path(data_dir);
    fs::write(&path, api_key.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn delete_legacy_file_key(data_dir: &Path) {
    let _ = fs::remove_file(key_file_path(data_dir));
}

fn load_codex_oauth_token_from_home(home: &Path) -> Option<String> {
    let raw = fs::read_to_string(home.join(".codex").join("auth.json")).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("tokens")
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(String::from)
}

fn has_openai_key_in(
    data_dir: &Path,
    home: Option<&Path>,
    env_key: Option<&str>,
    check_keyring: bool,
) -> bool {
    if check_keyring && load_keyring_key().is_some() {
        return true;
    }
    if load_legacy_file_key(data_dir).is_some() {
        return true;
    }
    if home.and_then(load_codex_oauth_token_from_home).is_some() {
        return true;
    }
    env_key.is_some_and(|key| !key.is_empty())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, BridgeError> {
    app_data::app_data_dir(app).map_err(|err| BridgeError {
        message: format!("could not resolve app data dir: {err}"),
    })
}

#[tauri::command]
pub async fn openai_get_api_key_status(app: AppHandle) -> Result<Value, BridgeError> {
    let data_dir = app_data_dir(&app)?;
    let home = home_dir();
    let env_key = std::env::var("OPENAI_API_KEY").ok();
    let has_key = has_openai_key_in(&data_dir, home.as_deref(), env_key.as_deref(), true);
    Ok(json!({ "hasKey": has_key }))
}

#[tauri::command]
pub async fn openai_set_api_key(app: AppHandle, api_key: String) -> Result<Value, BridgeError> {
    if api_key.trim().is_empty() {
        return Err(bridge_error("openai.setApiKey: missing apiKey"));
    }
    let data_dir = app_data_dir(&app)?;
    match save_keyring_key(&api_key) {
        Ok(()) => {
            delete_legacy_file_key(&data_dir);
            Ok(Value::Bool(true))
        }
        Err(_) => {
            save_legacy_file_key(&data_dir, &api_key).map_err(bridge_error)?;
            Ok(Value::Bool(true))
        }
    }
}

#[tauri::command]
pub async fn openai_clear_api_key(app: AppHandle) -> Result<Value, BridgeError> {
    let data_dir = app_data_dir(&app)?;
    delete_keyring_key();
    delete_legacy_file_key(&data_dir);
    Ok(Value::Bool(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_millis();
        std::env::temp_dir().join(format!(
            "bat-openai-key-{name}-{}-{stamp}",
            std::process::id()
        ))
    }

    #[test]
    fn legacy_file_key_counts_as_configured() {
        let dir = temp_dir("legacy");
        save_legacy_file_key(&dir, "sk-test").expect("save legacy key");
        assert!(has_openai_key_in(&dir, None, None, false));
        delete_legacy_file_key(&dir);
        assert!(!has_openai_key_in(&dir, None, None, false));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_oauth_token_counts_as_configured() {
        let home = temp_dir("oauth-home");
        let codex_dir = home.join(".codex");
        fs::create_dir_all(&codex_dir).expect("mkdir");
        fs::write(
            codex_dir.join("auth.json"),
            r#"{"tokens":{"access_token":"oauth-token","account_id":"acct"}}"#,
        )
        .expect("write auth");
        assert!(has_openai_key_in(
            &temp_dir("empty-data"),
            Some(&home),
            None,
            false
        ));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn env_key_counts_as_configured() {
        let dir = temp_dir("env");
        assert!(has_openai_key_in(&dir, None, Some("sk-env"), false));
        assert!(!has_openai_key_in(&dir, None, Some(""), false));
    }
}
