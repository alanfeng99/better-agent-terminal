// agent.* — read-only host capability metadata.

use crate::commands::profile as profile_cmd;
use crate::remote_client::RustRemoteClientState;
use crate::window_registry;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

pub const AGENT_PRESET_IDS: &[&str] = &[
    "claude-code",
    "claude-channel",
    "claude-cli-agent",
    "claude-code-worktree",
    "claude-cli",
    "claude-cli-worktree",
    "codex-agent",
    "codex-agent-worktree",
    "codex-cli",
    "none",
];

const DEBUG_ONLY_AGENT_PRESET_IDS: &[&str] = &["claude-channel", "claude-cli-agent"];

fn bat_debug_enabled() -> bool {
    matches!(
        std::env::var("BAT_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

#[tauri::command]
pub async fn agent_get_supported_session_types(app: AppHandle, window: WebviewWindow) -> Value {
    if let Some(remote_result) = remote_supported_session_types(&app, &window).await {
        return remote_result.unwrap_or_else(|_| agent_supported_session_type_ids());
    }
    agent_supported_session_type_ids()
}

#[tauri::command]
pub async fn agent_list_presets(app: AppHandle, window: WebviewWindow) -> Value {
    if let Some(remote_result) = remote_agent_presets(&app, &window).await {
        return remote_result.unwrap_or_else(|_| agent_supported_session_presets());
    }
    agent_supported_session_presets()
}

async fn remote_supported_session_types(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Option<Result<Value, String>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let window_label = window.label().to_string();
    Some(
        tauri::async_runtime::spawn_blocking(move || {
            remote_client.invoke(
                &window_label,
                "agent:get-supported-session-types",
                Vec::new(),
                Duration::from_secs(10),
            )
        })
        .await
        .map_err(|err| {
            format!("remote.invoke agent:get-supported-session-types worker failed: {err}")
        })
        .and_then(|value| value),
    )
}

async fn remote_agent_presets(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Option<Result<Value, String>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let window_label = window.label().to_string();
    Some(
        tauri::async_runtime::spawn_blocking(move || {
            remote_client.invoke(
                &window_label,
                "agent:list-presets",
                Vec::new(),
                Duration::from_secs(10),
            )
        })
        .await
        .map_err(|err| format!("remote.invoke agent:list-presets worker failed: {err}"))
        .and_then(|value| value),
    )
}

fn is_remote_profile_window(app: &AppHandle, window: &WebviewWindow) -> bool {
    let Some(profile_id) = window_registry::profile_id_for_window(app, window.label()) else {
        return false;
    };
    profile_cmd::profile_get(app.clone(), profile_id)
        .map(|profile| profile.kind == "remote")
        .unwrap_or(false)
}

pub fn agent_supported_session_type_ids() -> Value {
    json!(agent_supported_session_type_ids_for_debug(
        bat_debug_enabled()
    ))
}

pub fn agent_supported_session_presets() -> Value {
    json!(agent_supported_session_presets_for_debug(
        bat_debug_enabled()
    ))
}

fn agent_supported_session_type_ids_for_debug(debug_enabled: bool) -> Vec<&'static str> {
    AGENT_PRESET_IDS
        .iter()
        .copied()
        .filter(|id| debug_enabled || !DEBUG_ONLY_AGENT_PRESET_IDS.contains(id))
        .collect()
}

fn agent_supported_session_presets_for_debug(debug_enabled: bool) -> Vec<Value> {
    agent_supported_session_type_ids_for_debug(debug_enabled)
        .into_iter()
        .filter_map(agent_preset_metadata)
        .collect()
}

fn agent_preset_metadata(id: &str) -> Option<Value> {
    let preset = match id {
        "claude-code" => json!({
            "id": "claude-code",
            "name": "Claude Agent",
            "icon": "✦",
            "color": "#d97706",
            "command": "claude --continue",
            "suggested": true,
            "backend": "sdk",
        }),
        "claude-channel" => json!({
            "id": "claude-channel",
            "name": "Claude Channel Agent",
            "icon": "◉",
            "color": "#f97316",
            "debug": true,
            "backend": "channel",
        }),
        "claude-cli-agent" => json!({
            "id": "claude-cli-agent",
            "name": "Claude CLI Agent (Subscription)",
            "icon": "◈",
            "color": "#d97706",
            "debug": true,
            "backend": "cli",
        }),
        "claude-code-worktree" => json!({
            "id": "claude-code-worktree",
            "name": "Claude Agent (Worktree)",
            "icon": "✦",
            "color": "#22c55e",
            "backend": "sdk",
            "needsGitRepo": true,
        }),
        "claude-cli" => json!({
            "id": "claude-cli",
            "name": "Claude CLI",
            "icon": "▶",
            "color": "#d97706",
            "suggested": true,
            "backend": "cli",
        }),
        "claude-cli-worktree" => json!({
            "id": "claude-cli-worktree",
            "name": "Claude CLI (Worktree)",
            "icon": "▶",
            "color": "#22c55e",
            "backend": "cli",
            "needsGitRepo": true,
        }),
        "codex-agent" => json!({
            "id": "codex-agent",
            "name": "Codex Agent",
            "icon": "⬡",
            "color": "#10a37f",
            "backend": "sdk",
        }),
        "codex-agent-worktree" => json!({
            "id": "codex-agent-worktree",
            "name": "Codex Agent (Worktree)",
            "icon": "⬡",
            "color": "#10a37f",
            "backend": "sdk",
            "needsGitRepo": true,
        }),
        "codex-cli" => json!({
            "id": "codex-cli",
            "name": "Codex CLI",
            "icon": "▶",
            "color": "#10a37f",
            "backend": "pty",
        }),
        "none" => json!({
            "id": "none",
            "name": "Terminal",
            "icon": "⌘",
            "color": "#888888",
        }),
        _ => return None,
    };
    Some(preset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_list_matches_supported_runtime_ids() {
        assert!(AGENT_PRESET_IDS.contains(&"claude-code"));
        assert!(AGENT_PRESET_IDS.contains(&"claude-channel"));
        assert!(!AGENT_PRESET_IDS.contains(&"claude-code-v2"));
        assert!(AGENT_PRESET_IDS.contains(&"codex-agent"));
        assert!(AGENT_PRESET_IDS.contains(&"codex-agent-worktree"));
        assert!(!AGENT_PRESET_IDS.contains(&"openai-agent"));
    }

    #[test]
    fn supported_session_types_hide_debug_only_presets_without_debug() {
        let regular = agent_supported_session_type_ids_for_debug(false);
        assert!(regular.contains(&"claude-code"));
        assert!(!regular.contains(&"claude-channel"));
        assert!(!regular.contains(&"claude-cli-agent"));

        let debug = agent_supported_session_type_ids_for_debug(true);
        assert!(debug.contains(&"claude-channel"));
        assert!(debug.contains(&"claude-cli-agent"));
    }

    #[test]
    fn claude_cli_agent_preset_metadata_present_in_debug() {
        let presets = agent_supported_session_presets_for_debug(true);
        assert!(presets.iter().any(|preset| {
            preset.get("id").and_then(Value::as_str) == Some("claude-cli-agent")
                && preset.get("backend").and_then(Value::as_str) == Some("cli")
        }));
    }

    #[test]
    fn preset_metadata_contains_names_for_supported_ids() {
        let presets = agent_supported_session_presets_for_debug(false);
        assert!(presets.iter().any(|preset| {
            preset.get("id").and_then(Value::as_str) == Some("codex-agent")
                && preset.get("name").and_then(Value::as_str) == Some("Codex Agent")
        }));
        assert!(!presets
            .iter()
            .any(|preset| { preset.get("id").and_then(Value::as_str) == Some("claude-channel") }));
    }
}
