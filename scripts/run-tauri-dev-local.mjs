#!/usr/bin/env node
// Launch the Tauri dev workflow with local machine overrides.
//
// Values in .env.local win over defaults. The file is intentionally parsed
// here instead of relying on shell-specific `source` syntax, so Procfile.tauri
// works from macOS/Linux shells and Windows shells.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
const forwardedArgs = args.filter(arg => arg !== '--stable' && arg !== '--print-env')

const env = {
  ...process.env,
  ...readEnvLocal(),
}

const defaultDataDir = join(repoRoot, '.bat-tauri-dev-profile')
if (!env.BAT_TAURI_DATA_DIR) env.BAT_TAURI_DATA_DIR = defaultDataDir
if (!env.BAT_SIDECAR_DATA_DIR) env.BAT_SIDECAR_DATA_DIR = env.BAT_TAURI_DATA_DIR

if (process.argv.includes('--print-env')) {
  console.log(`BAT_TAURI_DATA_DIR=${env.BAT_TAURI_DATA_DIR}`)
  console.log(`BAT_SIDECAR_DATA_DIR=${env.BAT_SIDECAR_DATA_DIR}`)
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

if (stableMode) {
  const build = spawnProcess('pnpm', ['run', 'tauri:build:debug'])
  build.on('exit', (code, signal) => {
    if (signal || code !== 0) {
      exitFromChild(code, signal)
      return
    }
    const exe = process.platform === 'win32'
      ? join(repoRoot, 'src-tauri', 'target', 'debug', 'better-agent-terminal.exe')
      : join(repoRoot, 'src-tauri', 'target', 'debug', 'better-agent-terminal')
    const app = spawnProcess(exe, forwardedArgs)
    app.on('exit', exitFromChild)
  })
} else {
  const child = spawnProcess('pnpm', ['run', 'tauri:dev:latest', ...forwardedArgs])
  child.on('exit', exitFromChild)
}
