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
