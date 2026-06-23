// Codex Fugu (Sakana provider) configuration — a small settings surface so the
// user can wire up the Sakana provider + API key from the app, without running
// the Fugu installer (which also pins/switches the codex version). Every write
// is ADDITIVE to ~/.codex and never edits existing codex config:
//   - config.toml: append `[model_providers.sakana]` only if absent.
//   - .env:        set/replace the SAKANA_API_KEY line (0600 on unix).
// The app-server reads SAKANA_API_KEY from $CODEX_HOME/.env at spawn, so this is
// all the runtime needs (provider routing is per-thread via modelProvider).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const SAKANA_PROVIDER_BLOCK: &str = "[model_providers.sakana]\n\
name = \"Sakana API\"\n\
base_url = \"https://api.sakana.ai/v1\"\n\
env_key = \"SAKANA_API_KEY\"\n\
wire_api = \"responses\"\n\
stream_idle_timeout_ms = 7200000\n\
stream_max_retries = 5\n\
request_max_retries = 4\n";

// Standard Codex home (matches the Fugu installer's default). The unified-mode
// app-server runs from here too, so a provider written here is what it reads.
fn codex_home() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return Some(p);
        }
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".codex"))
}

fn provider_configured(home: &Path) -> bool {
    std::fs::read_to_string(home.join("config.toml"))
        .map(|content| content.contains("[model_providers.sakana]"))
        .unwrap_or(false)
}

fn env_has_key(home: &Path) -> bool {
    std::fs::read_to_string(home.join(".env"))
        .map(|content| {
            content.lines().any(|line| {
                let line = line.trim_start().trim_start_matches("export ").trim_start();
                line.strip_prefix("SAKANA_API_KEY=")
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn key_configured(home: &Path) -> bool {
    if std::env::var("SAKANA_API_KEY")
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    env_has_key(home)
}

#[tauri::command]
pub fn codex_fugu_status() -> Value {
    let home = codex_home();
    let (provider, key) = match &home {
        Some(h) => (provider_configured(h), key_configured(h)),
        None => (false, false),
    };
    json!({
        "codexHome": home.as_ref().map(|h| h.to_string_lossy().to_string()),
        "providerConfigured": provider,
        "keyConfigured": key,
    })
}

fn ensure_provider_block(home: &Path) -> Result<(), String> {
    let path = home.join("config.toml");
    let mut content = std::fs::read_to_string(&path).unwrap_or_default();
    if content.contains("[model_providers.sakana]") {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    if !content.is_empty() {
        content.push('\n');
    }
    content.push_str(SAKANA_PROVIDER_BLOCK);
    std::fs::write(&path, content).map_err(|e| format!("write config.toml failed: {e}"))
}

fn write_env_key(home: &Path, key: &str) -> Result<(), String> {
    let path = home.join(".env");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    let mut replaced = false;
    for line in existing.lines() {
        let probe = line.trim_start().trim_start_matches("export ").trim_start();
        if probe.starts_with("SAKANA_API_KEY=") {
            if !replaced {
                lines.push(format!("SAKANA_API_KEY={key}"));
                replaced = true;
            }
        } else {
            lines.push(line.to_string());
        }
    }
    if !replaced {
        lines.push(format!("SAKANA_API_KEY={key}"));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    std::fs::write(&path, out).map_err(|e| format!("write .env failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub fn codex_fugu_set_key(api_key: String) -> Result<Value, String> {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("SAKANA_API_KEY is empty".into());
    }
    let home = codex_home().ok_or_else(|| "could not resolve codex home (~/.codex)".to_string())?;
    std::fs::create_dir_all(&home).map_err(|e| format!("create {} failed: {e}", home.display()))?;
    ensure_provider_block(&home)?;
    write_env_key(&home, &key)?;
    Ok(codex_fugu_status())
}
