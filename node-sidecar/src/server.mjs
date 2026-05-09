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
// end-to-end without a real model. The session map also holds the
// configuration the renderer pushes via setAutoContinue / setModel /
// setPermissionMode / setEffort so getters return consistent values.
const sessions = new Map()

function ensureSession(sessionId) {
  let s = sessions.get(sessionId)
  if (!s) {
    s = {
      active: false,
      options: null,
      // Renderer-controlled config; defaults match Electron's session
      // defaults so getters before any setter calls don't surprise the UI.
      model: undefined,
      autoCompactWindow: null,
      effort: undefined,
      permissionMode: 'default',
      autoContinue: { enabled: false, max: 0, used: 0, prompt: '' },
    }
    sessions.set(sessionId, s)
  }
  return s
}

registerHandler('claude.startSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.startSession: missing sessionId')
  }
  const s = ensureSession(sessionId)
  s.active = true
  s.options = params?.options ?? null
  // Some options carry per-session config the renderer expects to read
  // back via getSessionMeta — capture them now.
  if (s.options && typeof s.options === 'object') {
    if (typeof s.options.model === 'string') s.model = s.options.model
    if (typeof s.options.permissionMode === 'string') s.permissionMode = s.options.permissionMode
    if (typeof s.options.effort === 'string') s.effort = s.options.effort
    if (typeof s.options.autoCompactWindow === 'number') s.autoCompactWindow = s.options.autoCompactWindow
  }
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

// Per-session state setters. These persist values into the session map
// so getters return what the renderer last set. When the SDK lands,
// these hooks will additionally push the change into the live query
// instance (e.g. set the model on a streaming session). For now they
// just maintain the visible state contract.

registerHandler('claude.setAutoContinue', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const opts = params?.opts || params?.options || {}
  const s = ensureSession(sessionId)
  if (typeof opts.enabled === 'boolean') s.autoContinue.enabled = opts.enabled
  if (typeof opts.max === 'number') s.autoContinue.max = opts.max
  if (typeof opts.prompt === 'string') s.autoContinue.prompt = opts.prompt
  // Reset usage counter when toggling, matches Electron behaviour.
  s.autoContinue.used = 0
  return true
})

registerHandler('claude.getAutoContinue', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return null
  const s = sessions.get(sessionId)
  return s ? { ...s.autoContinue } : null
})

registerHandler('claude.setPermissionMode', async (params) => {
  const sessionId = params?.sessionId
  const mode = params?.mode
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof mode !== 'string') return false
  const s = ensureSession(sessionId)
  s.permissionMode = mode
  // Mirror Electron's claude:modeChange event so listeners refresh.
  sendEvent('claude:modeChange', { sessionId, mode })
  return true
})

registerHandler('claude.setModel', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const s = ensureSession(sessionId)
  if (typeof params?.model === 'string') s.model = params.model
  if (typeof params?.autoCompactWindow === 'number') s.autoCompactWindow = params.autoCompactWindow
  return true
})

registerHandler('claude.setEffort', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const s = ensureSession(sessionId)
  if (typeof params?.effort === 'string') s.effort = params.effort
  return true
})

registerHandler('claude.resetSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  // Drop the session record entirely. Next startSession recreates it.
  return sessions.delete(sessionId)
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
// Returns the builtin claude model list. Mirrors the renderer-side
// CLAUDE_BUILTIN_MODELS constant from src/utils/claude-model-presets.ts;
// a drift-guard test re-reads the TS file and asserts these stay in
// sync. The Electron version augments this with SDK-discovered models —
// that lands when @anthropic-ai/claude-agent-sdk moves into the sidecar.
// For now returning builtins keeps the renderer's model picker populated.
registerHandler('claude.getSupportedModels', async () =>
  CLAUDE_BUILTIN_MODELS.map(m => ({ ...m, source: 'builtin' }))
)
registerHandler('claude.getSupportedCommands', async () => [])
registerHandler('claude.getSupportedAgents', async () => [])
registerHandler('claude.getAccountInfo', async () => null)
// Session state lookups read from the per-session map populated by
// startSession + the various setters above. When no session exists for
// the given id we return null to match Electron's behaviour.
registerHandler('claude.getSessionState', async (params) => {
  const s = sessions.get(String(params?.sessionId ?? ''))
  if (!s) return null
  return {
    active: s.active,
    permissionMode: s.permissionMode,
    model: s.model,
    effort: s.effort,
    autoCompactWindow: s.autoCompactWindow,
  }
})
registerHandler('claude.getSessionMeta', async (params) => {
  const s = sessions.get(String(params?.sessionId ?? ''))
  if (!s) return null
  // Match the Electron getSessionMeta shape: spread metadata plus
  // permissionMode. We don't store agent metadata yet, so the return
  // is just the visible knobs.
  return {
    permissionMode: s.permissionMode,
    model: s.model,
    effort: s.effort,
    autoCompactWindow: s.autoCompactWindow,
  }
})
registerHandler('claude.getContextUsage', async () => null)
registerHandler('claude.getWorktreeStatus', async (params) => {
  const sessionId = String(params?.sessionId ?? '')
  if (!sessionId) return null
  const info = activeWorktrees.get(sessionId)
  if (!info) return null
  return worktreeStatus(sessionId)
})
// claude.scanSkills walks <cwd>/.claude/skills + ~/.claude/skills and
// returns SkillMeta entries. No SDK dep — pure fs walk + YAML
// frontmatter parsing. Mirrors electron/openai-agent/skills-scanner.ts.
// claude.cleanupWorktree drops the worktree associated with a session.
// In the Electron flow it also resets the agent session's cwd back to
// originalCwd and emits claude:worktree-info — those happen in the
// session manager, which still lives in the renderer/Electron side
// for now. The sidecar just runs the disk-level cleanup.
registerHandler('claude.cleanupWorktree', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const deleteBranch = params?.deleteBranch !== false
  if (!sessionId) return false
  try {
    await worktreeRemove(sessionId, deleteBranch)
    sendEvent('claude:worktree-info', { sessionId, payload: null })
    return true
  } catch {
    return false
  }
})
registerHandler('claude.scanSkills', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) return []
  return scanSkills(cwd)
})

// --- openai.* stubs --------------------------------------------------------

registerHandler('openai.getApiKeyStatus', async () => ({ hasKey: false }))
registerHandler('openai.setApiKey', async (params) => {
  if (typeof params?.apiKey !== 'string') {
    throw new Error('openai.setApiKey: missing apiKey')
  }
  return false
})
registerHandler('openai.clearApiKey', async () => true)
// openai.listSessions reads ~/.better-agent-terminal/openai-sessions/
//   <yyyy>/<mm>/<dd>/<sdkSessionId>.jsonl. Mirrors persistence.listAllSessions
// from electron/openai-agent/persistence.ts. The cwd parameter is
// accepted but unused — the Electron impl ignores it too because
// OpenAI sessions aren't grouped by working directory.
registerHandler('openai.listSessions', async () => listOpenAISessions())
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

// worktree.* — real port of electron/worktree-manager.ts. Pure git
// execFile + fs ops, no Anthropic SDK dependency. State lives in this
// sidecar process for its lifetime (matches the Electron singleton).
registerHandler('worktree.create', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!sessionId || !cwd) {
    return { success: false, error: 'worktree.create: missing sessionId or cwd' }
  }
  try {
    const info = await worktreeCreate(sessionId, cwd)
    return { success: true, ...info }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})
registerHandler('worktree.remove', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const deleteBranch = params?.deleteBranch !== false
  if (!sessionId) return { success: false, error: 'worktree.remove: missing sessionId' }
  try {
    await worktreeRemove(sessionId, deleteBranch)
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})
registerHandler('worktree.status', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  if (!sessionId) return null
  return worktreeStatus(sessionId)
})
// merge stays a stub — the Electron register-handlers calls a method
// (mergeWorktree) that doesn't exist on WorktreeManager, so the feature
// is broken on Electron too. We keep it stub-routed and surface a
// clear error rather than implementing something the Electron build
// can't validate against.
registerHandler('worktree.merge', async () => ({
  success: false,
  error: 'worktree.merge not implemented (electron parity)',
}))
registerHandler('worktree.rehydrate', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  const worktreePath = typeof params?.worktreePath === 'string' ? params.worktreePath : ''
  const branchName = typeof params?.branchName === 'string' ? params.branchName : ''
  if (!sessionId || !worktreePath) return { success: false }
  worktreeRehydrate(sessionId, cwd, worktreePath, branchName)
  return { success: true }
})

// --- agent.* ---------------------------------------------------------------
//
// Single read-only method today: which presets the host knows how to
// start. Mirrored from src/types/agent-presets.ts AGENT_PRESETS — the
// renderer's NewTerminalQuickPick uses this to gate which preset cards
// render. Returning [] would gray out the entire picker. Keep this
// list in sync with the renderer constant; if you add a preset there
// without updating this, the new card will not be listed under Tauri.
const AGENT_PRESET_IDS = [
  'claude-code',
  'claude-code-v2',
  'claude-code-worktree',
  'claude-cli',
  'claude-cli-worktree',
  'codex-agent',
  'codex-agent-worktree',
  'openai-agent',
  'codex-cli',
  'none',
]
registerHandler('agent.listPresets', async () => AGENT_PRESET_IDS)
export { AGENT_PRESET_IDS }

// Mirror of src/utils/claude-model-presets.ts CLAUDE_BUILTIN_MODELS.
// Drift guard: see node-sidecar/tests/server.test.mjs.
const CLAUDE_BUILTIN_MODELS = [
  { value: 'claude-opus-4-7:auto-compact-200k', displayName: 'Opus 4.7 · 200K Auto-Compact', description: 'claude-opus-4-7 · compact at 200K tokens' },
  { value: 'claude-opus-4-7:auto-compact-300k', displayName: 'Opus 4.7 · 300K Auto-Compact', description: 'claude-opus-4-7 · compact at 300K tokens' },
  { value: 'claude-opus-4-7:auto-compact-400k', displayName: 'Opus 4.7 · 400K Auto-Compact', description: 'claude-opus-4-7 · compact at 400K tokens' },
  { value: 'claude-opus-4-7:1m', displayName: 'Opus 4.7 · 1M', description: 'claude-opus-4-7 · no early auto-compact' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6 (1M)', description: 'claude-opus-4-6 · 1M context' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6 (1M)', description: 'claude-sonnet-4-6 · 1M context' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'claude-haiku-4-5 · fast & lightweight' },
]
export { CLAUDE_BUILTIN_MODELS }

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

// --- openai.listSessions helper ------------------------------------------
//
// Walks ~/.better-agent-terminal/openai-sessions/<yyyy>/<mm>/<dd>/*.jsonl
// and returns SessionSummary entries. Mirrors
// electron/openai-agent/persistence.ts's listAllSessions().

const OPENAI_SESSIONS_ROOT = join(homedir(), '.better-agent-terminal', 'openai-sessions')

async function listOpenAISessions() {
  const results = []
  let years
  try {
    years = (await readdir(OPENAI_SESSIONS_ROOT, { withFileTypes: true })).filter(e => e.isDirectory())
  } catch {
    return [] // root doesn't exist — fresh install
  }
  for (const y of years) {
    const yp = join(OPENAI_SESSIONS_ROOT, y.name)
    let months
    try { months = (await readdir(yp, { withFileTypes: true })).filter(e => e.isDirectory()) } catch { continue }
    for (const m of months) {
      const mp = join(yp, m.name)
      let days
      try { days = (await readdir(mp, { withFileTypes: true })).filter(e => e.isDirectory()) } catch { continue }
      for (const dd of days) {
        const dp = join(mp, dd.name)
        let files
        try {
          files = (await readdir(dp, { withFileTypes: true }))
            .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
        } catch { continue }
        for (const f of files) {
          const full = join(dp, f.name)
          const id = f.name.replace(/\.jsonl$/, '')
          try {
            const st = await stat(full)
            const content = await readFile(full, 'utf-8').catch(() => '')
            let preview = ''
            let count = 0
            for (const line of content.split('\n')) {
              if (!line.trim()) continue
              count++
              if (!preview) {
                try {
                  const entry = JSON.parse(line)
                  if (entry?.type === 'user' && typeof entry?.payload?.content === 'string') {
                    preview = entry.payload.content.split('\n')[0].slice(0, 120)
                  }
                } catch { /* skip */ }
              }
            }
            results.push({
              sdkSessionId: id,
              timestamp: st.mtimeMs,
              preview: preview || `(${id.slice(0, 8)}...)`,
              messageCount: count,
            })
          } catch { /* skip */ }
        }
      }
    }
  }
  results.sort((a, b) => b.timestamp - a.timestamp)
  return results
}

export { listOpenAISessions, OPENAI_SESSIONS_ROOT }

// --- claude.scanSkills helper --------------------------------------------
//
// Walks <cwd>/.claude/skills and ~/.claude/skills, picks up
// SKILL.md inside subdirs and *.md files at the top level, parses YAML
// frontmatter (name, description) and falls back to the first heading.
// Mirrors electron/openai-agent/skills-scanner.ts.

function parseSkillFrontmatter(content) {
  const out = {}
  if (!content.startsWith('---')) return out
  const end = content.indexOf('\n---', 3)
  if (end < 0) return out
  const block = content.slice(3, end).trim()
  for (const line of block.split('\n')) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.+?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

function firstHeading(content) {
  const body = content.replace(/^---[\s\S]*?\n---\n/, '')
  const line = body.split('\n').find(l => l.trim().length > 0) || ''
  return line.replace(/^#+\s*/, '').trim().slice(0, 200)
}

async function scanSkillsDir(dir, scope) {
  const out = []
  let entries
  try { entries = await readdir(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try { st = await stat(full) } catch { continue }
    if (st.isDirectory()) {
      const skillMd = join(full, 'SKILL.md')
      try {
        const content = await readFile(skillMd, 'utf-8')
        const fm = parseSkillFrontmatter(content)
        out.push({
          name: fm.name || name,
          description: fm.description || firstHeading(content),
          path: skillMd,
          scope,
        })
      } catch { /* no SKILL.md, skip */ }
    } else if (st.isFile() && name.endsWith('.md')) {
      const skillName = name.replace(/\.md$/, '')
      try {
        const content = await readFile(full, 'utf-8')
        const fm = parseSkillFrontmatter(content)
        out.push({
          name: fm.name || skillName,
          description: fm.description || firstHeading(content),
          path: full,
          scope,
        })
      } catch { /* skip */ }
    }
  }
  return out
}

async function scanSkills(cwd) {
  const projectSkills = join(cwd, '.claude', 'skills')
  const globalSkills = join(homedir(), '.claude', 'skills')
  const [a, b] = await Promise.all([
    scanSkillsDir(projectSkills, 'project'),
    scanSkillsDir(globalSkills, 'global'),
  ])
  const seen = new Set()
  const out = []
  for (const s of [...a, ...b]) {
    if (seen.has(s.name)) continue
    seen.add(s.name)
    out.push(s)
  }
  return out
}

export { scanSkills, parseSkillFrontmatter }

// --- worktree.* helpers --------------------------------------------------
//
// Port of electron/worktree-manager.ts. State is module-scoped because
// the sidecar process is one-per-app-instance and the Electron version
// uses a singleton. createWorktree / removeWorktree mutate this Map;
// rehydrate registers a worktree without creating it on disk (used to
// reattach to existing worktrees after app restart).

const WORKTREE_DIR = '.bat-worktrees'
const activeWorktrees = new Map()

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function worktreeGetGitRoot(cwd) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd })
    return stdout.trim()
  } catch { return null }
}

async function worktreeGetBranch(cwd) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    return stdout.trim()
  } catch { return 'HEAD' }
}

async function worktreeAddToGitExclude(gitRoot) {
  const excludeFile = join(gitRoot, '.git', 'info', 'exclude')
  const pattern = `/${WORKTREE_DIR}/`
  try {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(excludeFile), { recursive: true })
    let content = ''
    try { content = await readFile(excludeFile, 'utf-8') } catch { /* file missing */ }
    if (!content.includes(pattern)) {
      const sep = content.endsWith('\n') || content === '' ? '' : '\n'
      await writeFile(excludeFile, content + sep + pattern + '\n', 'utf-8')
    }
  } catch { /* best effort */ }
}

async function worktreeLinkClaudeUntracked(gitRoot, worktreePath) {
  const { mkdir, stat: statP, symlink, copyFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const claudeDir = join(gitRoot, '.claude')
  if (!existsSync(claudeDir)) return
  let untracked = []
  try {
    const { stdout } = await execFileP(
      'git', ['ls-files', '--others', '--exclude-standard', '.claude/'],
      { cwd: gitRoot, maxBuffer: 5 * 1024 * 1024 },
    )
    const items = stdout.trim().split('\n').filter(Boolean)
    const top = new Set()
    for (const item of items) {
      const rel = item.replace(/^\.claude\//, '')
      const first = rel.split('/')[0]
      if (first) top.add(first)
    }
    untracked = [...top]
  } catch { return }
  if (untracked.length === 0) return
  const wcd = join(worktreePath, '.claude')
  await mkdir(wcd, { recursive: true })
  const isWin = platform() === 'win32'
  for (const item of untracked) {
    const src = join(claudeDir, item)
    const dst = join(wcd, item)
    if (existsSync(dst)) continue
    try {
      const st = await statP(src)
      if (st.isDirectory()) {
        if (isWin) await symlink(src, dst, 'junction')
        else await symlink(src, dst)
      } else {
        if (isWin) await copyFile(src, dst)
        else await symlink(src, dst)
      }
    } catch { /* skip individual failures */ }
  }
}

async function worktreeCreate(sessionId, cwd) {
  const gitRoot = await worktreeGetGitRoot(cwd)
  if (!gitRoot) throw new Error('Not a git repository')
  const { mkdir } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')

  const shortId = sessionId.slice(0, 8)
  const worktreeBase = join(gitRoot, WORKTREE_DIR)
  const worktreePath = join(worktreeBase, shortId)
  const sourceBranch = await worktreeGetBranch(gitRoot)
  let branch = `bat/worktree-${shortId}`

  await mkdir(worktreeBase, { recursive: true })
  await worktreeAddToGitExclude(gitRoot)

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree already exists at ${worktreePath}. Use rehydrate() to reuse it.`)
  }

  // If the branch already exists, append a timestamp suffix.
  try {
    await execFileP('git', ['rev-parse', '--verify', branch], { cwd: gitRoot })
    branch = `${branch}-${Date.now().toString(36)}`
  } catch { /* branch missing — keep as-is */ }

  await execFileP('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: gitRoot })
  await worktreeLinkClaudeUntracked(gitRoot, worktreePath)

  const info = {
    sessionId,
    worktreePath,
    branchName: branch,
    gitRoot,
    originalCwd: cwd,
    sourceBranch,
    createdAt: Date.now(),
  }
  activeWorktrees.set(sessionId, info)
  return info
}

async function worktreeForceRemove(gitRoot, worktreePath, branchToDelete) {
  const { rm } = await import('node:fs/promises')
  try {
    await execFileP('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: gitRoot })
  } catch {
    try {
      await rm(worktreePath, { recursive: true, force: true })
      await execFileP('git', ['worktree', 'prune'], { cwd: gitRoot })
    } catch { /* manual cleanup may fail; continue */ }
  }
  if (branchToDelete) {
    try {
      await execFileP('git', ['branch', '-D', branchToDelete], { cwd: gitRoot })
    } catch { /* branch may not exist */ }
  }
}

async function worktreeRemove(sessionId, deleteBranch = true) {
  const info = activeWorktrees.get(sessionId)
  if (!info) return
  await worktreeForceRemove(info.gitRoot, info.worktreePath, deleteBranch ? info.branchName : undefined)
  activeWorktrees.delete(sessionId)
}

function worktreeRehydrate(sessionId, originalCwd, worktreePath, branchName) {
  const existing = activeWorktrees.get(sessionId)
  if (existing?.worktreePath === worktreePath) {
    existing.originalCwd = originalCwd
    if (branchName) existing.branchName = branchName
    return existing
  }
  // Two levels up from <gitRoot>/.bat-worktrees/<shortId> is the gitRoot.
  const gitRoot = join(worktreePath, '..', '..')
  const info = {
    sessionId,
    worktreePath,
    branchName,
    gitRoot,
    originalCwd,
    sourceBranch: '', // resolved on demand by status()
    createdAt: 0,
  }
  activeWorktrees.set(sessionId, info)
  // Async source branch lookup; non-blocking.
  worktreeGetBranch(gitRoot).then(b => { info.sourceBranch = b }).catch(() => {})
  return info
}

async function worktreeResolveSourceBranch(sessionId) {
  const info = activeWorktrees.get(sessionId)
  if (!info) return ''
  if (info.sourceBranch) return info.sourceBranch
  info.sourceBranch = await worktreeGetBranch(info.gitRoot)
  return info.sourceBranch
}

async function worktreeGetDiff(sessionId) {
  const info = activeWorktrees.get(sessionId)
  if (!info) return null
  try {
    const sourceBranch = info.sourceBranch || await worktreeResolveSourceBranch(sessionId)
    if (!sourceBranch) return null
    const { stdout } = await execFileP(
      'git', ['diff', `${sourceBranch}...${info.branchName}`],
      { cwd: info.gitRoot, maxBuffer: 10 * 1024 * 1024 },
    )
    return stdout
  } catch { return null }
}

async function worktreeStatus(sessionId) {
  const info = activeWorktrees.get(sessionId)
  if (!info) return null
  const sourceBranch = info.sourceBranch || await worktreeResolveSourceBranch(sessionId)
  const diff = await worktreeGetDiff(sessionId) || ''
  return {
    diff,
    branchName: info.branchName,
    worktreePath: info.worktreePath,
    sourceBranch,
  }
}

// Exported for tests + potential reuse.
export {
  worktreeCreate, worktreeRemove, worktreeStatus, worktreeRehydrate,
  worktreeGetGitRoot, worktreeGetBranch, activeWorktrees,
}

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
