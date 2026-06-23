// Filesystem path helpers shared across handlers.

import { homedir, platform } from 'node:os'
import { join } from 'node:path'

// Override hook for tests: __setProjectsDirOverrideForTests(path)
// swaps `~/.claude/projects` for a tmpdir.
let _projectsDirOverrideForTests = null
export function __setProjectsDirOverrideForTests(p) { _projectsDirOverrideForTests = p }
export function __resolveProjectsDir() {
  return _projectsDirOverrideForTests || join(homedir(), '.claude', 'projects')
}

export function resolveDataDir() {
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

export function archiveFilePath(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_.\-]/g, '_')
  return join(resolveDataDir(), 'message-archives', `${safe}.jsonl`)
}

// Windows quirk: Tauri's resource_dir() returns paths with the `\\?\`
// (verbatim / extended-length) prefix, which breaks naive
// `file://<argv[1]>` URL construction. Compare resolved fs paths
// instead, with the verbatim prefix stripped on both sides and a
// case-insensitive match (Windows fs is case-insensitive).
export function __normalizeMainPath(p) {
  if (typeof p !== 'string' || !p) return ''
  let out = p
  if (process.platform === 'win32') {
    out = out.replace(/^\\\\\?\\/, '')
    out = out.toLowerCase()
  }
  return out.replace(/\\/g, '/')
}
