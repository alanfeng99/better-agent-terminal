// Generate the per-session Claude Code hooks configuration that wires
// CLI-side observability events back to BAT's channel bridge.
//
// Each hook is an HTTP type pointing at /hook/<EventName> on the bridge URL.
// The bridge translates the hook payload into the existing claude-channel:*
// event vocabulary so the renderer doesn't need a second event surface.
//
// Hook event names follow the official Claude Code naming. Matchers use "*"
// where "fire on every occurrence" is wanted.

export const HOOK_EVENT_NAMES = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'MessageDisplay',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
])

// Events that need a matcher (Claude Code requires a matcher entry, "*"
// means "match every occurrence"). The values match the Hooks reference.
const DEFAULT_MATCHER = '*'

function hookEntry(url, eventName) {
  return {
    matcher: DEFAULT_MATCHER,
    hooks: [
      {
        type: 'http',
        url: `${url}/hook/${eventName}`,
      },
    ],
  }
}

// Build the settings.json hooks fragment for a single session. The returned
// object can be merged with other settings keys (ultracode, etc.) before
// being passed to claude via --settings.
export function buildClaudeChannelHooksConfig(bridgeUrl) {
  if (!bridgeUrl || typeof bridgeUrl !== 'string') {
    throw new Error('buildClaudeChannelHooksConfig: bridgeUrl is required')
  }
  const trimmed = bridgeUrl.replace(/\/+$/, '')
  const hooks = {}
  for (const eventName of HOOK_EVENT_NAMES) {
    hooks[eventName] = [hookEntry(trimmed, eventName)]
  }
  return { hooks }
}
