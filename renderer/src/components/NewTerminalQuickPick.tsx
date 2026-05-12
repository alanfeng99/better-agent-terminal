import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AGENT_PRESETS, getVisiblePresets, type AgentPreset, type AgentPresetId } from '../types/agent-presets'

export type QuickPickChoice =
  | { kind: 'terminal' }
  | { kind: 'worktree' }
  | { kind: 'agent'; presetId: AgentPresetId }

interface NewTerminalQuickPickProps {
  isGitRepo: boolean
  // Preset IDs the host actually supports. `null` means "still loading" — we
  // fall back to the local visible list so the picker isn't empty during the
  // brief fetch window.
  supportedPresetIds: string[] | null
  onSelect: (choice: QuickPickChoice) => void
  onClose: () => void
}

interface Item {
  key: string
  name: string
  icon: string
  color: string
  choice: QuickPickChoice
  searchText: string
}

const TERMINAL_PRESET = AGENT_PRESETS.find(p => p.id === 'none')!

function buildItems(isGitRepo: boolean, supportedPresetIds: string[] | null): Item[] {
  const items: Item[] = [
    {
      key: 'terminal',
      name: TERMINAL_PRESET.name,
      icon: TERMINAL_PRESET.icon,
      color: TERMINAL_PRESET.color,
      choice: { kind: 'terminal' },
      searchText: TERMINAL_PRESET.name.toLowerCase(),
    },
  ]
  if (isGitRepo) {
    items.push({
      key: 'worktree',
      name: 'Terminal (Worktree)',
      icon: '🌳',
      color: '#22c55e',
      choice: { kind: 'worktree' },
      searchText: 'terminal worktree',
    })
  }
  const presets = getVisiblePresets().filter((p: AgentPreset) =>
    p.id !== 'none'
    && (!p.needsGitRepo || isGitRepo)
    && (supportedPresetIds === null || supportedPresetIds.includes(p.id))
  )
  for (const p of presets) {
    items.push({
      key: p.id,
      name: p.name,
      icon: p.icon,
      color: p.color,
      choice: { kind: 'agent', presetId: p.id as AgentPresetId },
      searchText: `${p.name} ${p.id}`.toLowerCase(),
    })
  }
  return items
}

export function NewTerminalQuickPick({ isGitRepo, supportedPresetIds, onSelect, onClose }: Readonly<NewTerminalQuickPickProps>) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const allItems = useMemo(() => buildItems(isGitRepo, supportedPresetIds), [isGitRepo, supportedPresetIds])
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allItems
    const tokens = q.split(/\s+/)
    return allItems.filter(item => tokens.every(tok => item.searchText.includes(tok)))
  }, [allItems, query])

  useEffect(() => { setIndex(0) }, [query])
  useEffect(() => { inputRef.current?.focus() }, [])

  const commit = useCallback((choice: QuickPickChoice) => {
    onSelect(choice)
    onClose()
  }, [onSelect, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex(prev => Math.min(prev + 1, items.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex(prev => Math.max(prev - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[index]
      if (item) commit(item.choice)
      return
    }
  }, [items, index, commit, onClose])

  // Keep selected item in view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const el = list.querySelector(`[data-qp-index="${index}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  return (
    <div className="claude-file-picker" onClick={onClose}>
      <div className="claude-file-picker-box" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="claude-file-picker-input"
          placeholder={t('quickPick.searchPlaceholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div ref={listRef} className="claude-file-picker-list">
          {items.length === 0 && (
            <div className="claude-file-picker-empty">{t('quickPick.noMatches')}</div>
          )}
          {items.map((item, i) => (
            <div
              key={item.key}
              data-qp-index={i}
              className={`claude-file-picker-item${i === index ? ' selected' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => commit(item.choice)}
            >
              <span className="claude-file-picker-name" style={{ color: item.color, minWidth: 18, textAlign: 'center' }}>{item.icon}</span>
              <span className="claude-file-picker-name">{item.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
