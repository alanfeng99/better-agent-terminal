// git.* — port of electron/server-core/register-handlers.ts git:*
// handlers. Pure `git` CLI wrappers via child_process; each handler
// returns a safe default (null / [] / '') when the cwd isn't a repo,
// `git` isn't on PATH, or the command times out. Mirrors the Electron
// + Tauri Rust contracts so the renderer code paths don't branch on
// host.
//
// Used over the remote bridge: a phone connected to a host can read
// the host's git state for diff viewers / commit log / branch label /
// PR URL discovery.

import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { registerHandler } from '../lib/protocol.mjs'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 5000
const LARGE_BUFFER = 1024 * 1024 * 5

function pickString(params, key) {
  if (params && typeof params === 'object' && typeof params[key] === 'string') {
    return params[key]
  }
  return null
}

registerHandler('git.getGithubUrl', async (params) => {
  const folderPath = pickString(params, 'folderPath') || pickString(params, 'cwd')
  if (!folderPath) return null
  try {
    const { stdout } = await execAsync('git remote get-url origin',
      { cwd: folderPath, encoding: 'utf-8', timeout: 3000 })
    const remote = stdout.trim()
    const sshMatch = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/)
    if (sshMatch) return `https://github.com/${sshMatch[1]}`
    const httpsMatch = remote.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/)
    if (httpsMatch) return `https://github.com/${httpsMatch[1]}`
    return null
  } catch { return null }
})

registerHandler('git.branch', async (params) => {
  const cwd = pickString(params, 'cwd')
  if (!cwd) return null
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD',
      { cwd, encoding: 'utf-8', timeout: 3000 })
    return stdout.trim() || null
  } catch { return null }
})

registerHandler('git.log', async (params) => {
  const cwd = pickString(params, 'cwd')
  if (!cwd) return []
  const count = (params && typeof params === 'object' && typeof params.count === 'number') ? params.count : 50
  try {
    const safeCount = Math.max(1, Math.min(Math.floor(Number(count)) || 50, 500))
    const { stdout } = await execFileAsync('git',
      ['log', '--pretty=format:%H||%an||%ai||%s', '-n', String(safeCount)],
      { cwd, encoding: 'utf-8', timeout: DEFAULT_TIMEOUT_MS })
    const raw = stdout.trim()
    if (!raw) return []
    return raw.split('\n').map(line => {
      const parts = line.split('||')
      return {
        hash: parts[0],
        author: parts[1],
        date: parts[2],
        message: parts.slice(3).join('||'),
      }
    })
  } catch { return [] }
})

registerHandler('git.diff', async (params) => {
  const cwd = pickString(params, 'cwd')
  if (!cwd) return ''
  const commitHash = pickString(params, 'commitHash')
  const filePath = pickString(params, 'filePath')
  try {
    const args = (commitHash && commitHash !== 'working')
      ? ['diff', `${commitHash}~1..${commitHash}`]
      : ['diff', 'HEAD']
    if (filePath) args.push('--', filePath)
    const { stdout } = await execFileAsync('git', args,
      { cwd, encoding: 'utf-8', timeout: 10000, maxBuffer: LARGE_BUFFER })
    return stdout
  } catch { return '' }
})

registerHandler('git.diffFiles', async (params) => {
  const cwd = pickString(params, 'cwd')
  if (!cwd) return []
  const commitHash = pickString(params, 'commitHash')
  try {
    const args = (commitHash && commitHash !== 'working')
      ? ['diff', '--name-status', `${commitHash}~1..${commitHash}`]
      : ['diff', '--name-status', 'HEAD']
    const { stdout } = await execFileAsync('git', args,
      { cwd, encoding: 'utf-8', timeout: DEFAULT_TIMEOUT_MS })
    if (!stdout.trim()) return []
    return stdout.trim().split('\n').map(line => {
      const tab = line.indexOf('\t')
      return {
        status: tab > 0 ? line.substring(0, tab).trim() : line.charAt(0),
        file: tab > 0 ? line.substring(tab + 1) : line.substring(2),
      }
    })
  } catch { return [] }
})

registerHandler('git.getRoot', async (params) => {
  const cwd = pickString(params, 'cwd')
  if (!cwd) return null
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel',
      { cwd, encoding: 'utf-8', timeout: DEFAULT_TIMEOUT_MS })
    return stdout.trim()
  } catch { return null }
})

registerHandler('git.status', async (params) => {
  const cwd = pickString(params, 'cwd')
  if (!cwd) return []
  try {
    const { stdout } = await execAsync('git status --porcelain -uall',
      { cwd, encoding: 'utf-8', timeout: DEFAULT_TIMEOUT_MS, maxBuffer: LARGE_BUFFER })
    if (!stdout.trim()) return []
    return stdout.split('\n').filter(line => line.trim()).map(line => ({
      status: line.substring(0, 2).trim(),
      file: line.substring(3),
    }))
  } catch { return [] }
})
