// Better Agent Terminal — Node sidecar.
//
// Speaks line-delimited JSON-RPC 2.0 over stdio. Tauri spawns one of these
// per app instance and forwards renderer invocations through it. This file
// is plain ESM JS — no build step — so the same file runs under `node` in
// dev and (eventually) under a bundled Node runtime in release.
//
// Wire format (one JSON object per stdin/stdout line, no Content-Length):
//   request:      {"jsonrpc":"2.0","id":N,"method":"foo.bar","params":...}
//   response ok:  {"jsonrpc":"2.0","id":N,"result":...}
//   response err: {"jsonrpc":"2.0","id":N,"error":{"code":N,"message":"..."}}
//   server event: {"jsonrpc":"2.0","method":"event:name","params":...}
//
// We deliberately ignore JSON-RPC batching for now — every callsite under
// host.* sends one request at a time, so the extra complexity buys nothing.
//
// Run with: node node-sidecar/src/server.mjs
//
// Tests live in node-sidecar/tests/server.test.mjs.

import { createInterface } from 'node:readline'

// Handler registry. Each handler receives `params` (any JSON value) and
// returns either a value or a Promise resolving to one. Throw to signal an
// error — it lands in JSON-RPC error.message verbatim.
const handlers = new Map()

export function registerHandler(method, fn) {
  if (handlers.has(method)) {
    throw new Error(`sidecar: handler already registered for ${method}`)
  }
  handlers.set(method, fn)
}

// --- built-in handlers ------------------------------------------------------

registerHandler('ping', async (params) => {
  // Round-trip echo. Used by the Rust bridge as a startup probe.
  return { ok: true, echo: params ?? null, pid: process.pid }
})

// MVP stubs for the claude.* surface. They return shapes that match the
// Electron-side claudeAccount API so the renderer can render an empty
// "no accounts" state without throwing. Real implementations land
// later when we move @anthropic-ai/claude-agent-sdk into the sidecar.
registerHandler('claude.authStatus', async () => null)
registerHandler('claude.accountList', async () => [])

// Session lifecycle stubs. Until the agent SDK actually moves into the
// sidecar, these just acknowledge the call and synthesise a minimal
// "turn-end" event so the renderer's lifecycle wiring can be exercised
// end-to-end without a real model. They keep an in-memory map of
// known sessionIds purely so stop/abort can return useful flags.
const sessions = new Map()

registerHandler('claude.startSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.startSession: missing sessionId')
  }
  sessions.set(sessionId, { active: true, options: params?.options ?? null })
  return { ok: true, sessionId }
})

registerHandler('claude.sendMessage', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.sendMessage: missing sessionId')
  }
  // Echo a fake message + turn-end so listeners on the renderer can
  // observe the event path without a live model. Real handlers will
  // stream from @anthropic-ai/claude-agent-sdk.
  sendEvent('claude:message', { sessionId, message: { role: 'assistant', content: '(stub reply)' } })
  sendEvent('claude:turn-end', { sessionId, payload: { reason: 'completed', result: '(stub)' } })
  return { ok: true }
})

registerHandler('claude.stopSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.stopSession: missing sessionId')
  }
  const existed = sessions.delete(sessionId)
  return { ok: true, existed }
})

registerHandler('claude.abortSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.abortSession: missing sessionId')
  }
  const session = sessions.get(sessionId)
  if (session) {
    session.active = false
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'aborted' } })
  }
  return { ok: true }
})

// Auth + account stubs. The renderer's auth UI calls these on every panel
// mount, so they need to return shapes that don't throw at the type level.
// Real impls will land when @anthropic-ai/claude-agent-sdk + the keychain
// integration move into the sidecar.
const STUB_AUTH_ERR = 'claude account ops not yet wired through Tauri sidecar'

registerHandler('claude.authLogin', async () => ({ success: false, error: STUB_AUTH_ERR }))
registerHandler('claude.authLogout', async () => ({ success: true }))
registerHandler('claude.accountImportCurrent', async () => null)
registerHandler('claude.accountLoginNew', async () => ({ success: false, error: STUB_AUTH_ERR }))
registerHandler('claude.accountSwitch', async (params) => {
  if (typeof params?.accountId !== 'string') {
    throw new Error('claude.accountSwitch: missing accountId')
  }
  return false
})
registerHandler('claude.accountRemove', async (params) => {
  if (typeof params?.accountId !== 'string') {
    throw new Error('claude.accountRemove: missing accountId')
  }
  return false
})
registerHandler('claude.accountMarkWarningShown', async () => true)

// Read-only metadata stubs. All return inert defaults so the renderer
// renders empty rather than crashing.
registerHandler('claude.getCliPath', async () => '')
registerHandler('claude.listSessions', async () => [])
registerHandler('claude.getSupportedModels', async () => [])
registerHandler('claude.getSupportedCommands', async () => [])
registerHandler('claude.getSupportedAgents', async () => [])
registerHandler('claude.getAccountInfo', async () => null)
registerHandler('claude.getSessionState', async () => null)
registerHandler('claude.getSessionMeta', async () => null)
registerHandler('claude.getContextUsage', async () => null)
registerHandler('claude.getWorktreeStatus', async () => null)

// --- openai.* stubs --------------------------------------------------------

registerHandler('openai.getApiKeyStatus', async () => ({ hasKey: false }))
registerHandler('openai.setApiKey', async (params) => {
  if (typeof params?.apiKey !== 'string') {
    throw new Error('openai.setApiKey: missing apiKey')
  }
  return false
})
registerHandler('openai.clearApiKey', async () => true)
registerHandler('openai.listSessions', async () => [])
registerHandler('openai.compactNow', async (params) => {
  if (typeof params?.sessionId !== 'string' || !params.sessionId) {
    throw new Error('openai.compactNow: missing sessionId')
  }
  return false
})

// --- worktree.* stubs ------------------------------------------------------
//
// Until the agent worktree manager moves into the sidecar, these report
// success:false with a clear error so the renderer's worktree panel
// shows a "feature unavailable" hint rather than crashing.

const WORKTREE_STUB_ERR = 'worktree ops not yet wired through Tauri sidecar'
registerHandler('worktree.create', async () => ({ success: false, error: WORKTREE_STUB_ERR }))
registerHandler('worktree.remove', async () => ({ success: false, error: WORKTREE_STUB_ERR }))
registerHandler('worktree.status', async () => null)
registerHandler('worktree.merge', async () => ({ success: false, error: WORKTREE_STUB_ERR }))
registerHandler('worktree.rehydrate', async () => ({ success: false }))

// --- agent.* ---------------------------------------------------------------
//
// Single read-only method today: which presets the host knows how to
// start. Returns an empty list until presets are registered in the
// sidecar. Renderer treats empty list as "no advanced presets available".
registerHandler('agent.listPresets', async () => [])

// --- remote.* / tunnel.* stubs --------------------------------------------
//
// remote/tunnel run the cross-machine server and the LAN/Tailscale
// presence advertiser. Real implementations will land in Phase 3 (or as
// a sibling sidecar). For now we return shapes that match the renderer's
// destructuring contract so polling clientStatus / serverStatus doesn't
// crash when it reads `.connected` / `.running`.

const REMOTE_STUB_ERR = 'remote ops not yet wired through Tauri sidecar'
registerHandler('remote.startServer', async () => ({ error: REMOTE_STUB_ERR }))
registerHandler('remote.stopServer', async () => false)
registerHandler('remote.serverStatus', async () => ({
  running: false, port: null, fingerprint: null, bindInterface: null, boundHost: null, clients: [],
}))
registerHandler('remote.connect', async () => ({ error: REMOTE_STUB_ERR }))
registerHandler('remote.disconnect', async () => false)
registerHandler('remote.clientStatus', async () => ({ connected: false, info: null }))
registerHandler('remote.testConnection', async () => ({ ok: false, error: REMOTE_STUB_ERR }))
registerHandler('remote.listProfiles', async () => ({ error: REMOTE_STUB_ERR }))

registerHandler('tunnel.getConnection', async () => ({ error: 'tunnel not yet wired through Tauri sidecar' }))

// --- update.check ----------------------------------------------------------
//
// Pings the GitHub Releases API and compares the latest tag against the
// version Tauri passed in. We let the Rust side own the "what's my
// version" string (it reads PackageInfo and forwards it as `currentVersion`
// in the params), so the sidecar stays runtime-agnostic.

const GITHUB_REPO = 'tony1223/better-agent-terminal'

function compareVersions(current, latest) {
  const a = current.replace(/^v/, '').split('.').map(Number)
  const b = latest.replace(/^v/, '').split('.').map(Number)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ai = a[i] || 0
    const bi = b[i] || 0
    if (bi > ai) return true
    if (bi < ai) return false
  }
  return false
}

registerHandler('update.check', async (params) => {
  const currentVersion = String(params?.currentVersion ?? '0.0.0')
  const fallback = { hasUpdate: false, currentVersion, latestRelease: null }
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        'User-Agent': 'Better-Agent-Terminal',
        'Accept': 'application/vnd.github.v3+json',
      },
    })
    if (!res.ok) return fallback
    const release = await res.json()
    if (!release || typeof release.tag_name !== 'string') return fallback
    const latestVersion = release.tag_name.replace(/^v/, '')
    let downloadUrl = null
    if (Array.isArray(release.assets)) {
      const winAsset = release.assets.find(a =>
        typeof a?.name === 'string' && (a.name.endsWith('-win.zip') || a.name.includes('win'))
      )
      if (winAsset?.browser_download_url) downloadUrl = winAsset.browser_download_url
    }
    return {
      hasUpdate: compareVersions(currentVersion, latestVersion),
      currentVersion,
      latestRelease: {
        version: latestVersion,
        tagName: release.tag_name,
        htmlUrl: release.html_url,
        downloadUrl,
        body: release.body || '',
        publishedAt: release.published_at,
      },
    }
  } catch {
    return fallback
  }
})

// Exported for unit tests.
export { compareVersions }

// --- protocol ---------------------------------------------------------------

function writeMessage(obj) {
  // Single write to keep the line atomic. Node guarantees a single
  // synchronous write to a pipe doesn't interleave with another writer in
  // this process.
  process.stdout.write(JSON.stringify(obj) + '\n')
}

export function sendEvent(name, params) {
  writeMessage({ jsonrpc: '2.0', method: `event:${name}`, params: params ?? null })
}

async function dispatch(message) {
  if (!message || typeof message !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }
  }
  const { id, method, params } = message
  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'missing method' } }
  }
  const handler = handlers.get(method)
  if (!handler) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `method not found: ${method}` } }
  }
  try {
    const result = await handler(params)
    // Notifications (no id) get no response.
    if (id === undefined || id === null) return null
    return { jsonrpc: '2.0', id, result: result ?? null }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

// --- main ------------------------------------------------------------------

function main() {
  // readline handles CR/LF differences, partial chunks, and large lines
  // without us needing to buffer-and-split manually.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    const reply = await dispatch(parsed)
    if (reply) writeMessage(reply)
  })
  rl.on('close', () => {
    // Stdin closed — Tauri parent went away. Exit cleanly so we don't
    // become a zombie if the process tree teardown is unusual on Windows.
    process.exit(0)
  })
}

// import.meta.url comparison handles both `node server.mjs` and being
// imported by tests. When imported, main() is not run and the test can
// drive `dispatch` directly via the exported handlers.
const isMain = (() => {
  try {
    const entry = process.argv[1] ? new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href : ''
    return entry === import.meta.url
  } catch {
    return false
  }
})()

if (isMain) main()

// Exported for tests. Keep the surface tiny: handlers map, plus the
// dispatcher used by in-process tests. Adding a new handler just means
// calling registerHandler('ns.method', fn) above.
export { handlers, dispatch }
