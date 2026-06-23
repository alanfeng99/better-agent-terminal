import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'

const MIN_CHANNEL_VERSION = [2, 1, 80]

export function isBatDebugEnabled(env = process.env) {
  const value = env.BAT_DEBUG ?? env.VITE_BAT_DEBUG
  return value === '1' || value === 'true' || value === 'TRUE' || value === true
}

export function parseClaudeVersion(raw) {
  const match = String(raw || '').match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: `${match[1]}.${match[2]}.${match[3]}`,
  }
}

export function compareVersion(version, target) {
  if (!version) return -1
  const parts = [version.major, version.minor, version.patch]
  for (let i = 0; i < target.length; i += 1) {
    if (parts[i] > target[i]) return 1
    if (parts[i] < target[i]) return -1
  }
  return 0
}

function runCli(cliPath, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    if (!cliPath) {
      resolve({ ok: false, stdout: '', stderr: 'missing cliPath', code: null })
      return
    }
    let child
    try {
      child = spawn(cliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cliPath),
      })
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: err.message, code: null })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, code })
    })
  })
}

export async function probeClaudeChannelCapabilities({ cliPath } = {}) {
  const base = {
    supported: false,
    cliPath: cliPath || null,
    cliVersion: null,
    supportsChannels: false,
    supportsModel: false,
    supportsPermissionMode: false,
    supportsThinkingEffort: false,
    supportsCompactWindow: false,
    supportsStopTask: false,
    supportsStreaming: false,
    error: null,
  }

  if (!cliPath) return { ...base, error: 'Claude CLI path is not available.' }
  try {
    accessSync(cliPath, constants.X_OK)
  } catch {
    return { ...base, error: `Claude CLI is not executable: ${cliPath}` }
  }

  const versionResult = await runCli(cliPath, ['--version'])
  const version = parseClaudeVersion(versionResult.stdout || versionResult.stderr)
  const helpResult = await runCli(cliPath, ['--help'])
  const help = `${helpResult.stdout}\n${helpResult.stderr}`
  const supportsChannels = compareVersion(version, MIN_CHANNEL_VERSION) >= 0

  return {
    ...base,
    supported: supportsChannels,
    cliVersion: version?.text || null,
    supportsChannels,
    supportsModel: help.includes('--model'),
    supportsPermissionMode: help.includes('--permission-mode'),
    supportsThinkingEffort: help.includes('--effort'),
    supportsCompactWindow: false,
    supportsStopTask: false,
    supportsStreaming: false,
    error: supportsChannels ? null : 'Claude Code channels require Claude Code v2.1.80 or newer.',
  }
}
