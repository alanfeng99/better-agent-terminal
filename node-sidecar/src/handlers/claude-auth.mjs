// claude.* auth + account handlers. Also exports the Claude CLI binary
// resolver / spawner used by other handlers (sendMessage, forkSession).

import { readFile } from 'node:fs/promises'
import { accessSync, constants as fsConstants } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { registerHandler } from '../lib/protocol.mjs'
import { resolveDataDir } from '../lib/data-paths.mjs'
import { invalidateAccountMetadataCache } from './claude-readonly.mjs'

export const AUTH_STATUS_TIMEOUT_MS = 10_000
// auth login is interactive (browser-based OAuth, ~30-60s typical), so
// we give it a generous ceiling. The CLI exits as soon as the OAuth
// callback fires; if the user never completes the flow, we time out.
export const AUTH_LOGIN_TIMEOUT_MS = 180_000

// Resolve the path to a `claude` CLI binary. The bundled SDK ships one
// per platform (e.g. node-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe);
// prefer that so a fresh release MSI install can authenticate without
// requiring a system claude. Falls back to whatever's on PATH.
//
// Test/fixture override: BAT_SIDECAR_CLAUDE_BIN points at any executable
// (typically a printf-and-exit shim) so tests can verify the spawn path
// without invoking the real CLI's network flow.
let _claudeCliPathCache
function candidateSidecarRoots(fromFile) {
  const roots = []
  let dir = dirname(fromFile)
  for (let i = 0; i < 5; i += 1) {
    roots.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return roots
}

export function resolveClaudeCliBinary() {
  if (process.env.BAT_SIDECAR_CLAUDE_BIN) return process.env.BAT_SIDECAR_CLAUDE_BIN
  if (_claudeCliPathCache !== undefined) return _claudeCliPathCache
  // Probe the SDK-bundled binding directory siblings — there's at most
  // one per install (the package matches host platform/arch via npm
  // optionalDependencies), so the first match wins.
  const tripleDirs = [
    'claude-agent-sdk-win32-x64',
    'claude-agent-sdk-win32-arm64',
    'claude-agent-sdk-darwin-x64',
    'claude-agent-sdk-darwin-arm64',
    'claude-agent-sdk-linux-x64',
    'claude-agent-sdk-linux-arm64',
  ]
  const exeName = platform() === 'win32' ? 'claude.exe' : 'claude'
  // Walk up from this module to find node_modules/@anthropic-ai/.
  // import.meta.url is a file URL; resolve up to the sidecar root and
  // probe node_modules/@anthropic-ai/<pkg>/.
  let here
  try {
    here = fileURLToPath(import.meta.url)
  } catch {
    here = null
  }
  if (here) {
    for (const sidecarRoot of candidateSidecarRoots(here)) {
      for (const triple of tripleDirs) {
        const candidate = join(sidecarRoot, 'node_modules', '@anthropic-ai', triple, exeName)
        try {
          accessSync(candidate, fsConstants.X_OK)
          _claudeCliPathCache = candidate
          return candidate
        } catch { /* not present, try next */ }
      }
    }
  }
  _claudeCliPathCache = null
  return null
}

// Spawn the resolved claude CLI with the given args. Falls back to
// invoking 'claude' from PATH when no bundled binary is available.
export function spawnClaudeCli(args, opts, callback) {
  const bundled = resolveClaudeCliBinary()
  const bin = bundled || 'claude'
  return execFile(bin, args, opts, callback)
}

export function fetchAuthStatus() {
  return new Promise((resolve) => {
    spawnClaudeCli(['auth', 'status'], { timeout: AUTH_STATUS_TIMEOUT_MS }, (err, stdout) => {
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

// Return shape mirrors Electron's claude:account-list handler:
// `{accounts, activeAccountId, switchWarningShown}`. The renderer's
// SettingsPanel reads `result.accounts.length` directly, so a bare
// array would crash the panel — keep the wrapper even when empty.
export async function readAccountIndex() {
  const dir = resolveDataDir()
  const path = join(dir, 'claude-accounts.json')
  let raw
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return { accounts: [], activeAccountId: null, switchWarningShown: false }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { accounts: [], activeAccountId: null, switchWarningShown: false }
  }
  const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
  // Strip to documented public shape — AccountManager may have written
  // legacy/credential fields and we never surface those.
  const sanitized = accounts.map(a => ({
    id: String(a?.id ?? ''),
    email: String(a?.email ?? ''),
    subscriptionType: a?.subscriptionType,
    isDefault: Boolean(a?.isDefault),
    createdAt: typeof a?.createdAt === 'number' ? a.createdAt : 0,
  })).filter(a => a.id && a.email)
  return {
    accounts: sanitized,
    activeAccountId: typeof parsed?.activeAccountId === 'string' ? parsed.activeAccountId : null,
    switchWarningShown: Boolean(parsed?.switchWarningShown),
  }
}

// Exported for tests.
export function __resetClaudeCliCacheForTests() { _claudeCliPathCache = undefined }

// --- handlers --------------------------------------------------------------

const STUB_AUTH_ERR = 'claude account ops not yet wired through Tauri sidecar'

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

// authLogin shells out to `claude auth login` (interactive, browser-based
// OAuth). The CLI prints a URL, opens the user's browser, and exits when
// the OAuth callback fires; we just wait for the process to exit. The
// 180s ceiling is generous for a real-user flow but bounded so a stuck
// flow eventually fails. Uses the bundled CLI when available so a fresh
// release MSI install can authenticate without requiring system claude.
registerHandler('claude.authLogin', async () => {
  return new Promise((resolve) => {
    spawnClaudeCli(['auth', 'login'], { timeout: AUTH_LOGIN_TIMEOUT_MS }, (err) => {
      if (err) resolve({ success: false, error: err.message })
      else resolve({ success: true })
    })
  })
})
// authLogout shells out to `claude auth logout` and reports the result.
// 10s timeout — the CLI exits ~immediately on success. Failure usually
// means the CLI isn't installed or auth state is corrupt; surface the
// error message so the renderer can show it.
registerHandler('claude.authLogout', async () => {
  return new Promise((resolve) => {
    spawnClaudeCli(['auth', 'logout'], { timeout: AUTH_STATUS_TIMEOUT_MS }, (err) => {
      // Always flush the per-process metadata cache — the account is
      // gone (or might be), so getAccountInfo / getSupportedModels etc.
      // must be re-fetched on next call.
      invalidateAccountMetadataCache()
      if (err) resolve({ success: false, error: err.message })
      else resolve({ success: true })
    })
  })
})
registerHandler('claude.accountImportCurrent', async () => null)
registerHandler('claude.accountLoginNew', async () => ({ success: false, error: STUB_AUTH_ERR }))
registerHandler('claude.accountSwitch', async (params) => {
  if (typeof params?.accountId !== 'string') {
    throw new Error('claude.accountSwitch: missing accountId')
  }
  // Even when the actual switch op is still a stub, flush so a future
  // real impl doesn't have to remember to invalidate too.
  invalidateAccountMetadataCache()
  return false
})
registerHandler('claude.accountRemove', async (params) => {
  if (typeof params?.accountId !== 'string') {
    throw new Error('claude.accountRemove: missing accountId')
  }
  invalidateAccountMetadataCache()
  return false
})
registerHandler('claude.accountMarkWarningShown', async () => true)
