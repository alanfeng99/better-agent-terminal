// worktree.* — real port of electron/worktree-manager.ts. Pure git
// execFile + fs ops, no Anthropic SDK dependency. State lives in this
// sidecar process for its lifetime (matches the Electron singleton).

import { platform } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

import { registerHandler } from '../lib/protocol.mjs'

export const WORKTREE_DIR = '.bat-worktrees'
export const activeWorktrees = new Map()

export function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function worktreeGetGitRoot(cwd) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd })
    return stdout.trim()
  } catch { return null }
}

export async function worktreeGetBranch(cwd) {
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

export async function worktreeCreate(sessionId, cwd) {
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

export async function worktreeRemove(sessionId, deleteBranch = true) {
  const info = activeWorktrees.get(sessionId)
  if (!info) return
  await worktreeForceRemove(info.gitRoot, info.worktreePath, deleteBranch ? info.branchName : undefined)
  activeWorktrees.delete(sessionId)
}

export function worktreeRehydrate(sessionId, originalCwd, worktreePath, branchName) {
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

export async function worktreeStatus(sessionId) {
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

async function worktreeEnsureClean(gitRoot) {
  const { stdout } = await execFileP(
    'git',
    ['status', '--porcelain'],
    { cwd: gitRoot, maxBuffer: 1024 * 1024 },
  )
  if (stdout.trim()) {
    throw new Error('Host repository has uncommitted changes; commit or stash before merging worktree')
  }
}

export async function worktreeMerge(sessionId, strategy = 'merge') {
  const info = activeWorktrees.get(sessionId)
  if (!info) return { success: false, error: 'worktree.merge: unknown session' }
  if (strategy !== 'merge' && strategy !== 'cherry-pick') {
    return { success: false, error: `worktree.merge: unsupported strategy ${strategy}` }
  }

  try {
    const sourceBranch = info.sourceBranch || await worktreeResolveSourceBranch(sessionId)
    if (!sourceBranch) {
      return { success: false, error: 'worktree.merge: missing source branch' }
    }

    await worktreeEnsureClean(info.gitRoot)

    const currentBranch = await worktreeGetBranch(info.gitRoot)
    if (currentBranch !== sourceBranch) {
      await execFileP('git', ['checkout', sourceBranch], { cwd: info.gitRoot })
    }

    if (strategy === 'merge') {
      await execFileP(
        'git',
        ['merge', '--no-ff', '--no-edit', info.branchName],
        { cwd: info.gitRoot, maxBuffer: 10 * 1024 * 1024 },
      )
    } else {
      const { stdout } = await execFileP(
        'git',
        ['rev-list', '--reverse', `${sourceBranch}..${info.branchName}`],
        { cwd: info.gitRoot, maxBuffer: 10 * 1024 * 1024 },
      )
      const commits = stdout.trim().split('\n').filter(Boolean)
      if (commits.length > 0) {
        await execFileP(
          'git',
          ['cherry-pick', ...commits],
          { cwd: info.gitRoot, maxBuffer: 10 * 1024 * 1024 },
        )
      }
    }

    return {
      success: true,
      strategy,
      branchName: info.branchName,
      sourceBranch,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- handlers --------------------------------------------------------------

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
registerHandler('worktree.merge', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const strategy = typeof params?.strategy === 'string' ? params.strategy : 'merge'
  if (!sessionId) return { success: false, error: 'worktree.merge: missing sessionId' }
  return worktreeMerge(sessionId, strategy)
})
registerHandler('worktree.rehydrate', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  const worktreePath = typeof params?.worktreePath === 'string' ? params.worktreePath : ''
  const branchName = typeof params?.branchName === 'string' ? params.branchName : ''
  if (!sessionId || !worktreePath) return { success: false }
  worktreeRehydrate(sessionId, cwd, worktreePath, branchName)
  return { success: true }
})
