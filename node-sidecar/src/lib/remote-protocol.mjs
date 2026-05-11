// Remote protocol allowlists, ported verbatim from
// electron/remote/protocol.ts so the upcoming sidecar WebSocket server
// (Phase 3) shares the same channel/event contract with Electron.
//
// PROXIED_CHANNELS: invoke-style host APIs that a remote client may call.
//                   Anything not in this set is rejected before dispatch.
// PROXIED_EVENTS:   host→client push events. Only frames whose channel is
//                   in this set are broadcast to authenticated clients.
//
// Keep these lists in lockstep with electron/remote/protocol.ts. The
// sidecar test asserts parity by reading the Electron source and diffing.

export const PROXIED_CHANNELS = new Set([
  // PTY
  'pty:create', 'pty:write', 'pty:resize', 'pty:kill', 'pty:restart', 'pty:get-cwd',
  // Claude
  'claude:start-session', 'claude:send-message', 'claude:stop-session', 'claude:abort-session',
  'claude:set-permission-mode', 'claude:set-codex-sandbox-mode', 'claude:set-codex-approval-policy', 'claude:set-model', 'claude:set-effort', 'claude:reset-session',
  'claude:set-auto-continue', 'claude:get-auto-continue',
  'claude:get-supported-models', 'claude:get-account-info', 'claude:get-supported-commands', 'claude:get-supported-agents', 'claude:get-session-state', 'claude:get-session-meta',
  'claude:get-worktree-status', 'claude:cleanup-worktree',
  'claude:resolve-permission', 'claude:resolve-ask-user',
  'claude:list-sessions', 'claude:resume-session', 'claude:fork-session', 'claude:rewind-to-prompt', 'claude:stop-task', 'claude:rest-session',
  'claude:wake-session', 'claude:is-resting',
  'claude:archive-messages', 'claude:load-archived', 'claude:clear-archive', 'claude:fetch-subagent-messages',
  'claude:scan-skills', 'claude:get-context-usage',
  'claude:auth-login', 'claude:auth-status', 'claude:auth-logout',
  'claude:account-list', 'claude:account-import-current', 'claude:account-login-new',
  'claude:account-switch', 'claude:account-remove', 'claude:account-mark-warning-shown',
  'claude:get-cli-path',
  // Standalone worktree operations (for claude-cli preset)
  'worktree:create', 'worktree:remove', 'worktree:status', 'worktree:merge', 'worktree:rehydrate',
  // Workspace
  'workspace:save', 'workspace:load',
  // Settings
  'settings:save', 'settings:load', 'settings:get-shell-path', 'settings:detect-cx',
  // GitHub
  'github:check-cli', 'github:pr-list', 'github:issue-list', 'github:pr-view', 'github:issue-view',
  'github:pr-comment', 'github:issue-comment',
  // Git
  'git:branch', 'git:log', 'git:diff', 'git:diff-files', 'git:status', 'git:get-github-url', 'git:getRoot',
  // FS
  'fs:readdir', 'fs:readFile', 'fs:search', 'fs:watch', 'fs:unwatch',
  'fs:home', 'fs:list-dirs', 'fs:mkdir', 'fs:delete-path', 'fs:quick-locations', 'fs:resolve-path-links',
  'image:read-as-data-url',
  // OpenAI direct agent settings
  'openai:list-sessions', 'openai:get-api-key-status', 'openai:set-api-key',
  'openai:clear-api-key', 'openai:compact-now',
  // Snippet
  'snippet:getAll', 'snippet:getById', 'snippet:create', 'snippet:update',
  'snippet:delete', 'snippet:toggleFavorite', 'snippet:search',
  'snippet:getCategories', 'snippet:getFavorites', 'snippet:getByWorkspace',
  // Profile
  'profile:list', 'profile:load', 'profile:load-snapshot', 'profile:get-active-ids', 'profile:activate', 'profile:deactivate',
  // Agent presets supported by host
  'agent:list-presets',
])

export const PROXIED_EVENTS = new Set([
  'pty:output', 'pty:exit',
  'claude:message', 'claude:tool-use', 'claude:tool-result',
  'claude:stream', 'claude:result', 'claude:turn-end', 'claude:error',
  'claude:status', 'claude:permission-request', 'claude:permission-resolved', 'claude:ask-user', 'claude:ask-user-resolved',
  'claude:modeChange', 'claude:history', 'claude:resume-loading', 'claude:prompt-suggestion', 'claude:session-reset', 'claude:worktree-info', 'claude:rate-limit',
  'fs:changed',
  'workspace:detached', 'workspace:reattached', 'workspace:reload',
  'system:resume',
])

// Channel-handler registry, ported from electron/remote/handler-registry.ts.
// The future WebSocket server will consume registerRemoteHandler() to wire
// concrete invoke handlers; for now the registry is empty and only the
// protocol module exists so the upcoming server slice has a stable surface
// to build against.

const remoteHandlers = new Map()

export function registerRemoteHandler(channel, handler) {
  if (typeof channel !== 'string' || !channel) {
    throw new Error('registerRemoteHandler: channel must be a non-empty string')
  }
  if (typeof handler !== 'function') {
    throw new Error('registerRemoteHandler: handler must be a function')
  }
  remoteHandlers.set(channel, handler)
}

export function hasRemoteHandler(channel) {
  return remoteHandlers.has(channel)
}

export async function invokeRemoteHandler(channel, args, windowId = null, isRemote = false) {
  const handler = remoteHandlers.get(channel)
  if (!handler) throw new Error(`No handler for channel: ${channel}`)
  if (!Array.isArray(args)) args = []
  return await handler({ windowId, isRemote }, ...args)
}

export function __resetRemoteHandlersForTests() {
  remoteHandlers.clear()
}

export function __remoteHandlerCountForTests() {
  return remoteHandlers.size
}
