// fs.* — port of the renderer-facing fs:* handlers from
// electron/server-core/register-handlers.ts. Used by FileTree /
// QuickLocations / PathLinker / Sidebar workspace browser when a
// remote client is driving a host's filesystem through the bridge.
//
// Each handler accepts the Tauri host-api's object-shaped params
// (`{path}`, `{dirPath}`, `{parentPath, name}`, etc.); a handful also
// tolerate the Electron-style positional value (bare string) since the
// remote bridge unwraps args[0] verbatim and an Electron remote client
// would send a string.
//
// Excluded for now: fs:watch / fs:unwatch / fs:changed (stateful
// watchers), fs:search (ripgrep-style full-text — needs design).

import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { registerHandler } from '../lib/protocol.mjs'
import { isSensitivePath } from '../lib/path-guard.mjs'

const READDIR_IGNORED = new Set([
  '.git', 'node_modules', '.next', 'dist', 'dist-electron',
  '.cache', '__pycache__', '.DS_Store',
])

const READFILE_BYTE_CAP = 512 * 1024

function pickPath(params, ...keys) {
  if (typeof params === 'string') return params
  if (params && typeof params === 'object') {
    for (const k of keys) {
      const v = params[k]
      if (typeof v === 'string') return v
    }
  }
  return null
}

function expandTilde(raw) {
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2))
  }
  return raw
}

registerHandler('fs.home', async () => os.homedir())

registerHandler('fs.readdir', async (params) => {
  const dirPath = pickPath(params, 'dirPath', 'path')
  if (!dirPath) return []
  try {
    const abs = path.resolve(dirPath)
    if (isSensitivePath(abs)) return []
    const entries = await fs.readdir(abs, { withFileTypes: true })
    return entries
      .filter(e => !READDIR_IGNORED.has(e.name))
      .filter(e => !isSensitivePath(path.join(abs, e.name)))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map(e => ({ name: e.name, path: path.join(abs, e.name), isDirectory: e.isDirectory() }))
  } catch { return [] }
})

registerHandler('fs.readFile', async (params) => {
  const filePath = pickPath(params, 'path', 'filePath')
  if (!filePath) return { error: 'missing path' }
  try {
    const abs = path.resolve(filePath)
    if (isSensitivePath(abs)) return { error: 'Access denied (sensitive path)' }
    const stat = await fs.stat(abs)
    if (stat.size > READFILE_BYTE_CAP) return { error: 'File too large', size: stat.size }
    const content = await fs.readFile(abs, 'utf-8')
    return { content }
  } catch { return { error: 'Failed to read file' } }
})

registerHandler('fs.listDirs', async (params) => {
  const dirPath = pickPath(params, 'dirPath', 'path')
  const includeHidden = !!(params && typeof params === 'object' && params.includeHidden)
  if (!dirPath) return { error: 'missing dirPath' }
  try {
    const abs = path.resolve(expandTilde(dirPath))
    if (isSensitivePath(abs)) return { error: 'Access denied (sensitive path)' }
    const entries = await fs.readdir(abs, { withFileTypes: true })
    const filtered = entries
      .filter(e => e.isDirectory())
      .filter(e => includeHidden || !e.name.startsWith('.'))
      .filter(e => !isSensitivePath(path.join(abs, e.name)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ name: e.name, path: path.join(abs, e.name) }))
    const parent = path.dirname(abs)
    return { current: abs, parent: parent === abs ? null : parent, entries: filtered }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

registerHandler('fs.mkdir', async (params) => {
  const parentPath = pickPath(params, 'parentPath')
  const name = (params && typeof params === 'object' && typeof params.name === 'string') ? params.name : null
  if (!parentPath || name === null) return { error: 'missing parentPath / name' }
  try {
    const trimmed = name.trim()
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
      return { error: 'Invalid folder name' }
    }
    const abs = path.resolve(parentPath)
    if (isSensitivePath(abs)) return { error: 'Access denied (sensitive path)' }
    const target = path.join(abs, trimmed)
    await fs.mkdir(target, { recursive: false })
    return { path: target }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

registerHandler('fs.deletePath', async (params) => {
  const targetPath = pickPath(params, 'targetPath', 'path')
  if (!targetPath) return { error: 'missing targetPath' }
  try {
    const abs = path.resolve(targetPath)
    if (isSensitivePath(abs)) return { error: 'Access denied (sensitive path)' }
    const stat = await fs.lstat(abs)
    // Mirror Electron contract: only directories can be removed via
    // this handler (defensive guard against accidental file deletion
    // through the remote bridge).
    if (!stat.isDirectory()) return { error: 'Only directories can be deleted here' }
    await fs.rm(abs, { recursive: true, force: false })
    return { path: abs }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

registerHandler('fs.quickLocations', async () => {
  const home = os.homedir()
  const items = [{ name: 'Home', path: home, kind: 'home' }]
  if (process.platform === 'win32') {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`
      try { await fs.access(root); items.push({ name: `${letter}:`, path: root, kind: 'drive' }) }
      catch { /* drive not present */ }
    }
  } else {
    items.push({ name: '/', path: '/', kind: 'root' })
    if (process.platform === 'darwin') {
      try {
        const mounts = await fs.readdir('/Volumes', { withFileTypes: true })
        for (const m of mounts) {
          if (m.isDirectory() || m.isSymbolicLink()) {
            items.push({ name: m.name, path: `/Volumes/${m.name}`, kind: 'volume' })
          }
        }
      } catch { /* no /Volumes */ }
    }
  }
  return items
})

const RESOLVE_TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'jsonl', 'css', 'scss', 'less', 'html', 'htm',
  'md', 'mdx', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'csproj', 'sln',
  'slnx', 'fs', 'fsproj', 'vue', 'svelte', 'sql', 'graphql', 'log',
])

registerHandler('fs.resolvePathLinks', async (params) => {
  const cwd = (params && typeof params === 'object' && typeof params.cwd === 'string') ? params.cwd : ''
  const rawPaths = (params && typeof params === 'object' && Array.isArray(params.rawPaths)) ? params.rawPaths : []
  const unique = Array.from(new Set(
    rawPaths.filter(p => typeof p === 'string' && p.length <= 500),
  )).slice(0, 200)
  const cwdAbs = cwd ? path.resolve(cwd) : ''
  const parseRaw = (raw) => {
    const cleaned = raw.replace(/^[`'"(<\[]+|[`'"),.;>\]]+$/g, '')
    const lineMatch = cleaned.match(/^(.*?):(\d+)(?::(\d+))?$/)
    if (!lineMatch) return { cleaned, pathText: cleaned, line: undefined, column: undefined }
    return {
      cleaned,
      pathText: lineMatch[1],
      line: Number(lineMatch[2]),
      column: lineMatch[3] ? Number(lineMatch[3]) : undefined,
    }
  }
  const results = []
  for (const raw of unique) {
    try {
      const parsed = parseRaw(raw)
      const ext = path.extname(parsed.pathText).slice(1).toLowerCase()
      if (!RESOLVE_TEXT_EXTS.has(ext)) continue
      const isAbs = path.isAbsolute(parsed.pathText) || /^[A-Za-z]:[\\/]/.test(parsed.pathText)
      if (!isAbs && !cwdAbs) continue
      const abs = path.resolve(isAbs ? parsed.pathText : path.join(cwdAbs, parsed.pathText))
      if (isSensitivePath(abs)) continue
      const stat = await fs.stat(abs).catch(() => null)
      if (!stat?.isFile()) continue
      results.push({ rawPath: parsed.cleaned, path: abs, exists: true, line: parsed.line, column: parsed.column })
    } catch { /* ignore invalid candidate */ }
  }
  return results
})

// fs.search — recursive filename substring match. Pure Node walker
// (no ripgrep dep). Used by FileTree / Agent panel file pickers.
// Hard caps: depth ≤ 8, results ≤ 100. IGNORED dirs match Electron.
// Path-guard runs at every level so a sensitive subtree is silently
// pruned. Result is sorted dirs-first then alphabetical by name.
const SEARCH_IGNORED = new Set([
  '.git', 'node_modules', '.next', 'dist', 'dist-electron',
  '.cache', '__pycache__', '.DS_Store', 'release',
])
const SEARCH_MAX_DEPTH = 8
const SEARCH_MAX_RESULTS = 100

registerHandler('fs.search', async (params) => {
  const dirPath = pickPath(params, 'dirPath', 'path')
  const query = (params && typeof params === 'object' && typeof params.query === 'string')
    ? params.query
    : null
  if (!dirPath || query === null) return []
  const lowerQuery = query.toLowerCase()
  const results = []
  async function walk(dir, depth) {
    if (depth > SEARCH_MAX_DEPTH || results.length >= SEARCH_MAX_RESULTS) return
    if (isSensitivePath(dir)) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      if (results.length >= SEARCH_MAX_RESULTS) return
      if (SEARCH_IGNORED.has(e.name)) continue
      const fullPath = path.join(dir, e.name)
      if (isSensitivePath(fullPath)) continue
      if (e.name.toLowerCase().includes(lowerQuery)) {
        results.push({ name: e.name, path: fullPath, isDirectory: e.isDirectory() })
      }
      if (e.isDirectory()) await walk(fullPath, depth + 1)
    }
  }
  await walk(path.resolve(dirPath), 0)
  return results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
})
