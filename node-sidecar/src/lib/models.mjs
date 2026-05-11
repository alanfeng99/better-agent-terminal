// Mirror of src/utils/claude-model-presets.ts CLAUDE_BUILTIN_MODELS.
// Drift guard: see node-sidecar/tests/server.test.mjs.
export const CLAUDE_BUILTIN_MODELS = [
  { value: 'claude-opus-4-7:auto-compact-200k', displayName: 'Opus 4.7 · 200K Auto-Compact', description: 'claude-opus-4-7 · compact at 200K tokens' },
  { value: 'claude-opus-4-7:auto-compact-300k', displayName: 'Opus 4.7 · 300K Auto-Compact', description: 'claude-opus-4-7 · compact at 300K tokens' },
  { value: 'claude-opus-4-7:auto-compact-400k', displayName: 'Opus 4.7 · 400K Auto-Compact', description: 'claude-opus-4-7 · compact at 400K tokens' },
  { value: 'claude-opus-4-7:1m', displayName: 'Opus 4.7 · 1M', description: 'claude-opus-4-7 · no early auto-compact' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6 (1M)', description: 'claude-opus-4-6 · 1M context' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6 (1M)', description: 'claude-sonnet-4-6 · 1M context' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'claude-haiku-4-5 · fast & lightweight' },
]
// Mirror of src/utils/claude-model-presets.ts CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS
// keys. This is the dedup set for SDK-discovered models — note it
// includes [1m] variants of base IDs (which the builtin model list
// itself doesn't carry, but the SDK does emit), so SDK results that
// duplicate a builtin via either form get filtered. Drift guard test
// validates this stays in sync with the renderer-side TS source.
export const CLAUDE_BUILTIN_DEDUP_KEYS = [
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6[1m]',
  'claude-haiku-4-5-20251001',
]

// Mirror of src/utils/claude-model-presets.ts CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS,
// plus the auto-compact preset entries. Drift guard (test suite) re-reads
// the TS file and sorted-equals the keys against this map. Used by
// claude.getContextUsage to compute the maxTokens budget.
export const CLAUDE_MODEL_CONTEXT_WINDOWS = new Map([
  ['claude-opus-4-7', 1000000],
  ['claude-opus-4-7[1m]', 1000000],
  ['claude-opus-4-6', 1000000],
  ['claude-opus-4-6[1m]', 1000000],
  ['claude-sonnet-4-6', 1000000],
  ['claude-sonnet-4-6[1m]', 1000000],
  ['claude-haiku-4-5-20251001', 200000],
  // Preset variants — auto-compact wraps the underlying claude-opus-4-7,
  // so context window budget is the auto-compact target.
  ['claude-opus-4-7:auto-compact-200k', 200000],
  ['claude-opus-4-7:auto-compact-300k', 300000],
  ['claude-opus-4-7:auto-compact-400k', 400000],
  ['claude-opus-4-7:1m', 1000000],
])

export function expectedContextWindowForModel(model) {
  if (!model) return null
  if (CLAUDE_MODEL_CONTEXT_WINDOWS.has(model)) return CLAUDE_MODEL_CONTEXT_WINDOWS.get(model)
  // Fallback: strip any [1m] suffix and try base id.
  const base = model.replace(/\[1m\]$/, '')
  if (CLAUDE_MODEL_CONTEXT_WINDOWS.has(base)) return CLAUDE_MODEL_CONTEXT_WINDOWS.get(base)
  return null
}

// Mirror of src/utils/claude-model-presets.ts sdkModelForClaudeSelection:
// auto-compact presets all wrap the underlying claude-opus-4-7 base id,
// so the SDK call uses the base id and the auto-compact window is
// configured separately via CLAUDE_CODE_AUTO_COMPACT_WINDOW env.
export const CLAUDE_OPUS_47_PRESETS = new Set([
  'claude-opus-4-7:auto-compact-200k',
  'claude-opus-4-7:auto-compact-300k',
  'claude-opus-4-7:auto-compact-400k',
  'claude-opus-4-7:1m',
])
export function sdkModelForClaudeSelection(model) {
  if (!model) return undefined
  if (CLAUDE_OPUS_47_PRESETS.has(model)) return 'claude-opus-4-7'
  return model
}
