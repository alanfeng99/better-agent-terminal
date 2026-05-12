// Remote invoke bridge — wires every PROXIED_CHANNEL to the sidecar's
// JSON-RPC dispatch.
//
// The remote WebSocket server hands incoming `invoke` frames off to
// `invokeRemoteHandler(channel, args)` (from remote-protocol.mjs). Until
// this bridge is wired the registry is empty and every allowed channel
// surfaces "Channel is allowed but not yet bridged to sidecar dispatch".
// This module fills that registry with one auto-bridge per channel that
// turns the kebab-style channel into the equivalent JSON-RPC method
// (`claude:start-session` → `claude.startSession`) and forwards invoke
// args as the JSON-RPC `params` object.
//
// Protocol compatibility:
// - legacy-v1 Electron clients send IPC-shaped positional args
//   (`claude:send-message`, sessionId, prompt, images, autoCompactWindow,
//   clientMessageId?, displayPrompt?, suppressUserEcho?).
// - current sidecar handlers take one named-params object
//   (`{ sessionId, prompt, images, autoCompactWindow }`).
//
// Keep the legacy-v1 adapter isolated here so the next protocol spec can
// move to explicit named params without carrying positional semantics into
// every handler. Once legacy Electron remote clients are retired, delete
// LEGACY_V1_PARAM_KEYS / LEGACY_V1_CUSTOM_PARAMS and pass args[0] through.
//
// Channels that have no sidecar handler (e.g. `pty:*`, `git:*`, `fs:*`
// — those live in Tauri Rust commands and aren't reachable from the
// sidecar process) propagate JSON-RPC -32601 "method not found" as the
// invoke-error message. Renderer code already branches on `'error' in
// result`, so the failure surface stays identical to the "not yet
// bridged" path that preceded this slice.

import { PROXIED_CHANNELS, registerRemoteHandler, hasRemoteHandler } from './remote-protocol.mjs'
import { dispatch } from './protocol.mjs'

const LEGACY_V1_PARAM_KEYS = new Map([
  ['settings:save', ['data']],
  ['settings:get-shell-path', ['shellType']],
  ['image:read-as-data-url', ['filePath']],

  ['claude:send-message', [
    'sessionId',
    'prompt',
    'images',
    'autoCompactWindow',
    'clientMessageId',
    'displayPrompt',
    'suppressUserEcho',
  ]],
  ['claude:stop-session', ['sessionId']],
  ['claude:abort-session', ['sessionId']],
  ['claude:set-auto-continue', ['sessionId', 'opts']],
  ['claude:get-auto-continue', ['sessionId']],
  ['claude:set-permission-mode', ['sessionId', 'mode']],
  ['claude:set-codex-sandbox-mode', ['sessionId', 'mode']],
  ['claude:set-codex-approval-policy', ['sessionId', 'policy']],
  ['claude:set-model', ['sessionId', 'model', 'autoCompactWindow']],
  ['claude:set-effort', ['sessionId', 'effort']],
  ['claude:reset-session', ['sessionId']],
  ['claude:get-supported-models', ['sessionId']],
  ['claude:get-account-info', ['sessionId']],
  ['claude:get-supported-commands', ['sessionId']],
  ['claude:get-supported-agents', ['sessionId']],
  ['claude:get-session-state', ['sessionId']],
  ['claude:get-session-meta', ['sessionId']],
  ['claude:get-worktree-status', ['sessionId']],
  ['claude:cleanup-worktree', ['sessionId', 'deleteBranch']],
  ['claude:scan-skills', ['cwd']],
  ['claude:get-context-usage', ['sessionId']],
  ['claude:resolve-permission', ['sessionId', 'toolUseId', 'result']],
  ['claude:resolve-ask-user', ['sessionId', 'toolUseId', 'answers']],
  ['claude:list-sessions', ['cwd', 'agentKind']],
  ['claude:fork-session', ['sessionId']],
  ['claude:rewind-to-prompt', ['sessionId', 'promptIndex']],
  ['claude:stop-task', ['sessionId', 'taskId']],
  ['claude:rest-session', ['sessionId']],
  ['claude:wake-session', ['sessionId']],
  ['claude:is-resting', ['sessionId']],
  ['claude:archive-messages', ['sessionId', 'messages']],
  ['claude:load-archived', ['sessionId', 'offset', 'limit']],
  ['claude:clear-archive', ['sessionId']],
  ['claude:fetch-subagent-messages', ['sessionId', 'agentToolUseId']],
  ['claude:account-switch', ['accountId']],
  ['claude:account-remove', ['accountId']],

  ['worktree:create', ['sessionId', 'cwd']],
  ['worktree:remove', ['sessionId', 'deleteBranch']],
  ['worktree:status', ['sessionId']],
  ['worktree:merge', ['sessionId', 'strategy']],
  ['worktree:rehydrate', ['sessionId', 'cwd', 'worktreePath', 'branchName']],

  ['git:get-github-url', ['folderPath']],
  ['git:branch', ['cwd']],
  ['git:log', ['cwd', 'count']],
  ['git:diff', ['cwd', 'commitHash', 'filePath']],
  ['git:diff-files', ['cwd', 'commitHash']],
  ['git:status', ['cwd']],
  ['git:getRoot', ['cwd']],

  ['fs:readdir', ['dirPath']],
  ['fs:readFile', ['filePath']],
  ['fs:search', ['dirPath', 'query']],
  ['fs:watch', ['dirPath']],
  ['fs:unwatch', ['dirPath']],
  ['fs:list-dirs', ['dirPath', 'includeHidden']],
  ['fs:mkdir', ['parentPath', 'name']],
  ['fs:delete-path', ['targetPath']],
  ['fs:resolve-path-links', ['cwd', 'rawPaths']],

  ['github:pr-list', ['cwd']],
  ['github:issue-list', ['cwd']],
  ['github:pr-view', ['cwd', 'number']],
  ['github:issue-view', ['cwd', 'number']],
  ['github:pr-comment', ['cwd', 'number', 'body']],
  ['github:issue-comment', ['cwd', 'number', 'body']],

  ['openai:list-sessions', ['cwd']],
  ['openai:set-api-key', ['key']],
  ['openai:compact-now', ['sessionId']],

  ['profile:load', ['profileId']],
  ['profile:load-snapshot', ['profileId']],
  ['profile:activate', ['profileId']],
  ['profile:deactivate', ['profileId']],

  ['snippet:getById', ['id']],
  ['snippet:create', ['input']],
  ['snippet:update', ['id', 'updates']],
  ['snippet:delete', ['id']],
  ['snippet:toggleFavorite', ['id']],
  ['snippet:search', ['query']],
  ['snippet:getByWorkspace', ['workspaceId']],
])

const LEGACY_V1_CUSTOM_PARAMS = new Map([
  ['claude:start-session', args => ({
    sessionId: args[0],
    options: args[1] ?? null,
  })],
  ['claude:resume-session', args => ({
    sessionId: args[0],
    sdkSessionId: args[1],
    options: {
      cwd: args[2],
      model: args[3],
      apiVersion: args[4],
      useWorktree: args[5],
      worktreePath: args[6],
      worktreeBranch: args[7],
      agentPreset: args[8],
      codexSandboxMode: args[9],
      codexApprovalPolicy: args[10],
      permissionMode: args[11],
      effort: args[12],
    },
  })],
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stripUndefined(value) {
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
}

export function legacyV1ArgsToParams(channel, args) {
  const values = Array.isArray(args) ? args : []
  if (values.length === 0) return null
  if (values.length === 1 && isPlainObject(values[0])) return values[0]

  const custom = LEGACY_V1_CUSTOM_PARAMS.get(channel)
  if (custom) {
    const params = custom(values)
    if (isPlainObject(params) && isPlainObject(params.options)) {
      return { ...params, options: stripUndefined(params.options) }
    }
    return stripUndefined(params)
  }

  const keys = LEGACY_V1_PARAM_KEYS.get(channel)
  if (!keys) return values[0]

  const params = {}
  keys.forEach((key, index) => {
    if (values[index] !== undefined) params[key] = values[index]
  })
  return params
}

// kebab-style channel → camelCase JSON-RPC method.
//   'claude:start-session'    → 'claude.startSession'
//   'image:read-as-data-url'  → 'image.readAsDataUrl'
//   'snippet:toggleFavorite'  → 'snippet.toggleFavorite'  (no hyphens; pass through)
//   'git:getRoot'             → 'git.getRoot'             (no hyphens; pass through)
export function channelToMethod(channel) {
  if (typeof channel !== 'string' || !channel) {
    throw new Error('channelToMethod: channel must be a non-empty string')
  }
  return channel
    .replace(':', '.')
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

// Build the bridge handler closure once per channel. Capturing the
// translated method name avoids re-running the regex on each invoke.
function makeBridgeHandler(channel) {
  const method = channelToMethod(channel)
  return async function bridgeHandler(_ctx, ...args) {
    const params = legacyV1ArgsToParams(channel, args)
    const reply = await dispatch({ jsonrpc: '2.0', id: 'bridge', method, params })
    if (reply && reply.error) {
      const err = new Error(reply.error.message || `Bridge dispatch failed: ${method}`)
      err.code = reply.error.code
      throw err
    }
    return reply ? reply.result : null
  }
}

// Idempotent. Re-runs are a no-op for channels already wired (skips the
// duplicate registerRemoteHandler call) so server restarts / test resets
// can call this without wiping.
export function wireRemoteBridgeHandlers() {
  let registered = 0
  for (const channel of PROXIED_CHANNELS) {
    if (hasRemoteHandler(channel)) continue
    registerRemoteHandler(channel, makeBridgeHandler(channel))
    registered++
  }
  return registered
}
