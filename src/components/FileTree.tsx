import { host } from '../host-api'
import { useState, useEffect, useCallback, useRef } from 'react'
import { HighlightedCode } from './PathLinker'
import { MarkdownPreview } from './MarkdownPreview'
import { isProcfileName } from '../utils/procfile-parser'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface FileTreeProps {
  rootPath: string
}

const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less', 'html', 'htm',
  'md', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
  'ps1', 'cmd', 'plist', 'nuspec',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs',
  'env', 'gitignore', 'editorconfig', 'prettierrc', 'eslintrc',
  'dockerfile', 'makefile', 'license', 'cfg', 'ini', 'conf', 'log',
])

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

function getFileExt(name: string): string {
  const lower = name.toLowerCase()
  // Handle dotfiles like .gitignore, .env
  if (lower.startsWith('.') && !lower.includes('.', 1)) {
    return lower.substring(1)
  }
  return lower.split('.').pop() || ''
}

function canPreview(name: string): 'text' | 'image' | 'pdf' | null {
  const ext = getFileExt(name)
  if (isProcfileName(name)) return 'text'
  if (TEXT_EXTS.has(ext)) return 'text'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  return null
}

function FileTreeNode({
  entry, depth, selectedPath, onSelect, onContextMenu,
}: {
  entry: FileEntry; depth: number; selectedPath: string | null; onSelect: (entry: FileEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  const handleClick = useCallback(async () => {
    if (entry.isDirectory) {
      if (expanded) {
        setExpanded(false)
        return
      }
      if (children === null) {
        setLoading(true)
        try {
          const entries = await host.fs.readdir(entry.path)
          setChildren(entries)
        } catch {
          setChildren([])
        }
        setLoading(false)
      }
      setExpanded(true)
    } else {
      onSelect(entry)
    }
  }, [entry, expanded, children, onSelect])

  const icon = entry.isDirectory
    ? (expanded ? '📂' : '📁')
    : getFileIcon(entry.name)

  const isSelected = !entry.isDirectory && entry.path === selectedPath

  return (
    <>
      <div
        className={`file-tree-item ${entry.isDirectory ? 'file-tree-folder' : 'file-tree-file'} ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
      >
        <span className="file-tree-icon">{icon}</span>
        <span className="file-tree-name">{entry.name}</span>
        {loading && <span className="file-tree-loading">...</span>}
      </div>
      {expanded && children && children.map(child => (
        <FileTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  )
}

function getFileIcon(name: string): string {
  const ext = getFileExt(name)
  if (isProcfileName(name)) return '⚙️'
  switch (ext) {
    case 'ts': case 'tsx': return '🔷'
    case 'js': case 'jsx': return '🟡'
    case 'json': return '📋'
    case 'css': case 'scss': case 'less': return '🎨'
    case 'html': case 'htm': return '🌐'
    case 'md': return '📝'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': return '🖼️'
    case 'sh': case 'bash': case 'zsh': case 'ps1': case 'cmd': return '⚙️'
    case 'yml': case 'yaml': case 'toml': return '⚙️'
    case 'plist': case 'nuspec': return '⚙️'
    case 'lock': return '🔒'
    case 'py': return '🐍'
    case 'go': return '🔵'
    case 'rs': return '🦀'
    default: return '📄'
  }
}

function clearSearchHighlights(container: HTMLElement) {
  const existingMarks = container.querySelectorAll('mark.search-highlight')
  existingMarks.forEach(mark => {
    const parent = mark.parentNode
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
      parent.normalize()
    }
  })
}

function highlightSearchMatches(container: HTMLElement, query: string): number {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 0

  const textNodes: Text[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('script, style, mark.search-highlight')) return NodeFilter.FILTER_REJECT
      return node.nodeValue?.toLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
    },
  })

  let currentNode: Text | null
  while ((currentNode = walker.nextNode() as Text | null)) {
    textNodes.push(currentNode)
  }

  let total = 0
  for (const textNode of textNodes) {
    const text = textNode.nodeValue || ''
    const lowerText = text.toLowerCase()
    const fragment = document.createDocumentFragment()
    let lastIndex = 0
    let matchIndex = lowerText.indexOf(normalizedQuery, lastIndex)

    while (matchIndex !== -1) {
      if (matchIndex > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, matchIndex)))
      }
      const mark = document.createElement('mark')
      mark.className = 'search-highlight'
      mark.dataset.matchIndex = String(total)
      mark.textContent = text.slice(matchIndex, matchIndex + normalizedQuery.length)
      fragment.appendChild(mark)
      total += 1
      lastIndex = matchIndex + normalizedQuery.length
      matchIndex = lowerText.indexOf(normalizedQuery, lastIndex)
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
    }
    textNode.parentNode?.replaceChild(fragment, textNode)
  }

  return total
}

function FilePreview({ filePath, fileName, refreshKey }: { filePath: string; fileName: string; refreshKey: number }) {
  const [content, setContent] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'source' | 'rendered'>('rendered')
  const previewContentRef = useRef<HTMLDivElement>(null)
  const previewSearchInputRef = useRef<HTMLInputElement>(null)
  const [previewSearchOpen, setPreviewSearchOpen] = useState(false)
  const [previewSearchQuery, setPreviewSearchQuery] = useState('')
  const [previewMatchCount, setPreviewMatchCount] = useState(0)
  const [previewCurrentMatch, setPreviewCurrentMatch] = useState(0)
  const isMarkdown = getFileExt(fileName) === 'md'

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setImageUrl(null)
    setError(null)
    setLoading(true)

    const type = canPreview(fileName)
    if (type === 'text') {
      host.fs.readFile(filePath).then(result => {
        if (cancelled) return
        if (result.error) {
          setError(result.error === 'File too large' ? `File too large (${Math.round((result.size || 0) / 1024)}KB)` : result.error)
        } else {
          setContent(result.content || '')
        }
        setLoading(false)
      })
    } else if (type === 'image') {
      host.image.readAsDataUrl(filePath).then(url => {
        if (cancelled) return
        setImageUrl(url)
        setLoading(false)
      }).catch(() => {
        if (cancelled) return
        setError('Failed to load image')
        setLoading(false)
      })
    } else if (type === 'pdf') {
      setLoading(false)
    } else {
      setError('Preview not available for this file type')
      setLoading(false)
    }

    return () => { cancelled = true }
  }, [filePath, fileName, refreshKey])

  useEffect(() => {
    if (previewSearchOpen) {
      setTimeout(() => previewSearchInputRef.current?.focus(), 50)
    }
  }, [previewSearchOpen])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && content !== null) {
        event.preventDefault()
        event.stopPropagation()
        setPreviewSearchOpen(true)
        return
      }
      if (event.key === 'Escape' && previewSearchOpen) {
        event.preventDefault()
        event.stopPropagation()
        setPreviewSearchOpen(false)
        setPreviewSearchQuery('')
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [content, previewSearchOpen])

  useEffect(() => {
    const container = previewContentRef.current
    if (!container) return

    clearSearchHighlights(container)
    const total = highlightSearchMatches(container, previewSearchQuery)
    setPreviewMatchCount(total)
    setPreviewCurrentMatch(total > 0 ? 1 : 0)

    if (total > 0) {
      const firstMatch = container.querySelector('mark.search-highlight[data-match-index="0"]')
      container.querySelectorAll('mark.search-highlight').forEach(mark => mark.classList.remove('current'))
      firstMatch?.classList.add('current')
      firstMatch?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [content, viewMode, previewSearchQuery])

  const navigatePreviewMatch = useCallback((direction: 1 | -1) => {
    const container = previewContentRef.current
    if (!container || previewMatchCount === 0) return

    const nextMatch = direction === 1
      ? (previewCurrentMatch % previewMatchCount) + 1
      : ((previewCurrentMatch - 2 + previewMatchCount) % previewMatchCount) + 1

    setPreviewCurrentMatch(nextMatch)
    container.querySelectorAll('mark.search-highlight').forEach(mark => mark.classList.remove('current'))
    const target = container.querySelector(`mark.search-highlight[data-match-index="${nextMatch - 1}"]`)
    target?.classList.add('current')
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [previewCurrentMatch, previewMatchCount])

  if (loading) {
    return <div className="file-preview-status">Loading...</div>
  }

  if (error) {
    return <div className="file-preview-status">{error}</div>
  }

  if (imageUrl) {
    return (
      <div className="file-preview-image">
        <img src={imageUrl} alt={fileName} />
      </div>
    )
  }

  if (canPreview(fileName) === 'pdf') {
    return (
      <div className="file-preview-pdf">
        <iframe
          src={`file://${filePath}`}
          style={{ width: '100%', height: '100%', border: 'none' }}
          title={`PDF Preview: ${fileName}`}
        />
      </div>
    )
  }

  if (content !== null) {
    return (
      <>
        {isMarkdown && (
          <div className="file-preview-mode-bar">
            <button className={`git-diff-mode-btn${viewMode === 'rendered' ? ' active' : ''}`} onClick={() => setViewMode('rendered')}>Preview</button>
            <button className={`git-diff-mode-btn${viewMode === 'source' ? ' active' : ''}`} onClick={() => setViewMode('source')}>Source</button>
          </div>
        )}
        {previewSearchOpen && (
          <div className="file-preview-search">
            <input
              ref={previewSearchInputRef}
              className="file-preview-search-input"
              type="text"
              placeholder="Search in preview..."
              value={previewSearchQuery}
              onChange={(event) => setPreviewSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  navigatePreviewMatch(event.shiftKey ? -1 : 1)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setPreviewSearchOpen(false)
                  setPreviewSearchQuery('')
                }
              }}
            />
            {previewSearchQuery && (
              <span className="file-preview-search-count">
                {previewMatchCount > 0 ? `${previewCurrentMatch}/${previewMatchCount}` : 'No results'}
              </span>
            )}
            <button className="file-preview-search-nav" onClick={() => navigatePreviewMatch(-1)} disabled={previewMatchCount === 0} title="Previous (Shift+Enter)">↑</button>
            <button className="file-preview-search-nav" onClick={() => navigatePreviewMatch(1)} disabled={previewMatchCount === 0} title="Next (Enter)">↓</button>
          </div>
        )}
        <div className="file-preview-scroll" ref={previewContentRef}>
          {isMarkdown && viewMode === 'rendered'
            ? <MarkdownPreview content={content} />
            : <HighlightedCode code={content} ext={getFileExt(fileName)} className="file-preview-text" />
          }
        </div>
      </>
    )
  }

  return null
}

export function FileTree({ rootPath }: Readonly<FileTreeProps>) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null)
  const restoredRef = useRef(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadRoot = useCallback(async () => {
    setLoading(true)
    try {
      const result = await host.fs.readdir(rootPath)
      setEntries(result)
    } catch {
      setEntries([])
    }
    setLoading(false)
  }, [rootPath])

  const handleRefresh = useCallback(() => {
    setRefreshKey(k => k + 1)
    loadRoot()
  }, [loadRoot])

  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (selectedFile) return
        e.preventDefault()
        e.stopPropagation()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }
      if (e.key === 'Escape' && document.activeElement === searchInputRef.current && searchQuery) {
        e.preventDefault()
        setSearchQuery('')
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [searchQuery, selectedFile])

  // Restore scroll position after entries load
  useEffect(() => {
    if (loading || !listRef.current) return
    const saved = localStorage.getItem(`file-tree-scroll:${rootPath}`)
    if (saved) listRef.current.scrollTop = Number(saved)
  }, [loading, rootPath])

  // Watch for file system changes and auto-refresh
  useEffect(() => {
    host.fs.watch(rootPath)
    const unsubscribe = host.fs.onChanged((changedPath: string) => {
      if (changedPath === rootPath) {
        setRefreshKey(k => k + 1)
        loadRoot()
      }
    })
    return () => {
      unsubscribe()
      host.fs.unwatch(rootPath)
    }
  }, [rootPath, loadRoot])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [contextMenu])

  // Debounced search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await host.fs.search(rootPath, q)
        setSearchResults(results)
      } catch {
        setSearchResults([])
      }
      setSearching(false)
    }, 300)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [searchQuery, rootPath])

  // Restore last selected file on mount
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const storageKey = `file-tree-selected:${rootPath}`
    const saved = localStorage.getItem(storageKey)
    if (!saved) return
    try {
      const { path, name } = JSON.parse(saved)
      // Check if file still exists
      host.fs.readFile(path).then(result => {
        if (!result.error) {
          setSelectedFile({ path, name, isDirectory: false })
        } else {
          localStorage.removeItem(storageKey)
        }
      })
    } catch {
      localStorage.removeItem(storageKey)
    }
  }, [rootPath])

  const handleSelect = useCallback((entry: FileEntry) => {
    setSelectedFile(entry)
    localStorage.setItem(`file-tree-selected:${rootPath}`, JSON.stringify({ path: entry.path, name: entry.name }))
  }, [rootPath])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const getRelativePath = useCallback((filePath: string) => {
    // Normalize separators and compute relative path
    const norm = (p: string) => p.replace(/\\/g, '/')
    const rel = norm(filePath).replace(norm(rootPath), '').replace(/^\//, '')
    return rel
  }, [rootPath])

  const handleCopyRelativePath = useCallback(() => {
    if (!contextMenu) return
    navigator.clipboard.writeText(getRelativePath(contextMenu.entry.path))
    setContextMenu(null)
  }, [contextMenu, getRelativePath])

  const handleCopyAbsolutePath = useCallback(() => {
    if (!contextMenu) return
    navigator.clipboard.writeText(contextMenu.entry.path)
    setContextMenu(null)
  }, [contextMenu])

  const handleOpenInExplorer = useCallback(() => {
    if (!contextMenu) return
    const target = contextMenu.entry.isDirectory
      ? contextMenu.entry.path
      : contextMenu.entry.path.replace(/[\\/][^\\/]+$/, '') // parent dir
    host.shell.openPath(target)
    setContextMenu(null)
  }, [contextMenu])

  if (loading && entries.length === 0) {
    return <div className="file-tree-empty">Loading...</div>
  }

  if (entries.length === 0) {
    return <div className="file-tree-empty">No files found</div>
  }

  const displayEntries = searchResults !== null ? searchResults : entries

  return (
    <div className="file-tree-split">
      <div className="file-tree">
        <div className="file-tree-header">
          <input
            ref={searchInputRef}
            className="file-tree-search"
            type="text"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button className="file-tree-refresh-btn" onClick={handleRefresh} title="Refresh">↻</button>
        </div>
        <div
          className="file-tree-list"
          ref={listRef}
          onScroll={(e) => {
            const top = (e.currentTarget as HTMLDivElement).scrollTop
            if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current)
            scrollSaveTimerRef.current = setTimeout(() => {
              localStorage.setItem(`file-tree-scroll:${rootPath}`, String(top))
            }, 200)
          }}
        >
          {searching && <div className="file-tree-item file-tree-loading-row">Searching...</div>}
          {searchResults !== null ? (
            // Search results: flat list with relative paths
            displayEntries.map(entry => (
              <div
                key={entry.path}
                className={`file-tree-item file-tree-file ${entry.path === selectedFile?.path ? 'selected' : ''}`}
                style={{ paddingLeft: '12px' }}
                onClick={() => {
                  if (!entry.isDirectory) handleSelect(entry)
                }}
                onContextMenu={(e) => handleContextMenu(e, entry)}
              >
                <span className="file-tree-icon">{entry.isDirectory ? '📁' : getFileIcon(entry.name)}</span>
                <span className="file-tree-name file-tree-search-path">{getRelativePath(entry.path)}</span>
              </div>
            ))
          ) : (
            entries.map(entry => (
              <FileTreeNode
                key={`${entry.path}:${refreshKey}`}
                entry={entry}
                depth={0}
                selectedPath={selectedFile?.path || null}
                onSelect={handleSelect}
                onContextMenu={handleContextMenu}
              />
            ))
          )}
          {searchResults !== null && searchResults.length === 0 && !searching && (
            <div className="file-tree-empty">No matches</div>
          )}
        </div>
      </div>
      <div className="file-preview">
        {selectedFile ? (
          <>
            <div className="file-preview-header">
              <span className="file-preview-filename">{selectedFile.name}</span>
              <button className="file-tree-refresh-btn" onClick={handleRefresh} title="Refresh">↻</button>
            </div>
            <div className="file-preview-body">
              <FilePreview filePath={selectedFile.path} fileName={selectedFile.name} refreshKey={refreshKey} />
            </div>
          </>
        ) : (
          <div className="file-preview-status">Select a file to preview</div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="workspace-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="context-menu-item" onClick={handleCopyRelativePath}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
            Copy Relative Path
          </div>
          <div className="context-menu-item" onClick={handleCopyAbsolutePath}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
              <line x1="8" y1="10" x2="16" y2="10" />
              <line x1="8" y1="14" x2="12" y2="14" />
            </svg>
            Copy Absolute Path
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleOpenInExplorer}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Open in Explorer
          </div>
        </div>
      )}
    </div>
  )
}
