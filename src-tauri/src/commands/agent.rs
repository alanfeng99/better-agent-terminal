// agent.* — read-only host capability metadata.

use serde_json::{json, Value};

const AGENT_PRESET_IDS: &[&str] = &[
    "claude-code",
    "claude-code-v2",
    "claude-code-worktree",
    "claude-cli",
    "claude-cli-worktree",
    "codex-agent",
    "codex-agent-worktree",
    "codex-cli",
    "none",
];

#[tauri::command]
pub async fn agent_list_presets() -> Value {
    json!(AGENT_PRESET_IDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_list_matches_supported_runtime_ids() {
        assert!(AGENT_PRESET_IDS.contains(&"claude-code"));
        assert!(AGENT_PRESET_IDS.contains(&"claude-code-v2"));
        assert!(AGENT_PRESET_IDS.contains(&"codex-agent"));
        assert!(AGENT_PRESET_IDS.contains(&"codex-agent-worktree"));
        assert!(!AGENT_PRESET_IDS.contains(&"openai-agent"));
    }
}
