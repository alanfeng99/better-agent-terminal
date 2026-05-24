#!/usr/bin/env node
// Launch the Tauri dev workflow with local machine overrides.
//
// Values in .env.local win over defaults. The file is intentionally parsed
// here instead of relying on shell-specific `source` syntax, so Procfile.tauri
// works from macOS/Linux shells and Windows shells.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

function unquote(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function readEnvLocal() {
  const envPath = join(repoRoot, '.env.local')
  let raw
  try {
    raw = readFileSync(envPath, 'utf8')
  } catch {
    return {}
  }

  const env = {}
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim()
    if (!line || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    const value = unquote(withoutExport.slice(eq + 1))
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value
  }
  return env
}

const args = process.argv.slice(2)
const stableMode = args.includes('--stable')
const isolatedProfileMode = args.includes('--isolated-profile')
const forwardedArgs = args.filter(arg => (
  arg !== '--stable' && arg !== '--isolated-profile' && arg !== '--print-env'
))

const env = {
  ...process.env,
  ...readEnvLocal(),
}

const defaultDataDir = isolatedProfileMode
  ? join(repoRoot, '.bat-tauri-dev-local-profile')
  : join(repoRoot, '.bat-tauri-dev-profile')
if (isolatedProfileMode) {
  env.BAT_TAURI_DATA_DIR = env.BAT_TAURI_DEV_DATA_DIR || defaultDataDir
  env.BAT_SIDECAR_DATA_DIR = env.BAT_TAURI_DEV_SIDECAR_DATA_DIR || env.BAT_TAURI_DATA_DIR
} else {
  if (!env.BAT_TAURI_DATA_DIR) env.BAT_TAURI_DATA_DIR = defaultDataDir
  if (!env.BAT_SIDECAR_DATA_DIR) env.BAT_SIDECAR_DATA_DIR = env.BAT_TAURI_DATA_DIR
}

const isolatedProfileId = env.BAT_TAURI_DEV_PROFILE_ID || 'tauri-dev-local'
const isolatedProfileName = env.BAT_TAURI_DEV_PROFILE_NAME || 'Tauri Dev Local'

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function profileEntry(id, name, now) {
  return {
    id,
    name,
    type: 'local',
    createdAt: now,
    updatedAt: now,
  }
}

function hasProfileArg(commandArgs) {
  return commandArgs.some((arg, index) => (
    arg === '--profile' ||
    arg.startsWith('--profile=') ||
    commandArgs[index - 1] === '--profile'
  ))
}

function isolatedWorkspaceState(now) {
  const workspacePath = env.BAT_TAURI_DEV_WORKSPACE_PATH
    ? resolve(repoRoot, env.BAT_TAURI_DEV_WORKSPACE_PATH)
    : repoRoot
  const workspaceName = env.BAT_TAURI_DEV_WORKSPACE_NAME || basename(workspacePath) || 'Workspace'
  const workspaceId = env.BAT_TAURI_DEV_WORKSPACE_ID || 'tauri-dev-workspace'
  return {
    workspaces: [{
      id: workspaceId,
      name: workspaceName,
      folderPath: workspacePath,
      createdAt: now,
    }],
    activeWorkspaceId: workspaceId,
    activeGroup: null,
    terminals: [],
    activeTerminalId: null,
  }
}

function snapshotFromWorkspace(profileId, profileName, workspace) {
  return {
    id: profileId,
    name: profileName,
    version: 2,
    windows: [{
      workspaces: workspace.workspaces,
      activeWorkspaceId: workspace.activeWorkspaceId,
      activeGroup: workspace.activeGroup,
      terminals: workspace.terminals,
      activeTerminalId: workspace.activeTerminalId,
    }],
  }
}

function ensureIsolatedProfile() {
  if (!isolatedProfileMode) return

  const dataDir = env.BAT_TAURI_DATA_DIR
  const profilesDir = join(dataDir, 'profiles')
  const now = Date.now()
  mkdirSync(profilesDir, { recursive: true })

  const indexPath = join(profilesDir, 'index.json')
  const index = readJson(indexPath, { profiles: [], activeProfileIds: [] })
  if (!Array.isArray(index.profiles)) index.profiles = []
  if (!index.profiles.some(profile => profile?.id === 'default')) {
    index.profiles.unshift(profileEntry('default', 'Default', 0))
  }
  const existing = index.profiles.find(profile => profile?.id === isolatedProfileId)
  if (existing) {
    existing.name = existing.name || isolatedProfileName
    existing.type = 'local'
    existing.updatedAt = existing.updatedAt || now
  } else {
    index.profiles.push(profileEntry(isolatedProfileId, isolatedProfileName, now))
  }
  index.activeProfileIds = [isolatedProfileId]
  delete index.activeProfileId
  writeJson(indexPath, index)

  const workspace = isolatedWorkspaceState(now)
  const profilePath = join(profilesDir, `${isolatedProfileId}.json`)
  if (!existsSync(profilePath)) {
    writeJson(profilePath, snapshotFromWorkspace(isolatedProfileId, isolatedProfileName, workspace))
  }
  const workspacePath = join(dataDir, 'workspaces.json')
  if (!existsSync(workspacePath)) {
    writeJson(workspacePath, workspace)
  }
  const windowsPath = join(dataDir, 'windows.json')
  if (!existsSync(windowsPath)) {
    writeJson(windowsPath, [{
      id: 'main',
      profileId: isolatedProfileId,
      workspaces: workspace.workspaces,
      activeWorkspaceId: workspace.activeWorkspaceId,
      activeGroup: workspace.activeGroup,
      terminals: workspace.terminals,
      activeTerminalId: workspace.activeTerminalId,
      lastActiveAt: now,
    }])
  }
}

if (isolatedProfileMode && !hasProfileArg(forwardedArgs)) {
  forwardedArgs.push(`--profile=${isolatedProfileId}`)
}

if (process.argv.includes('--print-env')) {
  console.log(`BAT_TAURI_DATA_DIR=${env.BAT_TAURI_DATA_DIR}`)
  console.log(`BAT_SIDECAR_DATA_DIR=${env.BAT_SIDECAR_DATA_DIR}`)
  if (isolatedProfileMode) {
    console.log(`BAT_TAURI_DEV_PROFILE_ID=${isolatedProfileId}`)
  }
  process.exit(0)
}

function spawnProcess(command, commandArgs) {
  return spawn(command, commandArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

function exitFromChild(code, signal) {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
}

function debugExecutablePath() {
  const names = process.platform === 'win32'
    ? ['BetterAgentTerminal.exe', 'better-agent-terminal.exe']
    : ['BetterAgentTerminal', 'better-agent-terminal']
  for (const name of names) {
    const candidate = join(repoRoot, 'src-tauri', 'target', 'debug', name)
    if (existsSync(candidate)) return candidate
  }
  return join(repoRoot, 'src-tauri', 'target', 'debug', names[0])
}

if (stableMode) {
  ensureIsolatedProfile()
  const prepare = spawnProcess('pnpm', ['run', 'prepare:tauri-bundle'])
  prepare.on('exit', (code, signal) => {
    if (signal || code !== 0) {
      exitFromChild(code, signal)
      return
    }
    const build = spawnProcess('pnpm', ['exec', 'tauri', 'build', '--debug', '--no-bundle'])
    build.on('exit', (code, signal) => {
      if (signal || code !== 0) {
        exitFromChild(code, signal)
        return
      }
      const exe = debugExecutablePath()
      const app = spawnProcess(exe, forwardedArgs)
      app.on('exit', exitFromChild)
    })
  })
} else {
  ensureIsolatedProfile()
  const child = spawnProcess('pnpm', ['run', 'tauri:dev:latest', ...forwardedArgs])
  child.on('exit', exitFromChild)
}
