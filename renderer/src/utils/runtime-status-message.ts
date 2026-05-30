import type { TFunction } from 'i18next'

// Host-provided runtime status messages are raw English. Map the known ones to
// i18n keys; anything unrecognized falls back to the original text.
const KNOWN_RUNTIME_MESSAGE_KEYS: Record<string, string> = {
  'Compacting context; still waiting for Claude API response.': 'claude.runtimeStatus.compactingClaude',
  'Preparing Claude request.': 'claude.runtimeStatus.preparingClaude',
  'Still waiting for Claude API response.': 'claude.runtimeStatus.waitingClaude',
  'Still waiting for Codex API response.': 'claude.runtimeStatus.waitingCodex',
  'Resuming Codex thread before retrying the API request.': 'claude.runtimeStatus.resumingCodex',
  'Codex account switched. The next message will start a new Codex thread.':
    'claude.runtimeStatus.codexAccountSwitched',
}

export function translateRuntimeMessage(t: TFunction, raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = KNOWN_RUNTIME_MESSAGE_KEYS[raw]
  return key ? t(key) : raw
}
