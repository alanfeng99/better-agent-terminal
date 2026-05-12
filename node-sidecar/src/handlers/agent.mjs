// agent.* — single read-only method today: which presets the host knows
// how to start. Mirrored from renderer/src/types/agent-presets.ts AGENT_PRESETS —
// the renderer's NewTerminalQuickPick uses this to gate which preset
// cards render. Returning [] would gray out the entire picker. Keep
// this list in sync with the renderer constant; if you add a preset
// there without updating this, the new card will not be listed under
// Tauri.

import { registerHandler } from '../lib/protocol.mjs'

export const AGENT_PRESET_IDS = [
  'claude-code',
  'claude-code-v2',
  'claude-code-worktree',
  'claude-cli',
  'claude-cli-worktree',
  'codex-agent',
  'codex-agent-worktree',
  'codex-cli',
  'none',
]

registerHandler('agent.listPresets', async () => AGENT_PRESET_IDS)
