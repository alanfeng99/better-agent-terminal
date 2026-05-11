// settings.* — port of the renderer-facing settings:* handlers from
// electron/server-core/register-handlers.ts. Four channels:
//
//   settings:save              ({data:string}) → bool
//   settings:load              ()              → string | null
//   settings:get-shell-path    ({shellType})   → string (cached)
//   settings:detect-cx         ()              → CxDetectionResult
//
// Persists `<dataDir>/settings.json` so the renderer's preferences /
// cx-binary path / shell preference round-trip. A remote client
// driving a Tauri host through the bridge talks to the host's local
// disk via these — phone-driven settings panels read/write the host
// profile, not the phone's.

import { execFile } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { promisify } from 'util'
import { registerHandler } from '../lib/protocol.mjs'
import { resolveDataDir } from '../lib/data-paths.mjs'

const execFileAsync = promisify(execFile)

function settingsPath() {
  return path.join(resolveDataDir(), 'settings.json')
}

function pickString(params, key) {
  if (typeof params === 'string') return params
  if (params && typeof params === 'object' && typeof params[key] === 'string') {
    return params[key]
  }
  return null
}

// ---------------------------------------------------------------------------
// settings.save / settings.load — round-trip raw JSON text.

registerHandler('settings.save', async (params) => {
  const data = pickString(params, 'data')
  if (data === null) throw new Error('settings.save: missing data')
  const file = settingsPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, data, 'utf-8')
  return true
})

registerHandler('settings.load', async () => {
  try {
    return await fs.readFile(settingsPath(), 'utf-8')
  } catch {
    return null
  }
})

// ---------------------------------------------------------------------------
// settings.getShellPath — resolves a logical shell name ('auto', 'zsh',
// 'pwsh', etc.) to an absolute binary path. Cached per process so a
// quick-bursting renderer doesn't hammer fs.exists. Mirrors Electron
// behaviour exactly so a returning user gets the same shell back.

const shellPathCache = new Map()

async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function getPosixAutoShell() {
  const env = process.env.SHELL
  if (env && await pathExists(env)) return env
  if (process.platform === 'darwin') return '/bin/zsh'
  if (await pathExists('/bin/bash')) return '/bin/bash'
  return '/bin/sh'
}

async function resolveShellPath(shellType) {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    if (shellType === 'auto') return await getPosixAutoShell()
    if (shellType === 'zsh') return '/bin/zsh'
    if (shellType === 'bash') {
      if (await pathExists('/opt/homebrew/bin/bash')) return '/opt/homebrew/bin/bash'
      if (await pathExists('/usr/local/bin/bash')) return '/usr/local/bin/bash'
      return '/bin/bash'
    }
    if (shellType === 'sh') return '/bin/sh'
    // POSIX hosts can't run pwsh/powershell/cmd — fall back to the
    // user's auto shell so terminal spawn never explodes.
    if (shellType === 'pwsh' || shellType === 'powershell' || shellType === 'cmd') {
      return await getPosixAutoShell()
    }
    return shellType
  }
  // win32
  if (shellType === 'auto' || shellType === 'pwsh') {
    const candidates = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
      (process.env.LOCALAPPDATA || '') + '\\Microsoft\\WindowsApps\\pwsh.exe',
    ]
    for (const p of candidates) {
      if (await pathExists(p)) return p
    }
    if (shellType === 'pwsh') return 'pwsh.exe'
    return 'powershell.exe'
  }
  if (shellType === 'powershell') return 'powershell.exe'
  if (shellType === 'cmd') return 'cmd.exe'
  return shellType
}

registerHandler('settings.getShellPath', async (params) => {
  const shellType = pickString(params, 'shellType')
  if (shellType === null) throw new Error('settings.getShellPath: missing shellType')
  const cached = shellPathCache.get(shellType)
  if (cached) return cached
  const resolved = await resolveShellPath(shellType)
  shellPathCache.set(shellType, resolved)
  return resolved
})

// Test-only: the cache silently masks real fs changes between
// `darwin` and `linux` test cases. Letting the test reset clears it.
export function __resetShellPathCacheForTests() {
  shellPathCache.clear()
}

// ---------------------------------------------------------------------------
// settings.detectCx — locate the `cx` semantic-navigation binary.
// Mirrors electron/semantic-navigation.ts:detectCx. Returns a
// structured result regardless of whether cx is installed so the
// renderer can render a settings row + status badge.

async function readCxSettings() {
  try {
    const text = await fs.readFile(settingsPath(), 'utf-8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') return parsed
    return {}
  } catch {
    return {}
  }
}

async function resolveFromPath() {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which'
    const { stdout } = await execFileAsync(command, ['cx'],
      { encoding: 'utf-8', timeout: 2000, windowsHide: true })
    const first = stdout.split(/\r?\n/).map(l => l.trim()).find(Boolean)
    return first || undefined
  } catch {
    return undefined
  }
}

async function resolveConfiguredCxPath(configured) {
  const trimmed = typeof configured === 'string' ? configured.trim() : ''
  if (!trimmed) return await resolveFromPath()
  if (path.isAbsolute(trimmed)) return trimmed
  if (trimmed.includes('/') || trimmed.includes('\\')) return path.resolve(trimmed)
  return trimmed
}

async function runCxVersion(binaryPath) {
  const { stdout } = await execFileAsync(binaryPath, ['--version'],
    { encoding: 'utf-8', timeout: 3000, windowsHide: true })
  return stdout.trim() || 'cx'
}

registerHandler('settings.detectCx', async () => {
  const settings = await readCxSettings()
  const cacheDir = path.join(resolveDataDir(), 'cx-cache')
  const enabled = settings.cxSemanticNavigationEnabled === true

  const binaryPath = await resolveConfiguredCxPath(settings.cxBinaryPath)
  if (!binaryPath) {
    return { enabled, detected: false, cacheDir, error: 'cx not found in PATH' }
  }
  try {
    const version = await runCxVersion(binaryPath)
    return { enabled, detected: true, path: binaryPath, version, cacheDir }
  } catch (err) {
    return {
      enabled,
      detected: false,
      path: binaryPath,
      cacheDir,
      error: err instanceof Error ? err.message : String(err),
    }
  }
})
