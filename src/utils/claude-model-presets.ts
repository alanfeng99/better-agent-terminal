export const CLAUDE_OPUS_47_MODEL = 'claude-opus-4-7'
export const CLAUDE_OPUS_47_1M_SDK_MODEL = 'claude-opus-4-7[1m]'
export const CLAUDE_OPUS_47_200K_PRESET = 'claude-opus-4-7:auto-compact-200k'
export const CLAUDE_OPUS_47_300K_PRESET = 'claude-opus-4-7:auto-compact-300k'
export const CLAUDE_OPUS_47_400K_PRESET = 'claude-opus-4-7:auto-compact-400k'
export const CLAUDE_OPUS_47_1M_PRESET = 'claude-opus-4-7:1m'

export type ClaudeModelInfo = {
  value: string
  displayName: string
  description: string
}

export const CLAUDE_BUILTIN_MODELS: ClaudeModelInfo[] = [
  { value: CLAUDE_OPUS_47_200K_PRESET, displayName: 'Opus 4.7 · 200K Auto-Compact', description: 'claude-opus-4-7 · compact at 200K tokens' },
  { value: CLAUDE_OPUS_47_300K_PRESET, displayName: 'Opus 4.7 · 300K Auto-Compact', description: 'claude-opus-4-7 · compact at 300K tokens' },
  { value: CLAUDE_OPUS_47_400K_PRESET, displayName: 'Opus 4.7 · 400K Auto-Compact', description: 'claude-opus-4-7 · compact at 400K tokens' },
  { value: CLAUDE_OPUS_47_1M_PRESET, displayName: 'Opus 4.7 · 1M', description: 'claude-opus-4-7 · no early auto-compact' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6 (1M)', description: 'claude-opus-4-6 · 1M context' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6 (1M)', description: 'claude-sonnet-4-6 · 1M context' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'claude-haiku-4-5 · fast & lightweight' },
]

export const CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS = new Map<string, number>([
  ['claude-opus-4-7', 1000000],
  ['claude-opus-4-7[1m]', 1000000],
  ['claude-opus-4-6', 1000000],
  ['claude-opus-4-6[1m]', 1000000],
  ['claude-sonnet-4-6', 1000000],
  ['claude-sonnet-4-6[1m]', 1000000],
  ['claude-haiku-4-5-20251001', 200000],
])

const OPUS_47_PRESET_AUTO_COMPACT = new Map<string, number | null>([
  [CLAUDE_OPUS_47_200K_PRESET, 200000],
  [CLAUDE_OPUS_47_300K_PRESET, 300000],
  [CLAUDE_OPUS_47_400K_PRESET, 400000],
  [CLAUDE_OPUS_47_1M_PRESET, null],
])

export function isClaudeModelPreset(model?: string): boolean {
  return !!model && OPUS_47_PRESET_AUTO_COMPACT.has(model)
}

export function normalizeClaudeModelSelection(model?: string): string | undefined {
  return model === CLAUDE_OPUS_47_MODEL || model === CLAUDE_OPUS_47_1M_SDK_MODEL
    ? CLAUDE_OPUS_47_1M_PRESET
    : model
}

export function sdkModelForClaudeSelection(model?: string): string | undefined {
  if (!model) return undefined
  return isClaudeModelPreset(model) ? CLAUDE_OPUS_47_MODEL : model
}

export function autoCompactWindowForClaudeSelection(
  model: string | undefined,
  fallbackAutoCompactWindow?: number | null,
): number | null {
  if (model && OPUS_47_PRESET_AUTO_COMPACT.has(model)) {
    return OPUS_47_PRESET_AUTO_COMPACT.get(model) ?? null
  }
  return fallbackAutoCompactWindow ?? null
}

export function contextWindowForClaudeSelection(model?: string): number | undefined {
  const sdkModel = sdkModelForClaudeSelection(model)
  if (!sdkModel) return undefined
  if (sdkModel === CLAUDE_OPUS_47_MODEL) return 1000000
  if (sdkModel === 'claude-opus-4-7[1m]') return 1000000
  if (sdkModel === 'claude-opus-4-6') return 1000000
  if (sdkModel === 'claude-opus-4-6[1m]') return 1000000
  if (sdkModel === 'claude-sonnet-4-6') return 1000000
  if (sdkModel === 'claude-sonnet-4-6[1m]') return 1000000
  if (sdkModel === 'claude-haiku-4-5-20251001') return 200000
  return CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS.get(sdkModel)
}

export function displayNameForClaudeSelection(model?: string): string {
  if (model === CLAUDE_OPUS_47_200K_PRESET) return 'Opus 4.7 · 200K Auto-Compact'
  if (model === CLAUDE_OPUS_47_300K_PRESET) return 'Opus 4.7 · 300K Auto-Compact'
  if (model === CLAUDE_OPUS_47_400K_PRESET) return 'Opus 4.7 · 400K Auto-Compact'
  if (model === CLAUDE_OPUS_47_MODEL || model === CLAUDE_OPUS_47_1M_SDK_MODEL || model === CLAUDE_OPUS_47_1M_PRESET) return 'Opus 4.7 · 1M'
  if (model === 'claude-opus-4-6' || model === 'claude-opus-4-6[1m]') return 'Opus 4.6 (1M)'
  if (model === 'claude-sonnet-4-6' || model === 'claude-sonnet-4-6[1m]') return 'Sonnet 4.6 (1M)'
  if (model === 'claude-haiku-4-5-20251001') return 'Haiku 4.5'
  return model || ''
}
