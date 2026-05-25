import { host, type TerminalViewportState } from '../host-api'
import { useEffect, useRef, useState, memo, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { workspaceStore } from '../stores/workspace-store'
import { settingsStore } from '../stores/settings-store'
import type { AgentPresetId } from '../types/agent-presets'
import { createPtyInputWriter, type PtyInputWriter } from '../utils/pty-input-writer'
import { getTerminalKeyInputOverride, shouldBlockForImeComposition } from '../utils/terminal-key-input'
import '@xterm/xterm/css/xterm.css'

const dlog = (...args: unknown[]) => host.debug.log(...args)
const MOBILE_TERMINAL_COLS = 56
const MOBILE_TERMINAL_ROWS = 24
const DEFAULT_VIEWPORT_STATE: TerminalViewportState = {
  mode: 'desktop',
  cols: 100,
  rows: 30,
  updatedBy: 'desktop',
  updatedAt: 0,
}
interface TerminalPanelProps {
  terminalId: string
  onClose?: (id: string) => void
  isActive?: boolean
  terminalType?: 'terminal' | 'code-agent'
  agentPreset?: AgentPresetId
  ptyReady?: boolean
  onReadySize?: (size: { cols: number, rows: number }) => void
}

interface ContextMenu {
  x: number
  y: number
  hasSelection: boolean
}

function getWindowsBuildNumber(): number | undefined {
  if (host.platform !== 'win32') return undefined
  const version = host.systemVersion
  const build = Number(version.split('.').pop())
  return Number.isFinite(build) ? build : undefined
}

function isClaudeCliPreset(agentPreset?: AgentPresetId): boolean {
  return agentPreset === 'claude-cli' || agentPreset === 'claude-cli-worktree'
}

export const TerminalPanel = memo(function TerminalPanel({
  terminalId,
  onClose,
  isActive = true,
  terminalType,
  agentPreset,
  ptyReady = true,
  onReadySize,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [terminalReady, setTerminalReady] = useState(false)
  const [viewportState, setViewportState] = useState<TerminalViewportState>(DEFAULT_VIEWPORT_STATE)
  const hasBeenFocusedRef = useRef(false)
  const isActiveRef = useRef(isActive)
  const doResizeRef = useRef<(() => void) | null>(null)
  const supportsImagePaste = agentPreset === 'codex-cli' || isClaudeCliPreset(agentPreset)
  const isClaudeCliTerminal = isClaudeCliPreset(agentPreset)
  const ptyReadyRef = useRef(ptyReady)
  const ptyInputRef = useRef<PtyInputWriter | null>(null)
  const onReadySizeRef = useRef(onReadySize)
  const viewportStateRef = useRef(viewportState)
  const { t } = useTranslation()

  // Keep isActiveRef in sync with isActive prop
  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    ptyReadyRef.current = ptyReady
    if (ptyReady) {
      doResizeRef.current?.()
    }
  }, [ptyReady])

  useEffect(() => {
    onReadySizeRef.current = onReadySize
  }, [onReadySize])

  useEffect(() => {
    viewportStateRef.current = viewportState
  }, [viewportState])

  useEffect(() => {
    setViewportState(DEFAULT_VIEWPORT_STATE)
  }, [terminalId])

  useEffect(() => {
    return host.pty.onViewportState((id: string, state: TerminalViewportState) => {
      if (id !== terminalId) return
      setViewportState(state)
    })
  }, [terminalId])

  useEffect(() => {
    if (!ptyReady) return
    let cancelled = false
    host.pty.getViewportState(terminalId)
      .then((state: TerminalViewportState) => {
        if (!cancelled) setViewportState(state)
      })
      .catch(() => {
        // PTY startup can lag behind the panel mount; desktop is the runtime default.
      })
    return () => {
      cancelled = true
    }
  }, [ptyReady, terminalId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    if (viewportState.mode === 'mobile') {
      const cols = viewportState.cols > 0 ? viewportState.cols : MOBILE_TERMINAL_COLS
      const rows = viewportState.rows > 0 ? viewportState.rows : MOBILE_TERMINAL_ROWS
      if (terminal.cols !== cols || terminal.rows !== rows) {
        terminal.resize(cols, rows)
      }
      requestAnimationFrame(() => {
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      })
      return
    }
    if (isActiveRef.current) {
      requestAnimationFrame(() => doResizeRef.current?.())
    }
  }, [viewportState.mode, viewportState.cols, viewportState.rows])

  const pasteAbortRef = useRef<{ cancelled: boolean } | null>(null)

  const writePtyInput = (data: string) => {
    const writer = ptyInputRef.current
    if (writer) {
      writer.write(data)
    } else {
      host.pty.write(terminalId, data)
    }
  }

  // Chunked write with sequential scheduling (avoids creating thousands of timers)
  const writeChunked = (text: string) => {
    const CHUNK_SIZE = 2000
    const DELAY = 30
    const abort = { cancelled: false }
    pasteAbortRef.current = abort
    let offset = 0

    const sendNext = () => {
      if (abort.cancelled || offset >= text.length) {
        pasteAbortRef.current = null
        return
      }
      const chunk = text.slice(offset, offset + CHUNK_SIZE)
      offset += CHUNK_SIZE
      writePtyInput(chunk)
      setTimeout(sendNext, DELAY)
    }
    sendNext()
  }

  // Handle paste with size confirmation for large text
  const handlePasteText = async (text: string) => {
    if (!text) return

    // Cancel any in-progress paste
    if (pasteAbortRef.current) {
      pasteAbortRef.current.cancelled = true
    }

    const CONFIRM_THRESHOLD = 10 * 1024 // 10KB

    if (text.length > CONFIRM_THRESHOLD) {
      const sizeKB = (text.length / 1024).toFixed(1)
      const sizeMB = (text.length / (1024 * 1024)).toFixed(2)
      const sizeLabel = text.length > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`
      const lines = text.split('\n').length

      const confirmed = await host.dialog.confirm(
        `About to paste a large text:\n\n• Size: ${sizeLabel} (${text.length.toLocaleString()} chars)\n• Lines: ${lines.toLocaleString()}\n\nThis may take a moment. Continue?`,
        'Large Paste Warning'
      )
      if (!confirmed) return
    }

    if (text.length > 4000) {
      writeChunked(text)
    } else {
      writePtyInput(text)
    }
  }

  const handlePasteImage = async () => {
    dlog(`[paste-image] begin terminal=${terminalId} type=${terminalType}`)
    let filePath: string | null = null
    try {
      filePath = await host.clipboard.saveImage()
    } catch (err) {
      dlog(`[paste-image] saveImage threw: ${(err as Error)?.message ?? String(err)}`)
      return false
    }
    dlog(`[paste-image] saveImage → ${filePath ?? 'null'}`)
    if (!filePath) return false
    let written = false
    try {
      written = await host.clipboard.writeImage(filePath)
    } catch (err) {
      dlog(`[paste-image] writeImage threw: ${(err as Error)?.message ?? String(err)}`)
      return false
    }
    dlog(`[paste-image] writeImage → ${written}`)
    if (!written) return false
    writePtyInput('\x1bv')
    dlog(`[paste-image] sent \\x1bv to pty terminal=${terminalId}`)
    return true
  }

  const handlePasteFromClipboard = async ({ textOnly = false }: { textOnly?: boolean } = {}) => {
    dlog(`[paste-clipboard] start textOnly=${textOnly} supportsImage=${supportsImagePaste} terminal=${terminalId}`)
    if (!textOnly && supportsImagePaste) {
      try {
        const items = await navigator.clipboard.read()
        const types = items.flatMap(item => item.types)
        const hasImage = types.some(type => type.startsWith('image/'))
        dlog(`[paste-clipboard] navigator.clipboard.read items=${items.length} types=${JSON.stringify(types)} hasImage=${hasImage}`)
        if (hasImage) {
          const pastedImage = await handlePasteImage()
          dlog(`[paste-clipboard] handlePasteImage → ${pastedImage}`)
          if (pastedImage) return
        }
      } catch (err) {
        dlog(`[paste-clipboard] navigator.clipboard.read threw: ${(err as Error)?.message ?? String(err)}`)
      }
    }

    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        await handlePasteText(text)
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err)
    }
  }

  // Handle context menu actions
  const handleCopy = () => {
    if (terminalRef.current) {
      const selection = terminalRef.current.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection)
      }
    }
    setContextMenu(null)
  }

  const handlePaste = async () => {
    await handlePasteFromClipboard()
    setContextMenu(null)
  }

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null)
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  // Handle terminal resize and focus when becoming active
  useEffect(() => {
    if (isActive && terminalReady && terminalRef.current) {
      const terminal = terminalRef.current

      // Use requestAnimationFrame to ensure DOM is fully rendered
      const rafId = requestAnimationFrame(() => {
        if (!terminal) return

        dlog(`[resize] isActive effect → doResize terminal=${terminalId}`)
        doResizeRef.current?.()

        // Force refresh terminal content to fix black screen / text overlap after visibility change
        requestAnimationFrame(() => {
          terminal.clearTextureAtlas()
          terminal.refresh(0, terminal.rows - 1)
          terminal.focus()

          // Execute agent command on first focus for code-agent terminals
          if (!hasBeenFocusedRef.current && terminalType === 'code-agent') {
            hasBeenFocusedRef.current = true
            const terminalInstance = workspaceStore.getState().terminals.find(t => t.id === terminalId)
            if (terminalInstance && !terminalInstance.agentCommandSent && !terminalInstance.hasUserInput) {
              const agentCommand = settingsStore.getAgentCommand()
              if (agentCommand) {
                setTimeout(() => {
                  const currentTerminal = workspaceStore.getState().terminals.find(t => t.id === terminalId)
                  if (isActiveRef.current && currentTerminal && !currentTerminal.hasUserInput && !currentTerminal.agentCommandSent) {
                    writePtyInput(agentCommand + '\r')
                    workspaceStore.markAgentCommandSent(terminalId)
                  }
                }, 3000)
              }
            }
          }
        })
      })

      return () => cancelAnimationFrame(rafId)
    }
  }, [isActive, terminalReady, terminalId, terminalType])

  // Add intersection observer to detect when terminal becomes visible
  useEffect(() => {
    if (!containerRef.current || !terminalRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && isActive && doResizeRef.current) {
            dlog(`[resize] IntersectionObserver → visible, doResize terminal=${terminalId}`)
            setTimeout(() => {
              doResizeRef.current?.()
            }, 50)
          }
        })
      },
      { threshold: 0.1 }
    )

    observer.observe(containerRef.current)

    return () => observer.disconnect()
  }, [isActive, terminalId])

  useEffect(() => {
    if (!containerRef.current) return

    const settings = settingsStore.getSettings()
    const colors = settingsStore.getTerminalColors()
    const windowsBuildNumber = getWindowsBuildNumber()

    // Create terminal instance with customizable colors
    const terminal = new Terminal({
      theme: {
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.cursor,
        cursorAccent: colors.background,
        selectionBackground: '#5c5142',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff'
      },
      fontSize: settings.fontSize,
      fontFamily: settingsStore.getFontFamilyString(),
      cursorBlink: true,
      scrollback: 10000,
      convertEol: !isClaudeCliTerminal,
      allowProposedApi: true,
      allowTransparency: !isClaudeCliTerminal,
      windowsPty: host.platform === 'win32'
        ? {
            backend: 'conpty',
            buildNumber: windowsBuildNumber
          }
        : undefined
    })

    const fitAddon = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      // Open URL in default browser
      host.shell.openExternal(uri)
    })
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(unicode11Addon)
    terminal.unicode.activeVersion = '11'
    terminal.open(containerRef.current)

    // Register file:// URL link provider (WebLinksAddon only handles http/https)
    terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) { callback(undefined); return }
        const text = line.translateToString()
        const fileUrlRegex = /file:\/\/\/[^\s'"\])}>,;`]+/g
        let match
        const links: ILink[] = []
        while ((match = fileUrlRegex.exec(text)) !== null) {
          const url = match[0]
          const startX = match.index + 1
          const endX = match.index + url.length
          links.push({
            text: url,
            range: {
              start: { x: startX, y: bufferLineNumber },
              end: { x: endX, y: bufferLineNumber }
            },
            activate(_event, text) {
              host.shell.openExternal(text)
            }
          })
        }
        callback(links.length > 0 ? links : undefined)
      }
    })

    // Deduplicated resize helper — avoids redundant pty.resize IPC calls
    let lastSentCols = 0
    let lastSentRows = 0
    const doResize = () => {
      const viewport = viewportStateRef.current
      if (viewport.mode === 'mobile') {
        const cols = viewport.cols > 0 ? viewport.cols : MOBILE_TERMINAL_COLS
        const rows = viewport.rows > 0 ? viewport.rows : MOBILE_TERMINAL_ROWS
        if (terminal.cols !== cols || terminal.rows !== rows) {
          terminal.resize(cols, rows)
        }
        return
      }
      fitAddon.fit()
      const { cols, rows } = terminal
      if (ptyReadyRef.current && (cols !== lastSentCols || rows !== lastSentRows)) {
        lastSentCols = cols
        lastSentRows = rows
        dlog(`[resize] pty.resize cols=${cols} rows=${rows} terminal=${terminalId}`)
        host.pty.resize(terminalId, cols, rows)
      }
    }
    doResizeRef.current = doResize

    let readySizeRaf: number | null = null
    let refreshRaf: number | null = null
    const scheduleFullRefresh = () => {
      if (refreshRaf !== null) return
      refreshRaf = requestAnimationFrame(() => {
        refreshRaf = null
        terminal.refresh(0, terminal.rows - 1)
      })
    }
    if (onReadySizeRef.current) {
      readySizeRaf = requestAnimationFrame(() => {
        try {
          fitAddon.fit()
        } catch {
          // xterm can throw if the panel is not measurable yet; report the current fallback size.
        }
        onReadySizeRef.current?.({ cols: terminal.cols, rows: terminal.rows })
      })
    }

    // Fix IME textarea position - force it to bottom left
    const fixImePosition = () => {
      const textarea = containerRef.current?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      if (textarea) {
        textarea.style.position = 'fixed'
        textarea.style.bottom = '80px'
        textarea.style.left = '220px'
        textarea.style.top = 'auto'
        textarea.style.width = '1px'
        textarea.style.height = '20px'
        textarea.style.opacity = '0'
        textarea.style.zIndex = '10'
      }
    }

    // Use MutationObserver to keep fixing position when xterm.js changes it
    let mutationCount = 0
    const observer = new MutationObserver(() => {
      mutationCount++
      if (mutationCount <= 20 || mutationCount % 100 === 0) {
        dlog(`[render] MutationObserver #${mutationCount} terminal=${terminalId}`)
      }
      fixImePosition()
    })

    const textarea = containerRef.current?.querySelector('.xterm-helper-textarea')
    if (textarea) {
      observer.observe(textarea, { attributes: true, attributeFilter: ['style'] })
      fixImePosition()
    }

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    setTerminalReady(true)

    const ptyInput = createPtyInputWriter((chunk) => host.pty.write(terminalId, chunk))
    ptyInputRef.current = ptyInput
    terminal.onData((data) => {
      if (!ptyReadyRef.current) return
      ptyInput.write(data)
      if (terminalType === 'code-agent') {
        workspaceStore.markHasUserInput(terminalId)
      }
    })

    // Track IME composition state on xterm's hidden textarea
    // to prevent CAPS LOCK and other keys from committing partial IME input
    let imeComposing = false
    const xtermTextarea = containerRef.current?.querySelector('.xterm-helper-textarea') as HTMLElement | null
    const onCompositionStart = () => { imeComposing = true }
    const onCompositionEnd = () => { imeComposing = false }
    if (xtermTextarea) {
      xtermTextarea.addEventListener('compositionstart', onCompositionStart)
      xtermTextarea.addEventListener('compositionend', onCompositionEnd)
    }

    // Handle copy and paste shortcuts
    terminal.attachCustomKeyEventHandler((event) => {
      // Only handle keydown events to prevent duplicate actions
      if (event.type !== 'keydown') return true

      const inputOverride = getTerminalKeyInputOverride(event, { imeComposing })
      if (inputOverride !== null) {
        event.preventDefault()
        ptyInput.write(inputOverride)
        if (terminalType === 'code-agent') {
          workspaceStore.markHasUserInput(terminalId)
        }
        return false
      }

      // During IME composition, block non-composition key events
      // to prevent CAPS LOCK etc. from committing partial input. A stale
      // event.isComposing by itself must not block normal terminal typing.
      if (imeComposing || event.isComposing) {
        // keyCode 229 = IME composition event, let it through
        // Editing/navigation keys must still reach xterm so Backspace can
        // delete composing text and recover if compositionend was missed.
        // Everything else (CAPS LOCK, modifiers, etc.) should be blocked.
        return !shouldBlockForImeComposition(event, imeComposing)
      }

      // Ctrl+Shift+C for copy
      if (event.ctrlKey && event.shiftKey && event.key === 'C') {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
        }
        return false
      }
      // Ctrl+Shift+V for paste
      if (event.ctrlKey && event.shiftKey && event.key === 'V') {
        handlePasteFromClipboard({ textOnly: true })
        return false
      }
      // Ctrl/Cmd+V for paste
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        handlePasteFromClipboard()
        return false
      }
      // Ctrl+C for copy when there's a selection
      if (event.ctrlKey && !event.shiftKey && event.key === 'c') {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
          return false
        }
        // If no selection, let Ctrl+C pass through for interrupt signal
        return true
      }
      return true
    })

    // Right-click context menu for copy/paste
    const containerEl = containerRef.current
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      const selection = terminal.getSelection()
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        hasSelection: !!selection
      })
    }
    containerEl.addEventListener('contextmenu', onContextMenu)

    // Handle terminal output
    const unsubscribeOutput = host.pty.onOutput((id, data) => {
      if (id === terminalId) {
        if (isClaudeCliTerminal) {
          terminal.write(data, scheduleFullRefresh)
        } else {
          terminal.write(data)
        }
        // Update activity time when there's output
        workspaceStore.updateTerminalActivity(terminalId)
      }
    })

    // Handle terminal exit
    const unsubscribeExit = host.pty.onExit((id, exitCode) => {
      if (id === terminalId) {
        terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`)
        if (settingsStore.getCloseTerminalAfterProcessExit()) {
          onClose?.(terminalId)
        }
      }
    })

    // Handle resize — debounce with 500ms to avoid expensive xterm reflows during window drag
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let resizeObserverCount = 0
    const resizeObserver = new ResizeObserver((entries) => {
      resizeObserverCount++
      const entry = entries[0]
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      dlog(`[render] ResizeObserver #${resizeObserverCount} terminal=${terminalId} active=${isActiveRef.current} ${w}x${h}`)
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        if (!isActiveRef.current) return
        dlog(`[render] ResizeObserver debounce → doResize terminal=${terminalId}`)
        const t0 = performance.now()
        doResize()
        const t1 = performance.now()
        terminal.refresh(0, terminal.rows - 1)
        const t2 = performance.now()
        dlog(`[render] doResize=${(t1-t0).toFixed(1)}ms refresh=${(t2-t1).toFixed(1)}ms terminal=${terminalId}`)
      }, 200)
    })
    resizeObserver.observe(containerRef.current)

    // Initial resize — only for active terminal, delayed to ensure DOM is ready
    if (isActiveRef.current) {
      setTimeout(() => {
        dlog(`[resize] initial doResize terminal=${terminalId}`)
        doResize()
      }, 100)
    }

    // Subscribe to settings changes for font and color updates
    const unsubscribeSettings = settingsStore.subscribe(() => {
      const newSettings = settingsStore.getSettings()
      const newColors = settingsStore.getTerminalColors()
      terminal.options.fontSize = newSettings.fontSize
      terminal.options.fontFamily = settingsStore.getFontFamilyString()
      terminal.options.theme = {
        ...terminal.options.theme,
        background: newColors.background,
        foreground: newColors.foreground,
        cursor: newColors.cursor,
        cursorAccent: newColors.background
      }
      if (isActiveRef.current) {
        dlog(`[resize] settings changed → doResize terminal=${terminalId}`)
        doResize()
      }
    })

    return () => {
      unsubscribeOutput()
      unsubscribeExit()
      unsubscribeSettings()
      if (resizeTimer) clearTimeout(resizeTimer)
      if (readySizeRaf !== null) cancelAnimationFrame(readySizeRaf)
      if (refreshRaf !== null) cancelAnimationFrame(refreshRaf)
      resizeObserver.disconnect()
      observer.disconnect()
      if (xtermTextarea) {
        xtermTextarea.removeEventListener('compositionstart', onCompositionStart)
        xtermTextarea.removeEventListener('compositionend', onCompositionEnd)
      }
      ptyInput.dispose()
      if (ptyInputRef.current === ptyInput) {
        ptyInputRef.current = null
      }
      containerEl.removeEventListener('contextmenu', onContextMenu)
      doResizeRef.current = null
      terminal.dispose()
    }
  }, [terminalId])

  const handleViewportModeToggle = async () => {
    if (!ptyReadyRef.current) return
    const current = viewportStateRef.current
    try {
      if (current.mode === 'mobile') {
        const next = await host.pty.setViewportMode(terminalId, 'desktop', { source: 'desktop' })
        setViewportState(next)
        requestAnimationFrame(() => doResizeRef.current?.())
        return
      }

      const next = await host.pty.setViewportMode(terminalId, 'mobile', {
        cols: MOBILE_TERMINAL_COLS,
        rows: MOBILE_TERMINAL_ROWS,
        source: 'desktop',
      })
      setViewportState(next)
      const terminal = terminalRef.current
      if (terminal) {
        terminal.resize(next.cols || MOBILE_TERMINAL_COLS, next.rows || MOBILE_TERMINAL_ROWS)
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      void host.debug.log(`[TerminalPanel] viewport mode switch failed terminal=${terminalId}: ${message}`)
    }
  }

  const isMobileLayout = viewportState.mode === 'mobile'
  const mobilePanelStyle: CSSProperties | undefined = isMobileLayout
    ? { width: `min(calc(${viewportState.cols || MOBILE_TERMINAL_COLS}ch + 24px), 100%)` }
    : undefined

  return (
    <div className={`terminal-panel-shell ${isMobileLayout ? 'mobile-layout' : 'desktop-layout'}`}>
      <div className="terminal-viewport-bar">
        <span className={`terminal-viewport-badge ${isMobileLayout ? 'mobile' : 'desktop'}`}>
          {isMobileLayout ? t('terminal.mobileLayout') : t('terminal.desktopLayout')}
        </span>
        <button
          type="button"
          className="terminal-viewport-action"
          onClick={handleViewportModeToggle}
          disabled={!ptyReady}
        >
          {isMobileLayout ? t('terminal.useDesktopLayout') : t('terminal.useMobileLayout')}
        </button>
      </div>
      <div className="terminal-panel-stage">
        <div ref={containerRef} className="terminal-panel" style={mobilePanelStyle}>
          {contextMenu && (
            <div
              className="context-menu"
              style={{
                position: 'fixed',
                left: contextMenu.x,
                top: contextMenu.y,
                zIndex: 1000
              }}
            >
              {contextMenu.hasSelection && (
                <button onClick={handleCopy} className="context-menu-item">
                  複製
                </button>
              )}
              <button onClick={handlePaste} className="context-menu-item">
                貼上
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
