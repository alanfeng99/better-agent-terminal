export const CLAUDE_RUNTIME_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export function normalizeClaudeEffortMode(effort, ultracode = false) {
  if (ultracode === true || effort === 'ultracode') return 'ultracode'
  return CLAUDE_RUNTIME_EFFORTS.has(effort) ? effort : null
}

export function runtimeEffortForMode(mode) {
  return mode === 'ultracode' ? 'xhigh' : mode
}

export function isUltracodeMode(mode) {
  return mode === 'ultracode'
}
