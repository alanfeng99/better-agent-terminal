// github.* — port of electron/server-core/register-handlers.ts
// github:* handlers. Wraps the `gh` CLI to surface PR / issue lists,
// detail views, and comment posting. All read commands return parsed
// JSON or `{error: string}` (mirror of Electron contract); writes
// return `{success: true}` or `{error: string}`.
//
// `gh` is optional — checkCli reports `{installed:false, ...}` when
// the binary isn't on PATH so the renderer can degrade UI cleanly.
//
// Used over the remote bridge: a phone connected to a host can list
// the host's PRs / issues, post a comment, etc.

import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { registerHandler } from '../lib/protocol.mjs'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const READ_TIMEOUT_MS = 15000
const LARGE_BUFFER = 5 * 1024 * 1024

function pickString(params, key) {
  if (params && typeof params === 'object' && typeof params[key] === 'string') {
    return params[key]
  }
  return null
}

function pickNumber(params, key) {
  if (params && typeof params === 'object' && typeof params[key] === 'number') {
    return params[key]
  }
  return null
}

registerHandler('github.checkCli', async () => {
  try {
    await execAsync('gh --version', { encoding: 'utf-8', timeout: 5000 })
    try {
      // `gh auth status` exits non-zero if ANY account has issues even
      // when the active account is fine, so use `gh auth token` which
      // only checks the active account.
      await execAsync('gh auth token', { encoding: 'utf-8', timeout: 5000 })
      return { installed: true, authenticated: true }
    } catch {
      return { installed: true, authenticated: false }
    }
  } catch {
    return { installed: false, authenticated: false }
  }
})

registerHandler('github.prList', async (params) => {
  const cwd = pickString(params, 'cwd')
  if (!cwd) return { error: 'missing cwd' }
  try {
    const { stdout } = await execAsync(
      'gh pr list --json number,title,state,author,createdAt,updatedAt,labels,headRefName,isDraft --limit 50',
      { cwd, encoding: 'utf-8', timeout: READ_TIMEOUT_MS, maxBuffer: LARGE_BUFFER })
    return JSON.parse(stdout)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
})

registerHandler('github.issueList', async (params) => {
  const cwd = pickString(params, 'cwd')
  if (!cwd) return { error: 'missing cwd' }
  try {
    const { stdout } = await execAsync(
      'gh issue list --json number,title,state,author,createdAt,updatedAt,labels --limit 50',
      { cwd, encoding: 'utf-8', timeout: READ_TIMEOUT_MS, maxBuffer: LARGE_BUFFER })
    return JSON.parse(stdout)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
})

registerHandler('github.prView', async (params) => {
  const cwd = pickString(params, 'cwd')
  const number = pickNumber(params, 'number')
  if (!cwd) return { error: 'missing cwd' }
  if (number === null) return { error: 'missing number' }
  try {
    // execFile-style: pass the PR number as a separate argv so a
    // crafted number value can't inject shell tokens. Number conversion
    // happens once.
    const { stdout } = await execFileAsync('gh',
      ['pr', 'view', String(number),
        '--json', 'number,title,state,author,body,comments,reviews,createdAt,headRefName,baseRefName,additions,deletions,files'],
      { cwd, encoding: 'utf-8', timeout: READ_TIMEOUT_MS, maxBuffer: LARGE_BUFFER })
    return JSON.parse(stdout)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
})

registerHandler('github.issueView', async (params) => {
  const cwd = pickString(params, 'cwd')
  const number = pickNumber(params, 'number')
  if (!cwd) return { error: 'missing cwd' }
  if (number === null) return { error: 'missing number' }
  try {
    const { stdout } = await execFileAsync('gh',
      ['issue', 'view', String(number),
        '--json', 'number,title,state,author,body,comments,createdAt,labels'],
      { cwd, encoding: 'utf-8', timeout: READ_TIMEOUT_MS, maxBuffer: LARGE_BUFFER })
    return JSON.parse(stdout)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
})

registerHandler('github.prComment', async (params) => {
  const cwd = pickString(params, 'cwd')
  const number = pickNumber(params, 'number')
  const body = pickString(params, 'body')
  if (!cwd) return { error: 'missing cwd' }
  if (number === null) return { error: 'missing number' }
  if (body === null) return { error: 'missing body' }
  try {
    await execFileAsync('gh', ['pr', 'comment', String(number), '--body', body],
      { cwd, encoding: 'utf-8', timeout: READ_TIMEOUT_MS })
    return { success: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
})

registerHandler('github.issueComment', async (params) => {
  const cwd = pickString(params, 'cwd')
  const number = pickNumber(params, 'number')
  const body = pickString(params, 'body')
  if (!cwd) return { error: 'missing cwd' }
  if (number === null) return { error: 'missing number' }
  if (body === null) return { error: 'missing body' }
  try {
    await execFileAsync('gh', ['issue', 'comment', String(number), '--body', body],
      { cwd, encoding: 'utf-8', timeout: READ_TIMEOUT_MS })
    return { success: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
})
