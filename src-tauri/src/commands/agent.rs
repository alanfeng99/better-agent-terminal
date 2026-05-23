// agent.* — read-only host capability metadata.

use crate::commands::profile as profile_cmd;
use crate::remote_client::RustRemoteClientState;
use crate::window_registry;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

pub const AGENT_PRESET_IDS: &[&str] = &[
    "claude-code",
    "claude-code-worktree",
    "claude-cli",
    "claude-cli-worktree",
    "codex-agent",
    "codex-agent-worktree",
    "codex-cli",
    "none",
];

#[tauri::command]
pub async fn agent_get_supported_session_types(app: AppHandle, window: WebviewWindow) -> Value {
    if let Some(remote_result) = remote_supported_session_types(&app, &window).await {
        return remote_result.unwrap_or_else(|_| agent_supported_session_type_ids());
    }
    agent_supported_session_type_ids()
}

#[tauri::command]
pub async fn agent_list_presets(app: AppHandle, window: WebviewWindow) -> Value {
    agent_get_supported_session_types(app, window).await
}

async fn remote_supported_session_types(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Option<Result<Value, String>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    Some(
        tauri::async_runtime::spawn_blocking(move || {
            remote_client.invoke(
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

fn is_remote_profile_window(app: &AppHandle, window: &WebviewWindow) -> bool {
    let Some(profile_id) = window_registry::profile_id_for_window(app, window.label()) else {
        return false;
    };
    profile_cmd::profile_get(app.clone(), profile_id)
        .map(|profile| profile.kind == "remote")
        .unwrap_or(false)
}

pub fn agent_supported_session_type_ids() -> Value {
    json!(AGENT_PRESET_IDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_list_matches_supported_runtime_ids() {
        assert!(AGENT_PRESET_IDS.contains(&"claude-code"));
        assert!(!AGENT_PRESET_IDS.contains(&"claude-code-v2"));
        assert!(AGENT_PRESET_IDS.contains(&"codex-agent"));
        assert!(AGENT_PRESET_IDS.contains(&"codex-agent-worktree"));
        assert!(!AGENT_PRESET_IDS.contains(&"openai-agent"));
    }
}
