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
import { readdir, stat, readFile } from 'node:fs/promises'
import { createReadStream, accessSync, constants as fsConstants } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, basename } from 'node:path'
import { execFile } from 'node:child_process'

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
// authStatus shells out to `claude auth status`, parses the JSON output,
// returns null on any failure (CLI missing, not logged in, parse error).
// This matches the Electron-side handler verbatim.
registerHandler('claude.authStatus', async () => fetchAuthStatus())
// accountList reads the unencrypted account index file written by
// the Electron-side AccountManager. The encrypted credentials live in
// a separate file; this handler never touches them. Until the Tauri
// side has a parallel writer, the list will be empty on a fresh
// install — and that's fine: the renderer's auth UI handles empty
// state correctly.
registerHandler('claude.accountList', async () => readAccountIndex())

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

// Read-only metadata. Two of these are now real implementations:
//   - claude.getCliPath: locate the `claude` binary on PATH (no SDK dep).
//   - claude.listSessions: parse JSONL session files under
//     ~/.claude/projects/<encoded-cwd>/, mirroring the fallback path
//     of the Electron-side claude-agent-manager.listSessionsFallback().
// The rest return inert defaults until @anthropic-ai/claude-agent-sdk
// moves into the sidecar.
registerHandler('claude.getCliPath', async () => findClaudeCliPath() ?? '')
registerHandler('claude.listSessions', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) return []
  return listSessionsFallback(cwd)
})
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

// --- claude.getCliPath / claude.listSessions helpers ----------------------
//
// Both helpers run with no Anthropic SDK dependency. They mirror the
// Electron implementations under electron/claude-agent-manager.ts so the
// renderer sees the same shapes regardless of host.

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const PREVIEW_LINE_LIMIT = 20
const PREVIEW_CHARS = 120
const SESSION_LIST_LIMIT = 50

function findClaudeCliPath() {
  // Walk PATH and look for "claude" (or claude.cmd / claude.exe / claude.bat
  // on Windows). Returns the first match or null. We deliberately do not
  // shell out to `which` / `where` — readdir-by-PATHEXT is cheaper and
  // doesn't depend on platform tooling being present.
  const PATH = process.env.PATH ?? ''
  const sep = platform() === 'win32' ? ';' : ':'
  const dirs = PATH.split(sep).filter(Boolean)
  const exts = platform() === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase())
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext}`)
      try {
        accessSync(candidate, fsConstants.F_OK)
        return candidate
      } catch { /* not here, try next */ }
    }
  }
  return null
}

async function listSessionsFallback(cwd) {
  // Sessions live under ~/.claude/projects/<encoded>/, where <encoded> is
  // the cwd with all non-alphanumeric chars replaced by "-". Windows
  // sometimes case-folds the first letter, so we probe a couple of
  // alt-cased variants to be safe.
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const candidates = [join(CLAUDE_PROJECTS_DIR, encoded)]
  if (platform() === 'win32' && encoded.length > 0) {
    const lower = encoded[0].toLowerCase() + encoded.slice(1)
    const upper = encoded[0].toUpperCase() + encoded.slice(1)
    if (lower !== encoded) candidates.push(join(CLAUDE_PROJECTS_DIR, lower))
    if (upper !== encoded) candidates.push(join(CLAUDE_PROJECTS_DIR, upper))
  }

  const results = []
  for (const dir of candidates) {
    let entries
    try {
      entries = (await readdir(dir)).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of entries) {
      const filePath = join(dir, file)
      const sdkSessionId = basename(file, '.jsonl')
      try {
        const st = await stat(filePath)
        const { preview, messageCount } = await readSessionPreview(filePath)
        results.push({
          sdkSessionId,
          timestamp: st.mtimeMs,
          preview: preview || '(no preview)',
          messageCount,
        })
      } catch { /* skip unreadable */ }
    }
  }

  const seen = new Set()
  const deduped = results.filter(r => {
    if (seen.has(r.sdkSessionId)) return false
    seen.add(r.sdkSessionId)
    return true
  })
  deduped.sort((a, b) => b.timestamp - a.timestamp)
  return deduped.slice(0, SESSION_LIST_LIMIT)
}

async function readSessionPreview(filePath) {
  // Stream up to PREVIEW_LINE_LIMIT lines and stop. We only need the
  // first user message for the preview; any further reading is wasted I/O
  // on JSONL files that can be hundreds of MB.
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let preview = ''
  let messageCount = 0
  let lineCount = 0
  try {
    for await (const line of rl) {
      lineCount++
      if (lineCount > PREVIEW_LINE_LIMIT) break
      try {
        const obj = JSON.parse(line)
        messageCount++
        if (!preview && obj?.type === 'user') {
          const content = obj?.message?.content
          if (typeof content === 'string') {
            preview = content.slice(0, PREVIEW_CHARS)
          } else if (Array.isArray(content)) {
            const textBlock = content.find(b => b?.type === 'text')
            if (textBlock?.text) preview = String(textBlock.text).slice(0, PREVIEW_CHARS)
          }
        }
      } catch { /* skip malformed */ }
    }
  } finally {
    stream.destroy()
  }
  return { preview, messageCount }
}

// Exported for tests.
export { findClaudeCliPath, listSessionsFallback }

// --- claude.authStatus / claude.accountList helpers ----------------------
//
// authStatus shells out to `claude auth status`. The CLI prints JSON on
// stdout when logged in, exits non-zero with a stderr message otherwise.
// Treat both error paths as null so the renderer's auth UI can render
// the "not logged in" state without throwing.
//
// accountList reads the on-disk account index written by the
// Electron-side AccountManager. The path is taken from
// BAT_SIDECAR_DATA_DIR (set by Tauri at spawn) and falls back to a
// platform-default user-data dir. The index file contains only public
// account metadata — never credentials, which live in a separate
// safeStorage-encrypted file the sidecar deliberately does not touch.

const AUTH_STATUS_TIMEOUT_MS = 10_000

function fetchAuthStatus() {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status'], { timeout: AUTH_STATUS_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}

function resolveDataDir() {
  // 1) Honour the env var Tauri sets at spawn.
  const fromEnv = process.env.BAT_SIDECAR_DATA_DIR
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  // 2) Platform defaults — match what Electron's app.getPath('userData')
  //    resolves to so a returning user keeps their accounts.
  const home = homedir()
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return join(appData, 'BetterAgentTerminal')
  }
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'better-agent-terminal')
  }
  return join(home, '.config', 'better-agent-terminal')
}

async function readAccountIndex() {
  const dir = resolveDataDir()
  const path = join(dir, 'claude-accounts.json')
  let raw
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return [] // file doesn't exist yet — fresh install
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [] // corrupt — surface as empty rather than crash
  }
  const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
  // Only return public fields. AccountManager may have written legacy
  // fields like credentialSnapshot here; we strip everything except the
  // documented shape.
  return accounts.map(a => ({
    id: String(a?.id ?? ''),
    email: String(a?.email ?? ''),
    subscriptionType: a?.subscriptionType,
    isDefault: Boolean(a?.isDefault),
    createdAt: typeof a?.createdAt === 'number' ? a.createdAt : 0,
  })).filter(a => a.id && a.email)
}

// Exported for tests.
export { fetchAuthStatus, resolveDataDir, readAccountIndex }

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
