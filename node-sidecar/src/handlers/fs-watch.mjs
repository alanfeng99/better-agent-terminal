// fs.watch / fs.unwatch — port of the stateful fs:watch / fs:unwatch
// handlers from electron/server-core/register-handlers.ts. The watcher
// pushes `fs:changed` events back to subscribers (the renderer or a
// remote client) every time the directory tree mutates.
//
// State model: a process-wide Map<string, FSWatcher> keyed by the
// directory path the caller passed (case-sensitive, no normalization
// — caller must pass back the same string to unwatch). Idempotent —
// a second `fs.watch(p)` for an already-watched p is a no-op + true.
// Path-guard runs before fs.watch attaches, so sensitive trees
// (~/.ssh / .aws / etc) are silently refused with `false`.
//
// Debouncing: 500 ms — every fs.watch callback resets a single timer
// per watcher, the timer fires sendEvent once. Burst edits (rename /
// build / pnpm install) collapse into one client refresh.
//
// Remote bridge: the existing remote server inspects PROXIED_EVENTS
// and forwards `fs:changed` over the wire. Sidecar callers just
// sendEvent; nothing else is needed.

import * as fsSync from 'node:fs'
import * as path from 'node:path'
import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import { isSensitivePath } from '../lib/path-guard.mjs'

const DEBOUNCE_MS = 500

// key = the original dirPath string the caller passed (so unwatch
// can find it without re-resolving). value = { watcher, timer }.
const fileWatchers = new Map()

function pickPath(params) {
  if (typeof params === 'string') return params
  if (params && typeof params === 'object' && typeof params.dirPath === 'string') return params.dirPath
  if (params && typeof params === 'object' && typeof params.path === 'string') return params.path
  return null
}

function closeEntry(entry) {
  if (!entry) return
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  try { entry.watcher.close() } catch { /* already closed */ }
}

registerHandler('fs.watch', async (params) => {
  const dirPath = pickPath(params)
  if (!dirPath) return false
  if (fileWatchers.has(dirPath)) return true
  const abs = path.resolve(dirPath)
  if (isSensitivePath(abs)) return false
  try {
    const entry = { watcher: null, timer: null }
    entry.watcher = fsSync.watch(abs, { recursive: true }, () => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        sendEvent('fs:changed', abs)
      }, DEBOUNCE_MS)
    })
    entry.watcher.on('error', () => {
      // Drop the entry on error — common cause is the watched
      // directory being deleted; renderer can re-watch on next
      // mount. No event emitted (Electron parity).
      const cur = fileWatchers.get(dirPath)
      if (cur === entry) fileWatchers.delete(dirPath)
      closeEntry(entry)
    })
    fileWatchers.set(dirPath, entry)
    return true
  } catch {
    // Common failures: ENOENT, permission denied, recursive not
    // supported on this platform/fs. All map to false; renderer's
    // host.fs.watch contract is `Promise<boolean>`.
    return false
  }
})

registerHandler('fs.unwatch', async (params) => {
  const dirPath = pickPath(params)
  if (!dirPath) return true
  const entry = fileWatchers.get(dirPath)
  if (entry) {
    closeEntry(entry)
    fileWatchers.delete(dirPath)
  }
  return true
})

// Test-only: nuke every watcher + timer so a test doesn't leave
// open handles that block process exit. Returns the count cleared.
export function __closeAllWatchersForTests() {
  const n = fileWatchers.size
  for (const entry of fileWatchers.values()) closeEntry(entry)
  fileWatchers.clear()
  return n
}

export function __watcherCountForTests() {
  return fileWatchers.size
}
