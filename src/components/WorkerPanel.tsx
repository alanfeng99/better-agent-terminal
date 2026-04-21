import { useEffect, useRef, useState, memo, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { settingsStore } from '../stores/settings-store'
import { parseProcfile } from '../utils/procfile-parser'
import '@xterm/xterm/css/xterm.css'

const dlog = (...args: unknown[]) => window.electronAPI?.debug?.log(...args)

const WORKER_COLORS = [
  '#61afef', '#98c379', '#e5c07b', '#c678dd',
  '#e06c75', '#56b6c2', '#d19a66', '#be5046',
]

type ProcessStatus = 'starting' | 'running' | 'stopped' | 'crashed'

interface WorkerProcess {
  name: string
  command: string
  ptyId: string
  color: string
  status: ProcessStatus
  exitCode?: number
  autoStart: boolean
}

// Persist auto-start preferences per Procfile
function loadAutoStartPrefs(procfilePath: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(`worker-autostart:${procfilePath}`)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function saveAutoStartPrefs(procfilePath: string, prefs: Record<string, boolean>): void {
  try {
    localStorage.setItem(`worker-autostart:${procfilePath}`, JSON.stringify(prefs))
  } catch { /* ignore */ }
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255]
}

function ansiColor(hex: string, text: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`
}

// Build the line written to the PTY to launch a Procfile command so that the
// PTY exits with the command's status. The wrapper differs per shell because
// `exec` is a POSIX shell builtin and PowerShell has no direct equivalent.
function buildLaunchCommand(shell: string | undefined, command: string): string {
  const isPowerShell = !!shell && /pwsh|powershell/i.test(shell)
  if (isPowerShell) {
    // PowerShell: run inline, then exit with the child's status code so the
    // pty onExit handler reports the real result.
    return `${command}; exit $LASTEXITCODE\r`
  }
  // POSIX shells: exec replaces the parent shell with the command.
  const escaped = command.replace(/'/g, "'\\''")
  return `exec bash -c '${escaped}'\r`
}

function getProcfileWorkingDirectory(procfilePath: string, fallbackCwd: string): string {
  const normalized = procfilePath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash <= 0) return fallbackCwd
  return procfilePath.slice(0, lastSlash)
}

interface WorkerPanelProps {
  terminalId: string
  procfilePath: string
  cwd: string
  isActive: boolean
}

export const WorkerPanel = memo(function WorkerPanel({ terminalId, procfilePath, cwd, isActive }: WorkerPanelProps) {
  const processCwd = getProcfileWorkingDirectory(procfilePath, cwd)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const doResizeRef = useRef<(() => void) | null>(null)
  const isActiveRef = useRef(isActive)
  const midLineRef = useRef<Map<string, boolean>>(new Map())
  const processesRef = useRef<WorkerProcess[]>([])
  const shellRef = useRef<string | undefined>()
  const logVisibleRef = useRef<Map<string, boolean>>(new Map())
  const pendingBatchRef = useRef<Array<{ name: string; color: string; data: string }>>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const spotlightRef = useRef<string | null>(null)

  const [processes, setProcesses] = useState<WorkerProcess[]>([])
  const [logVisible, setLogVisible] = useState<Record<string, boolean>>({})
  const [spotlightService, setSpotlightService] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { processesRef.current = processes }, [processes])
  useEffect(() => {
    const map = new Map<string, boolean>()
    for (const [k, v] of Object.entries(logVisible)) map.set(k, v)
    logVisibleRef.current = map
  }, [logVisible])

  // Flush pending batch to disk
  const flushToDisk = useCallback(async () => {
    const batch = pendingBatchRef.current
    if (batch.length === 0) return
    pendingBatchRef.current = []
    const lines = batch.map(e => JSON.stringify(e)).join('\n') + '\n'
    await window.electronAPI.workerBuffer.append(terminalId, lines)
  }, [terminalId])

  // Schedule a flush (debounced 500ms)
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      flushToDisk()
    }, 500)
  }, [flushToDisk])

  // Re-render terminal from entries with only visible processes
  const reRenderTerminal = useCallback((entries: Array<{ name: string; color: string; data: string }>, visibleMap: Map<string, boolean>) => {
    const terminal = terminalRef.current
    if (!terminal) return

    terminal.clear()
    terminal.write('\x1b[2J\x1b[H') // full clear + cursor home
    midLineRef.current = new Map()

    for (const entry of entries) {
      // __header__ entries are always shown and already formatted
      if (entry.name === '__header__') {
        terminal.write(entry.data)
        continue
      }

      if (visibleMap.get(entry.name) === false) continue

      const maxLen = Math.max(...processesRef.current.map(p => p.name.length))
      const paddedName = entry.name.padEnd(maxLen)
      const prefix = ansiColor(entry.color, paddedName) + '\x1b[90m | \x1b[0m'

      const atLineStart = !midLineRef.current.get(entry.name)
      let output = entry.data.replace(/\n/g, '\n' + prefix)
      if (atLineStart) output = prefix + output

      if (entry.data.endsWith('\n')) {
        output = output.slice(0, -prefix.length)
        midLineRef.current.set(entry.name, false)
      } else {
        midLineRef.current.set(entry.name, true)
      }

      terminal.write(output)
    }
  }, [])

  const toggleLogVisible = useCallback(async (name: string) => {
    // Compute next visibility state from current ref
    const next: Record<string, boolean> = Object.fromEntries(logVisibleRef.current)
    next[name] = next[name] === false ? true : false
    const map = new Map<string, boolean>(Object.entries(next))
    logVisibleRef.current = map
    setLogVisible(next)

    // Flush pending batch, then read full buffer from disk
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    await flushToDisk()

    const raw = await window.electronAPI.workerBuffer.readAll(terminalId)
    const entries: Array<{ name: string; color: string; data: string }> = raw
      ? raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : []

    reRenderTerminal(entries, map)
  }, [flushToDisk, terminalId, reRenderTerminal])

  const toggleSpotlight = useCallback(async (name: string) => {
    const next = spotlightRef.current === name ? null : name
    spotlightRef.current = next
    setSpotlightService(next)

    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    await flushToDisk()

    const raw = await window.electronAPI.workerBuffer.readAll(terminalId)
    const entries: Array<{ name: string; color: string; data: string }> = raw
      ? raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : []

    // Build visibility map: spotlight overrides individual toggles
    const map = new Map<string, boolean>(logVisibleRef.current)
    if (next !== null) {
      for (const proc of processesRef.current) map.set(proc.name, proc.name === next)
    }
    reRenderTerminal(entries, map)
  }, [flushToDisk, terminalId, reRenderTerminal])

  const toggleAutoStart = useCallback((name: string) => {
    setProcesses(prev => {
      const updated = prev.map(p =>
        p.name === name ? { ...p, autoStart: !p.autoStart } : p
      )
      // Persist
      const prefs: Record<string, boolean> = {}
      for (const p of updated) prefs[p.name] = p.autoStart
      saveAutoStartPrefs(procfilePath, prefs)
      return updated
    })
  }, [procfilePath])

  // Write prefixed output to combined terminal
  const writeOutput = useCallback((name: string, color: string, data: string) => {
    const terminal = terminalRef.current
    if (!terminal) return

    // Queue for disk flush
    pendingBatchRef.current.push({ name, color, data })
    scheduleFlush()

    // __header__ entries are pre-formatted, write directly
    if (name === '__header__') {
      terminal.write(data)
      return
    }

    // Skip rendering for hidden/non-spotlighted processes
    if (spotlightRef.current !== null) {
      if (name !== spotlightRef.current) return
    } else if (logVisibleRef.current.get(name) === false) return

    const maxLen = Math.max(...processesRef.current.map(p => p.name.length))
    const paddedName = name.padEnd(maxLen)
    const prefix = ansiColor(color, paddedName) + '\x1b[90m | \x1b[0m'

    const atLineStart = !midLineRef.current.get(name)
    let output = data.replace(/\n/g, '\n' + prefix)
    if (atLineStart) output = prefix + output

    if (data.endsWith('\n')) {
      output = output.slice(0, -prefix.length)
      midLineRef.current.set(name, false)
    } else {
      midLineRef.current.set(name, true)
    }

    terminal.write(output)
  }, [scheduleFlush])

  // Start a single process PTY
  const startProcess = useCallback(async (proc: WorkerProcess) => {
    dlog(`[worker] starting process: ${proc.name} (${proc.ptyId})`)

    setProcesses(prev => prev.map(p =>
      p.ptyId === proc.ptyId ? { ...p, status: 'starting' as const, exitCode: undefined } : p
    ))

    await window.electronAPI.pty.create({
      id: proc.ptyId,
      cwd: processCwd,
      type: 'terminal',
      shell: shellRef.current,
    })

    // Use exec to replace the shell — pty exits when command exits
    const launch = buildLaunchCommand(shellRef.current, proc.command)
    setTimeout(() => {
      window.electronAPI.pty.write(proc.ptyId, launch)
      setProcesses(prev => prev.map(p =>
        p.ptyId === proc.ptyId && p.status === 'starting' ? { ...p, status: 'running' as const } : p
      ))
    }, 300)
  }, [processCwd])

  // Re-read Procfile and sync process list (add new, remove deleted, update commands)
  const reloadProcfile = useCallback(async () => {
    const result = await window.electronAPI.fs.readFile(procfilePath)
    if (result.error || !result.content) return
    const entries = parseProcfile(result.content)
    if (entries.length === 0) return

    const autoStartPrefs = loadAutoStartPrefs(procfilePath)
    const current = processesRef.current
    const currentByName = new Map(current.map(p => [p.name, p]))
    const newNames = new Set(entries.map(e => e.name))

    // Stop and remove processes that no longer exist in Procfile
    for (const proc of current) {
      if (!newNames.has(proc.name)) {
        if (proc.status === 'running' || proc.status === 'starting') {
          window.electronAPI.pty.kill(proc.ptyId)
        }
        writeOutput(proc.name, proc.color, `\n\x1b[90mRemoved from Procfile\x1b[0m\n`)
      }
    }

    // Build updated process list
    const updated: WorkerProcess[] = entries.map((entry, i) => {
      const existing = currentByName.get(entry.name)
      if (existing) {
        // Keep existing process state, but update command if changed
        if (existing.command !== entry.command) {
          writeOutput(existing.name, existing.color, `\n\x1b[33mCommand updated: ${entry.command}\x1b[0m\n`)
        }
        return { ...existing, command: entry.command, color: WORKER_COLORS[i % WORKER_COLORS.length] }
      }
      // New process
      const proc: WorkerProcess = {
        name: entry.name,
        command: entry.command,
        ptyId: `${terminalId}__w__${entry.name}`,
        color: WORKER_COLORS[i % WORKER_COLORS.length],
        autoStart: autoStartPrefs[entry.name] !== false,
        status: 'stopped' as ProcessStatus,
      }
      writeOutput(proc.name, proc.color, `\n\x1b[32mAdded from Procfile\x1b[0m\n`)
      return proc
    })

    processesRef.current = updated
    setProcesses(updated)
    return updated
  }, [procfilePath, terminalId, writeOutput])

  // Stop a single process (reload Procfile to sync list)
  const stopProcess = useCallback(async (proc: WorkerProcess) => {
    await reloadProcfile()
    const fresh = processesRef.current.find(p => p.name === proc.name)
    if (!fresh) return
    dlog(`[worker] stopping process: ${fresh.name}`)
    window.electronAPI.pty.kill(fresh.ptyId)
  }, [reloadProcfile])

  // Restart a single process (reload Procfile first to pick up command changes)
  const restartProcess = useCallback(async (proc: WorkerProcess) => {
    const updated = await reloadProcfile()
    const fresh = (updated || processesRef.current).find(p => p.name === proc.name)
    if (!fresh) return // process was removed from Procfile

    dlog(`[worker] restarting process: ${fresh.name}`)
    await window.electronAPI.pty.kill(fresh.ptyId)

    midLineRef.current.set(fresh.name, false)
    writeOutput(fresh.name, fresh.color, `\n\x1b[33mRestarting...\x1b[0m\n`)
    await startProcess(fresh)
  }, [startProcess, writeOutput, reloadProcfile])

  // Batch operations (reload Procfile once, then act on fresh list)
  const startAll = useCallback(async () => {
    await reloadProcfile()
    for (const p of processesRef.current) {
      if (p.status === 'stopped' || p.status === 'crashed') startProcess(p)
    }
  }, [startProcess, reloadProcfile])

  const stopAll = useCallback(async () => {
    await reloadProcfile()
    for (const p of processesRef.current) {
      if (p.status === 'running' || p.status === 'starting') {
        dlog(`[worker] stopping process: ${p.name}`)
        window.electronAPI.pty.kill(p.ptyId)
      }
    }
  }, [reloadProcfile])

  const restartAll = useCallback(async () => {
    const updated = await reloadProcfile()
    const procs = updated || processesRef.current
    for (const p of procs) {
      dlog(`[worker] restarting process: ${p.name}`)
      if (p.status === 'running' || p.status === 'starting') {
        await window.electronAPI.pty.kill(p.ptyId)
      }
      midLineRef.current.set(p.name, false)
      writeOutput(p.name, p.color, `\n\x1b[33mRestarting...\x1b[0m\n`)
      await startProcess(p)
    }
  }, [reloadProcfile, startProcess, writeOutput])

  // Main init effect: create xterm, parse Procfile, start processes
  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false
    const ptyIds: string[] = []

    // --- Create combined xterm.js (synchronous) ---
    const settings = settingsStore.getSettings()
    const colors = settingsStore.getTerminalColors()

    const terminal = new Terminal({
      theme: {
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.cursor,
        cursorAccent: colors.background,
        selectionBackground: '#5c5142',
        black: '#3b3228', red: '#cb6077', green: '#beb55b', yellow: '#f4bc87',
        blue: '#8ab3b5', magenta: '#a89bb9', cyan: '#7bbda4', white: '#d0c8c6',
        brightBlack: '#554d46', brightRed: '#cb6077', brightGreen: '#beb55b', brightYellow: '#f4bc87',
        brightBlue: '#8ab3b5', brightMagenta: '#a89bb9', brightCyan: '#7bbda4', brightWhite: '#f5f1e6',
      },
      fontSize: settings.fontSize,
      fontFamily: settingsStore.getFontFamilyString(),
      cursorBlink: false,
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
      allowTransparency: true,
      scrollOnOutput: true,
      disableStdin: true,
    })

    const fitAddon = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    const webLinksAddon = new WebLinksAddon((_, uri) => {
      window.electronAPI.shell.openExternal(uri)
    })
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(unicode11Addon)
    terminal.unicode.activeVersion = '11'
    terminal.open(containerRef.current)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Resize helper
    let lastCols = 0, lastRows = 0
    const doResize = () => {
      fitAddon.fit()
      const { cols, rows } = terminal
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols
        lastRows = rows
        for (const id of ptyIds) {
          window.electronAPI.pty.resize(id, cols, rows)
        }
      }
    }
    doResizeRef.current = doResize

    // ResizeObserver
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        if (isActiveRef.current) doResize()
      }, 200)
    })
    resizeObserver.observe(containerRef.current)
    setTimeout(() => doResize(), 100)

    // Event listeners
    const unsubOutput = window.electronAPI.pty.onOutput((id, data) => {
      const proc = processesRef.current.find(p => p.ptyId === id)
      if (proc) writeOutput(proc.name, proc.color, data)
    })

    const unsubExit = window.electronAPI.pty.onExit((id, exitCode) => {
      const proc = processesRef.current.find(p => p.ptyId === id)
      if (!proc) return
      midLineRef.current.set(proc.name, false)
      const colorCode = exitCode === 0 ? '32' : '31'
      const exitMsg = `\x1b[${colorCode}mProcess exited with code ${exitCode}\x1b[0m`
      // Buffer as a special entry (uses \n so prefix logic applies)
      writeOutput(proc.name, proc.color, `\n${exitMsg}\n`)
      setProcesses(prev => prev.map(p =>
        p.ptyId === id ? { ...p, status: (exitCode === 0 ? 'stopped' : 'crashed') as ProcessStatus, exitCode } : p
      ))
    })

    const unsubSettings = settingsStore.subscribe(() => {
      const s = settingsStore.getSettings()
      const c = settingsStore.getTerminalColors()
      terminal.options.fontSize = s.fontSize
      terminal.options.fontFamily = settingsStore.getFontFamilyString()
      terminal.options.theme = {
        ...terminal.options.theme,
        background: c.background,
        foreground: c.foreground,
        cursor: c.cursor,
      }
      if (isActiveRef.current) doResize()
    })

    // --- Async: read Procfile and start processes ---
    ;(async () => {
      // Init worker buffer file on disk
      await window.electronAPI.workerBuffer.init(terminalId)

      // Resolve shell path
      if (settings.shell === 'custom' && settings.customShellPath) {
        shellRef.current = settings.customShellPath
      } else {
        shellRef.current = await window.electronAPI.settings.getShellPath(settings.shell)
      }

      // Read Procfile
      const result = await window.electronAPI.fs.readFile(procfilePath)
      if (disposed) return
      if (result.error || !result.content) {
        setError(result.error || 'Empty Procfile')
        return
      }

      const entries = parseProcfile(result.content)
      if (entries.length === 0) {
        setError('No valid entries found in Procfile')
        return
      }

      // Build process list with saved autoStart preferences
      const autoStartPrefs = loadAutoStartPrefs(procfilePath)
      const procs: WorkerProcess[] = entries.map((entry, i) => ({
        name: entry.name,
        command: entry.command,
        ptyId: `${terminalId}__w__${entry.name}`,
        color: WORKER_COLORS[i % WORKER_COLORS.length],
        autoStart: autoStartPrefs[entry.name] !== false, // default true
        status: (autoStartPrefs[entry.name] !== false ? 'starting' : 'stopped') as ProcessStatus,
      }))
      ptyIds.push(...procs.map(p => p.ptyId))
      processesRef.current = procs
      setProcesses(procs)

      // Write header (use __header__ as a virtual name so it's always visible during re-render)
      const filename = procfilePath.split('/').pop() || 'Procfile'
      const headerText = ansiColor('#888', `Worker: ${filename} (${procs.length} processes)\r\n`) +
        ansiColor('#555', '\u2500'.repeat(60) + '\r\n')
      writeOutput('__header__', '', headerText)

      // Start only processes with autoStart enabled
      for (const proc of procs) {
        if (disposed) break
        if (!proc.autoStart) continue
        await window.electronAPI.pty.create({
          id: proc.ptyId,
          cwd,
          type: 'terminal',
          shell: shellRef.current,
        })
        window.electronAPI.pty.write(proc.ptyId, buildLaunchCommand(shellRef.current, proc.command))
      }

      // Mark started processes as running
      if (!disposed) {
        setProcesses(prev => prev.map(p =>
          p.status === 'starting' ? { ...p, status: 'running' as const } : p
        ))
      }
    })()

    return () => {
      disposed = true
      unsubOutput()
      unsubExit()
      unsubSettings()
      if (resizeTimer) clearTimeout(resizeTimer)
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      resizeObserver.disconnect()
      doResizeRef.current = null
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      window.electronAPI.workerBuffer.clear(terminalId)
      for (const id of ptyIds) {
        window.electronAPI.pty.kill(id)
      }
    }
  }, [terminalId, procfilePath, cwd, writeOutput])

  // Handle resize/refresh when becoming active
  useEffect(() => {
    if (isActive && terminalRef.current) {
      requestAnimationFrame(() => {
        doResizeRef.current?.()
        requestAnimationFrame(() => {
          terminalRef.current?.clearTextureAtlas()
          terminalRef.current?.refresh(0, (terminalRef.current?.rows ?? 1) - 1)
        })
      })
    }
  }, [isActive])

  if (error) {
    return (
      <div className="worker-panel">
        <div className="worker-error">
          <div className="worker-error-title">Failed to load Procfile</div>
          <div className="worker-error-detail">{error}</div>
          <div className="worker-error-path">{procfilePath}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="worker-panel">
      {processes.length > 0 && (
        <div className="worker-process-bar">
          {processes.map(proc => {
            const isVisible = logVisible[proc.name] !== false
            return (
              <div
                key={proc.ptyId}
                className={`worker-process-card${spotlightService !== null && spotlightService !== proc.name ? ' worker-card-dimmed' : ''}${spotlightService === proc.name ? ' worker-card-spotlight' : ''}`}
              >
                <span className={`worker-status-dot worker-status-${proc.status}`} />
                <span
                  className="worker-process-name"
                  style={{ color: proc.color, cursor: 'pointer' }}
                  onClick={() => toggleSpotlight(proc.name)}
                  title={spotlightService === proc.name ? 'Exit spotlight' : 'Spotlight: show only this service'}
                >
                  {proc.name}
                </span>
                <div className="worker-process-actions">
                  <button
                    className={`worker-btn worker-btn-log ${isVisible ? 'active' : ''}`}
                    onClick={() => toggleLogVisible(proc.name)}
                    title={isVisible ? 'Hide log' : 'Show log'}
                  >
                    {isVisible ? '◉' : '○'}
                  </button>
                  <button
                    className={`worker-btn worker-btn-auto ${proc.autoStart ? 'active' : ''}`}
                    onClick={() => toggleAutoStart(proc.name)}
                    title={proc.autoStart ? 'Auto-start ON (click to disable)' : 'Auto-start OFF (click to enable)'}
                  >
                    {proc.autoStart ? '⚡' : '💤'}
                  </button>
                  {(proc.status === 'stopped' || proc.status === 'crashed') && (
                    <button className="worker-btn" onClick={async () => {
                      await reloadProcfile()
                      const fresh = processesRef.current.find(p => p.name === proc.name)
                      if (fresh) startProcess(fresh)
                    }} title="Start">
                      ▶
                    </button>
                  )}
                  {(proc.status === 'running' || proc.status === 'starting') && (
                    <button className="worker-btn" onClick={() => stopProcess(proc)} title="Stop">
                      ■
                    </button>
                  )}
                  <button className="worker-btn" onClick={() => restartProcess(proc)} title="Restart">
                    ⟳
                  </button>
                </div>
              </div>
            )
          })}
          <div className="worker-global-actions">
            <button className="worker-btn" onClick={startAll} title="Start All">▶ All</button>
            <button className="worker-btn" onClick={stopAll} title="Stop All">■ All</button>
            <button className="worker-btn" onClick={restartAll} title="Restart All">⟳ All</button>
            <button className="worker-btn" onClick={() => reloadProcfile()} title="Reload Procfile">⟲ Procfile</button>
          </div>
        </div>
      )}
      <div ref={containerRef} className="worker-terminal" />
    </div>
  )
})
