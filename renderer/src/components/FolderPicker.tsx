import { host } from '../host-api'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { isProcfileName } from '../utils/procfile-parser'

interface FolderEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface QuickLocation {
  name: string
  path: string
  kind: 'home' | 'drive' | 'volume' | 'root'
}

interface FolderPickerProps {
  initialPath?: string
  multiSelect?: boolean
  mode?: 'folders' | 'files'
  title?: string
  emptyMessage?: string
  confirmLabel?: string
  onSelect: (paths: string[]) => void
  onClose: () => void
}

export function FolderPicker({ initialPath, multiSelect = true, mode = 'folders', title, emptyMessage, confirmLabel, onSelect, onClose }: FolderPickerProps) {
  const { t } = useTranslation()
  const [currentPath, setCurrentPath] = useState<string>(initialPath || '')
  const [pathInput, setPathInput] = useState<string>(initialPath || '')
  const [entries, setEntries] = useState<FolderEntry[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [quickLocations, setQuickLocations] = useState<QuickLocation[]>([])
  const [quickError, setQuickError] = useState<string | null>(null)
  const newFolderInputRef = useRef<HTMLInputElement>(null)
  const didMountShowHiddenRef = useRef(false)
  const selectedEntries = entries.filter(entry => selected.has(entry.path))
  const deletableEntries = selectedEntries.filter(entry => entry.isDirectory)
  const canDeleteSelected = !loading && !creating && deletableEntries.length > 0 && deletableEntries.length === selectedEntries.length

  const logPerf = useCallback((label: string, startedAt: number, details: Record<string, unknown> = {}) => {
    const elapsedMs = performance.now() - startedAt
    if (elapsedMs >= 50) {
      host.debug.log?.(`[FolderPicker] ${label}: ${elapsedMs.toFixed(0)}ms`, details)
    }
  }, [])

  const loadDir = useCallback(async (dirPath: string) => {
    const startedAt = performance.now()
    let entryCount = 0
    let outcome = 'ok'
    setLoading(true)
    setError(null)
    try {
      if (mode === 'files') {
        const entries = await host.fs.readdir(dirPath)
        const visible = entries
          .filter(e => showHidden || !e.name.startsWith('.'))
          .filter(e => e.isDirectory || isProcfileName(e.name))
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
            return a.name.localeCompare(b.name)
          })
          .map(e => ({ name: e.name, path: e.path, isDirectory: e.isDirectory }))
        entryCount = visible.length
        const normalized = dirPath.replace(/[/\\]+$/, '') || dirPath
        const parentMatch = normalized.match(/^(.*)[/\\][^/\\]+$/)
        setCurrentPath(dirPath)
        setPathInput(dirPath)
        setParent(parentMatch ? parentMatch[1] || (dirPath.startsWith('/') ? '/' : null) : null)
        setEntries(visible)
        setSelected(new Set())
        return
      }
      const result = await host.fs.listDirs(dirPath, showHidden)
      if ('error' in result) {
        outcome = 'error'
        setError(result.error)
        return
      }
      entryCount = result.entries.length
      setCurrentPath(result.current)
      setPathInput(result.current)
      setParent(result.parent)
      setEntries(result.entries.map(entry => ({ ...entry, isDirectory: true })))
      setSelected(new Set())
    } catch (err) {
      outcome = 'throw'
      throw err
    } finally {
      logPerf(mode === 'files' ? 'readdir' : 'listDirs', startedAt, {
        mode,
        path: dirPath,
        includeHidden: showHidden,
        entries: entryCount,
        outcome,
      })
      setLoading(false)
    }
  }, [logPerf, mode, showHidden])

  // Resolve initial path: explicit prop, else home. Also load quick links.
  useEffect(() => {
    const init = async () => {
      let start = initialPath || ''
      if (!start) {
        const homeStartedAt = performance.now()
        try {
          start = await host.fs.home()
          logPerf('home', homeStartedAt)
        } catch {
          logPerf('home', homeStartedAt, { outcome: 'error' })
          start = '/'
        }
      }
      void loadDir(start)
      const quickStartedAt = performance.now()
      try {
        const qls = await host.fs.quickLocations()
        logPerf('quickLocations', quickStartedAt, { entries: qls.length })
        setQuickLocations(qls)
        if (!qls || qls.length === 0) {
          setQuickError('quickLocations returned empty')
          host.debug.log?.('[FolderPicker] quickLocations returned empty array')
        }
      } catch (err) {
        logPerf('quickLocations', quickStartedAt, { outcome: 'error' })
        const msg = err instanceof Error ? err.message : String(err)
        host.debug.log?.('[FolderPicker] quickLocations failed:', msg)
        setQuickLocations([])
        setQuickError(msg)
      }
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload when toggling hidden
  useEffect(() => {
    if (!didMountShowHiddenRef.current) {
      didMountShowHiddenRef.current = true
      return
    }
    if (currentPath) loadDir(currentPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden])

  useEffect(() => {
    if (creating && newFolderInputRef.current) {
      newFolderInputRef.current.focus()
    }
  }, [creating])

  const handleDeleteSelected = useCallback(async () => {
    if (!canDeleteSelected) return

    const confirmed = await host.dialog.confirm(
      deletableEntries.length === 1
        ? t('folderPicker.deleteConfirmSingle', { name: deletableEntries[0].name })
        : t('folderPicker.deleteConfirmMulti', { count: deletableEntries.length }),
      t('folderPicker.deleteConfirmTitle')
    )
    if (!confirmed) return

    setError(null)
    for (const entry of deletableEntries) {
      const result = await host.fs.deletePath(entry.path)
      if ('error' in result) {
        setError(result.error)
        return
      }
    }
    await loadDir(currentPath)
  }, [canDeleteSelected, currentPath, deletableEntries, loadDir, t])

  // Esc to close (top-level only — when creating, Esc cancels create)
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null
      if (!element) return false
      const tag = element.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable
    }

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (creating) { setCreating(false); setNewFolderName(''); setCreateError(null) }
        else onClose()
        return
      }
      if (e.key === 'Delete' && !isTypingTarget(e.target) && canDeleteSelected) {
        e.preventDefault()
        void handleDeleteSelected()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [canDeleteSelected, creating, handleDeleteSelected, onClose])

  const navigate = (path: string) => {
    loadDir(path)
  }

  const goUp = () => {
    if (parent) loadDir(parent)
  }

  const toggleSelected = (path: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        if (!multiSelect) next.clear()
        next.add(path)
      }
      return next
    })
  }

  const handleConfirm = () => {
    if (selected.size > 0) {
      onSelect(Array.from(selected))
    } else if (mode === 'folders' && currentPath) {
      onSelect([currentPath])
    }
  }

  const handlePathInputSubmit = () => {
    const trimmed = pathInput.trim()
    if (trimmed && trimmed !== currentPath) {
      loadDir(trimmed)
    }
  }

  const handleCreateFolder = async () => {
    const name = newFolderName.trim()
    if (!name) return
    setCreateError(null)
    const result = await host.fs.mkdir(currentPath, name)
    if ('error' in result) {
      setCreateError(result.error)
      return
    }
    setCreating(false)
    setNewFolderName('')
    loadDir(currentPath)
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel folder-picker" onClick={e => e.stopPropagation()} style={{ maxWidth: 760, width: '92%' }}>
        <div className="settings-header">
          <h2>{title || t('folderPicker.title')}</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-body" style={{ padding: 0, display: 'flex', minHeight: 420 }}>
          {/* Sidebar: quick locations */}
          <div className="folder-picker-sidebar">
            {quickError && (
              <div style={{ padding: '6px 10px', fontSize: 11, color: '#e5534b', wordBreak: 'break-word' }}>
                {quickError}
              </div>
            )}
            {quickLocations.map(ql => (
              <button
                key={`${ql.kind}:${ql.path}`}
                className={`folder-picker-quick ${currentPath === ql.path ? 'active' : ''}`}
                onClick={() => loadDir(ql.path)}
                title={ql.path}
              >
                <span className="folder-picker-quick-icon">
                  {ql.kind === 'home' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 12l9-9 9 9" /><path d="M5 10v10h14V10" />
                    </svg>
                  ) : ql.kind === 'drive' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="6" cy="12" r="1" fill="currentColor" />
                    </svg>
                  ) : ql.kind === 'volume' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <ellipse cx="12" cy="6" rx="9" ry="3" /><path d="M3 6v6c0 1.7 4 3 9 3s9-1.3 9-3V6" /><path d="M3 12v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  )}
                </span>
                <span className="folder-picker-quick-name">{ql.name}</span>
              </button>
            ))}
          </div>
          {/* Main column */}
          <div className="folder-picker-main" style={{ flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          {/* Path bar */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="profile-action-btn"
              onClick={goUp}
              disabled={!parent || loading}
              title={t('folderPicker.goUp')}
              style={{ flexShrink: 0 }}
            >
              ↑
            </button>
            <input
              type="text"
              className="profile-name-input"
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handlePathInputSubmit() }}
              placeholder={t('folderPicker.pathPlaceholder')}
              spellCheck={false}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
            />
            <button
              className="profile-action-btn"
              onClick={handlePathInputSubmit}
              disabled={loading}
              style={{ flexShrink: 0 }}
            >
              {t('folderPicker.go')}
            </button>
          </div>

          {/* Toolbar */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showHidden}
                onChange={e => setShowHidden(e.target.checked)}
              />
              {t('folderPicker.showHidden')}
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="profile-action-btn"
                onClick={() => { void handleDeleteSelected() }}
                disabled={!canDeleteSelected}
                title={t('folderPicker.deleteSelectedTitle')}
              >
                {t('common.delete')}
              </button>
              <button
                className="profile-action-btn"
                onClick={() => { setCreating(true); setNewFolderName(''); setCreateError(null) }}
                disabled={mode !== 'folders' || loading || creating || !!error}
              >
                {t('folderPicker.newFolder')}
              </button>
            </div>
          </div>

          {/* New folder inline form */}
          {creating && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                ref={newFolderInputRef}
                type="text"
                className="profile-name-input"
                placeholder={t('folderPicker.newFolderNamePlaceholder')}
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreateFolder()
                }}
                style={{ flex: 1 }}
              />
              <button className="profile-action-btn" onClick={handleCreateFolder} disabled={!newFolderName.trim()}>
                {t('common.create')}
              </button>
              <button className="profile-action-btn" onClick={() => { setCreating(false); setNewFolderName(''); setCreateError(null) }}>
                {t('common.cancel')}
              </button>
            </div>
          )}
          {createError && (
            <div style={{ color: '#e5534b', fontSize: 12 }}>{createError}</div>
          )}

          {/* Listing */}
          <div className="folder-picker-list">
            {loading && <div className="folder-picker-empty">{t('folderPicker.loading')}</div>}
            {!loading && error && <div className="folder-picker-empty" style={{ color: '#e5534b' }}>{error}</div>}
            {!loading && !error && entries.length === 0 && (
              <div className="folder-picker-empty">{emptyMessage || t('folderPicker.empty')}</div>
            )}
            {!loading && !error && entries.map(entry => {
              const isSel = selected.has(entry.path)
              return (
                <div
                  key={entry.path}
                  className={`folder-picker-item ${isSel ? 'selected' : ''}`}
                  onClick={() => toggleSelected(entry.path)}
                  onDoubleClick={() => {
                    if (entry.isDirectory) navigate(entry.path)
                    else toggleSelected(entry.path)
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => toggleSelected(entry.path)}
                    onClick={e => e.stopPropagation()}
                  />
                  {entry.isDirectory ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, opacity: 0.7 }}>
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, opacity: 0.7 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <path d="M14 2v6h6" />
                    </svg>
                  )}
                  <span className="folder-picker-item-name">{entry.name}</span>
                </div>
              )
            })}
          </div>

          {/* Footer */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color, #30363d)', paddingTop: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {selected.size > 0
                ? t('folderPicker.selectedCount', { count: selected.size })
                : t('folderPicker.useCurrentHint')}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="profile-action-btn" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                className="profile-action-btn"
                onClick={handleConfirm}
                disabled={loading || !!error || (mode === 'files' && selected.size === 0)}
              >
                {confirmLabel || (selected.size > 0
                  ? t('folderPicker.addSelected', { count: selected.size })
                  : t('folderPicker.useCurrent'))}
              </button>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}
