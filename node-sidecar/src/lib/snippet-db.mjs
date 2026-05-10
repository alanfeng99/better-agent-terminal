// SnippetDatabase — JSON-file-backed snippet store. Port of
// electron/snippet-db.ts. Lazy-loaded singleton: first method call
// reads `<dataDir>/snippets.json`, subsequent mutations debounce
// 300 ms before flushing to disk so a burst of edits coalesces into
// one fs.write.
//
// Uses sync fs intentionally (matches Electron — these calls are
// off the renderer hot path and the simpler control flow keeps
// load / refreshIfChanged single-step).

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveDataDir } from './data-paths.mjs'

const SAVE_DEBOUNCE_MS = 300

class SnippetDatabase {
  constructor() {
    this._dataPath = null
    this.loaded = false
    this.data = { snippets: [], nextId: 1 }
    this.lastMtime = 0
    this.saveTimer = null
  }

  get dataPath() {
    // resolveDataDir reads BAT_SIDECAR_DATA_DIR each call so tests
    // that flip the env var pick up the new location. Don't memoize.
    return path.join(resolveDataDir(), 'snippets.json')
  }

  ensureLoaded() {
    if (this.loaded) return
    this.loaded = true
    this.load()
  }

  load() {
    try {
      const p = this.dataPath
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.snippets) && typeof parsed.nextId === 'number') {
          this.data = parsed
          this.lastMtime = fs.statSync(p).mtimeMs
          // Migration: pre-action snippets default to 'terminal'.
          let migrated = false
          for (const s of this.data.snippets) {
            if (!s.action) { s.action = 'terminal'; migrated = true }
          }
          if (migrated) this.save()
        }
      }
    } catch {
      this.data = { snippets: [], nextId: 1 }
    }
  }

  // External-edit detection: if mtime moved past what we last wrote,
  // drop any pending in-memory write (it's stale) and reload.
  refreshIfChanged() {
    try {
      const p = this.dataPath
      if (!fs.existsSync(p)) return
      const mtime = fs.statSync(p).mtimeMs
      if (mtime > this.lastMtime) {
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
        this.load()
      }
    } catch { /* ignore */ }
  }

  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flushNow()
    }, SAVE_DEBOUNCE_MS)
  }

  flushNow() {
    try {
      const p = this.dataPath
      const dir = path.dirname(p)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(p, JSON.stringify(this.data, null, 2), 'utf-8')
      this.lastMtime = fs.statSync(p).mtimeMs
    } catch { /* ignore */ }
  }

  create(input) {
    this.ensureLoaded()
    this.refreshIfChanged()
    const now = Date.now()
    const snippet = {
      id: this.data.nextId++,
      title: input.title,
      content: input.content,
      format: input.format || 'plaintext',
      action: input.action || 'terminal',
      category: input.category,
      tags: input.tags,
      workspaceId: input.workspaceId,
      isFavorite: input.isFavorite || false,
      createdAt: now,
      updatedAt: now,
    }
    this.data.snippets.push(snippet)
    this.save()
    return snippet
  }

  getById(id) {
    this.ensureLoaded()
    this.refreshIfChanged()
    return this.data.snippets.find(s => s.id === id) || null
  }

  getAll() {
    this.ensureLoaded()
    this.refreshIfChanged()
    return [...this.data.snippets].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getFavorites() {
    this.ensureLoaded()
    this.refreshIfChanged()
    return this.data.snippets
      .filter(s => s.isFavorite)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  search(query) {
    this.ensureLoaded()
    this.refreshIfChanged()
    const term = String(query || '').toLowerCase()
    return this.data.snippets
      .filter(s =>
        s.title.toLowerCase().includes(term) ||
        s.content.toLowerCase().includes(term) ||
        (s.tags && s.tags.toLowerCase().includes(term)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  update(id, updates) {
    this.ensureLoaded()
    this.refreshIfChanged()
    const i = this.data.snippets.findIndex(s => s.id === id)
    if (i === -1) return null
    const existing = this.data.snippets[i]
    const updated = {
      ...existing,
      title: updates.title ?? existing.title,
      content: updates.content ?? existing.content,
      format: updates.format ?? existing.format,
      action: updates.action ?? existing.action,
      category: updates.category ?? existing.category,
      tags: updates.tags ?? existing.tags,
      // Explicit !== undefined check: caller passing `null` should clear
      // the field, but plain absence ({}) keeps the existing value.
      workspaceId: updates.workspaceId !== undefined ? updates.workspaceId : existing.workspaceId,
      isFavorite: updates.isFavorite ?? existing.isFavorite,
      updatedAt: Date.now(),
    }
    this.data.snippets[i] = updated
    this.save()
    return updated
  }

  delete(id) {
    this.ensureLoaded()
    this.refreshIfChanged()
    const i = this.data.snippets.findIndex(s => s.id === id)
    if (i === -1) return false
    this.data.snippets.splice(i, 1)
    this.save()
    return true
  }

  toggleFavorite(id) {
    const snippet = this.getById(id)
    if (!snippet) return null
    return this.update(id, { isFavorite: !snippet.isFavorite })
  }

  getByWorkspace(workspaceId) {
    this.ensureLoaded()
    this.refreshIfChanged()
    return this.data.snippets
      .filter(s => !s.workspaceId || s.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getCategories() {
    this.ensureLoaded()
    this.refreshIfChanged()
    const set = new Set()
    for (const s of this.data.snippets) {
      if (s.category) set.add(s.category)
    }
    return Array.from(set).sort()
  }

  close() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      this.flushNow()
    }
  }

  // Test-only: reset in-memory state so a re-pinned BAT_SIDECAR_DATA_DIR
  // is picked up on the next call. Drops any pending debounced write
  // intentionally — the test owns the on-disk fixture.
  __resetForTests() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    this.loaded = false
    this.data = { snippets: [], nextId: 1 }
    this.lastMtime = 0
  }
}

export const snippetDb = new SnippetDatabase()
