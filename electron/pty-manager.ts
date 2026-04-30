import type { BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import type { CreatePtyOptions } from '../src/types'
import { broadcastHub } from './remote/broadcast-hub'
import { logger } from './logger'
import { getDataDir } from './server-core/data-dir'

// Per-terminal shell history directory — resolved lazily so getDataDir() runs
// after the app initializes its data directory.
function getHistoryDir(): string {
  return path.join(getDataDir(), 'terminal-history')
}
function getZshWrapperDir(): string {
  return path.join(getHistoryDir(), '.zsh-wrapper')
}

// Create zsh wrapper rc files that source user's originals then override HISTFILE.
// Uses env vars $_BAT_ZDOTDIR (original ZDOTDIR) and $_BAT_HISTFILE (target history file).
let zshWrapperReady = false
function ensureZshWrapper() {
  if (zshWrapperReady) return
  try {
    const wrapperDir = getZshWrapperDir()
    fs.mkdirSync(wrapperDir, { recursive: true })
    const src = (file: string) => `[ -f "\${_BAT_ZDOTDIR:-$HOME}/${file}" ] && source "\${_BAT_ZDOTDIR:-$HOME}/${file}"\n`
    fs.writeFileSync(path.join(wrapperDir, '.zshenv'), src('.zshenv'))
    fs.writeFileSync(path.join(wrapperDir, '.zprofile'), src('.zprofile'))
    fs.writeFileSync(path.join(wrapperDir, '.zshrc'), [
      src('.zshrc').trimEnd(),
      'export HISTFILE="$_BAT_HISTFILE"',
      'setopt INC_APPEND_HISTORY',
      'ZDOTDIR="${_BAT_ZDOTDIR:-$HOME}"',
      ''
    ].join('\n'))
    fs.writeFileSync(path.join(wrapperDir, '.zlogin'), src('.zlogin'))
    zshWrapperReady = true
    logger.log('[pty] zsh wrapper files created at', wrapperDir)
  } catch (e) {
    logger.warn('[pty] Failed to create zsh wrapper:', e)
  }
}

// Try to import @lydell/node-pty, fall back to child_process if not available
let pty: typeof import('@lydell/node-pty') | null = null
let ptyAvailable = false
try {
  pty = require('@lydell/node-pty')
  // Test if native module works by checking if spawn function exists and module is properly built
  if (pty && typeof pty.spawn === 'function') {
    ptyAvailable = true
    logger.log('node-pty loaded successfully (using @lydell/node-pty)')
  } else {
    logger.warn('node-pty loaded but spawn function not available')
  }
} catch (e) {
  logger.warn('@lydell/node-pty not available, falling back to child_process:', e)
}

interface PtyInstance {
  process: any // IPty or ChildProcess
  type: 'terminal'  // Unified to 'terminal' - agent types handled by agentPreset
  cwd: string
  usePty: boolean
}

export class PtyManager {
  private instances: Map<string, PtyInstance> = new Map()
  private getWindows: () => BrowserWindow[]

  // Per-instance output coalescing: first chunk flushes immediately for
  // interactive responsiveness; subsequent chunks within OUTPUT_FLUSH_MS are
  // batched into a single broadcast to reduce IPC traffic under heavy output.
  private outputBuffers: Map<string, { chunks: string[]; timer: NodeJS.Timeout | null }> = new Map()
  private readonly OUTPUT_FLUSH_MS = 8

  constructor(getWindows: () => BrowserWindow[]) {
    this.getWindows = getWindows
  }

  private broadcast(channel: string, ...args: unknown[]) {
    for (const win of this.getWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(channel, ...args)
        } catch {
          // Render frame may be disposed during window reload/close
        }
      }
    }
    broadcastHub.broadcast(channel, ...args)
  }

  private emitOutput(id: string, data: string): void {
    const state = this.outputBuffers.get(id)
    if (!state) {
      // No active coalescing window: send immediately, open window for follow-ups
      this.broadcast('pty:output', id, data)
      const timer = setTimeout(() => this.flushOutput(id), this.OUTPUT_FLUSH_MS)
      this.outputBuffers.set(id, { chunks: [], timer })
      return
    }
    state.chunks.push(data)
  }

  private flushOutput(id: string): void {
    const state = this.outputBuffers.get(id)
    if (!state) return
    if (state.chunks.length > 0) {
      const combined = state.chunks.join('')
      state.chunks = []
      this.broadcast('pty:output', id, combined)
      state.timer = setTimeout(() => this.flushOutput(id), this.OUTPUT_FLUSH_MS)
    } else {
      if (state.timer) clearTimeout(state.timer)
      this.outputBuffers.delete(id)
    }
  }

  private clearOutputBuffer(id: string): void {
    const state = this.outputBuffers.get(id)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    if (state.chunks.length > 0) {
      this.broadcast('pty:output', id, state.chunks.join(''))
    }
    this.outputBuffers.delete(id)
  }

  private killProcessTree(pid: number): void {
    if (process.platform === 'win32') {
      try {
        const { execFileSync } = require('child_process')
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000 })
      } catch { /* process may already be gone */ }
      return
    }

    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try { process.kill(pid, 'SIGTERM') } catch { /* process may already be gone */ }
    }
  }

  private forceKillProcessTree(pid: number): void {
    if (process.platform === 'win32') {
      this.killProcessTree(pid)
      return
    }

    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* process may already be gone */ }
    }
  }

  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      // Prefer PowerShell 7 (pwsh) over Windows PowerShell
      const fs = require('fs')
      const pwshPaths = [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
        process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\pwsh.exe'
      ]
      for (const p of pwshPaths) {
        if (fs.existsSync(p)) {
          return p
        }
      }
      return 'powershell.exe'
    } else if (process.platform === 'darwin') {
      if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
        return process.env.SHELL
      }
      return '/bin/zsh'
    } else {
      // Linux - detect available shell
      const fs = require('fs')
      if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
        return process.env.SHELL
      } else if (fs.existsSync('/bin/bash')) {
        return '/bin/bash'
      } else {
        return '/bin/sh'
      }
    }
  }

  create(options: CreatePtyOptions): boolean {
    const { id, cwd, type, shell: shellOverride, customEnv = {}, perTerminalHistory, historyKey } = options
    if (this.instances.has(id)) {
      this.kill(id)
    }

    const shell = shellOverride || this.getDefaultShell()
    let args: string[] = []

    // Per-terminal HISTFILE: isolate shell history from system ~/.zsh_history
    // Uses cwd-based key so history persists across tab close/reopen in the same project.
    let histEnv: Record<string, string> = {}
    if (perTerminalHistory) {
      try {
        const histDir = getHistoryDir()
        fs.mkdirSync(histDir, { recursive: true })
        const key = historyKey || crypto.createHash('md5').update(id).digest('hex').slice(0, 12)
        const histFile = path.join(histDir, `${key}_history`)

        if (shell.includes('zsh')) {
          ensureZshWrapper()
          histEnv = {
            ZDOTDIR: getZshWrapperDir(),
            _BAT_ZDOTDIR: process.env.ZDOTDIR || process.env.HOME || '',
            _BAT_HISTFILE: histFile,
            HISTFILE: histFile,
          }
          logger.log(`[pty] Per-terminal history (zsh wrapper): ${histFile}`)
        } else {
          histEnv = { HISTFILE: histFile }
          logger.log(`[pty] Per-terminal history: ${histFile}`)
        }
      } catch (e) {
        logger.warn('[pty] Failed to setup history:', e)
      }
    }

    // For PowerShell (pwsh or powershell), bypass execution policy to allow unsigned scripts
    if (shell.includes('powershell') || shell.includes('pwsh')) {
      args = ['-ExecutionPolicy', 'Bypass', '-NoLogo']
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      // Use login interactive shell to source profile files (.zshrc, .bashrc, .profile, etc.)
      // This ensures PATH and other environment variables are properly set
      // -l = login shell, -i = interactive shell
      args = ['-l', '-i']
    }

    // Try node-pty first, fallback to child_process if it fails
    let usedPty = false

    if (ptyAvailable && pty) {
      try {
        // Set UTF-8 and terminal environment variables, merge custom env
        const envWithUtf8 = {
          ...process.env,
          ...customEnv,  // Merge custom environment variables
          ...histEnv,    // Per-terminal HISTFILE (if enabled)
          // UTF-8 encoding
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          // Terminal capabilities - let apps know we are a real PTY
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'better-terminal',
          TERM_PROGRAM_VERSION: '1.0',
          // Force color output
          FORCE_COLOR: '3',
          // Ensure not detected as CI environment
          CI: ''
        }

        const ptyProcess = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd,
          env: envWithUtf8 as { [key: string]: string }
        })

        ptyProcess.onData((data: string) => {
          // Only emit if this instance is still the current one
          // (a restart may have already replaced it with a new instance)
          if (this.instances.get(id)?.process === ptyProcess) {
            this.emitOutput(id, data)
          }
        })

        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          this.clearOutputBuffer(id)
          this.broadcast('pty:exit', id, exitCode)
          // Only clean up if this instance is still the current one
          // (a restart may have already replaced it with a new instance)
          if (this.instances.get(id)?.process === ptyProcess) {
            this.instances.delete(id)
          }
        })

        this.instances.set(id, { process: ptyProcess, type, cwd, usePty: true })
        usedPty = true
        logger.log('Created terminal using node-pty')
      } catch (e) {
        logger.warn('node-pty spawn failed, falling back to child_process:', e)
        ptyAvailable = false // Don't try again
      }
    }

    if (!usedPty) {
      try {
        // Fallback to child_process with proper stdio
        // For PowerShell, add -NoExit and UTF-8 command
        let shellArgs = [...args]
        if (shell.includes('powershell') || shell.includes('pwsh')) {
          shellArgs.push(
            '-NoExit',
            '-Command',
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8'
          )
        }

        // Set UTF-8 and terminal environment variables, merge custom env (child_process fallback)
        const envWithUtf8 = {
          ...process.env,
          ...customEnv,  // Merge custom environment variables
          ...histEnv,    // Per-terminal HISTFILE (if enabled)
          // UTF-8 encoding
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          // Terminal capabilities (limited in child_process mode)
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'better-terminal',
          TERM_PROGRAM_VERSION: '1.0',
          FORCE_COLOR: '3',
          CI: ''
        }

        const childProcess = spawn(shell, shellArgs, {
          cwd,
          env: envWithUtf8 as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          detached: process.platform !== 'win32'
        })

        childProcess.stdout?.on('data', (data: Buffer) => {
          if (this.instances.get(id)?.process === childProcess) {
            this.emitOutput(id, data.toString())
          }
        })

        childProcess.stderr?.on('data', (data: Buffer) => {
          if (this.instances.get(id)?.process === childProcess) {
            this.emitOutput(id, data.toString())
          }
        })

        childProcess.on('exit', (exitCode: number | null) => {
          this.clearOutputBuffer(id)
          this.broadcast('pty:exit', id, exitCode ?? 0)
          if (this.instances.get(id)?.process === childProcess) {
            this.instances.delete(id)
          }
        })

        childProcess.on('error', (error) => {
          logger.error('Child process error:', error)
          this.emitOutput(id, `\r\n[Error: ${error.message}]\r\n`)
        })

        // Send initial message
        this.emitOutput(id, `[Terminal - child_process mode]\r\n`)

        this.instances.set(id, { process: childProcess, type, cwd, usePty: false })
        logger.log('Created terminal using child_process fallback')
      } catch (error) {
        logger.error('Failed to create terminal:', error)
        return false
      }
    }

    return true
  }

  write(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      if (instance.usePty) {
        instance.process.write(data)
      } else {
        // For the child_process fallback stdin is a pipe, not a real PTY.
        // xterm sends Enter as CR; shells reading from a pipe expect LF.
        // Normalize line endings so commands written programmatically by
        // WorkerPanel run the same way they do under node-pty.
        const cp = instance.process as ChildProcess
        cp.stdin?.write(data.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id)
    if (instance && instance.usePty) {
      instance.process.resize(cols, rows)
    }
  }

  kill(id: string): boolean {
    const instance = this.instances.get(id)
    if (instance) {
      const pid: number | undefined = instance.process.pid
      if (pid) {
        this.killProcessTree(pid)
        setTimeout(() => this.forceKillProcessTree(pid), 1500)
      } else {
        if (instance.usePty) {
          instance.process.kill()
        } else {
          (instance.process as ChildProcess).kill()
        }
      }
      this.clearOutputBuffer(id)
      this.instances.delete(id)
      return true
    }
    return false
  }

  restart(id: string, cwd: string, shell?: string): boolean {
    const instance = this.instances.get(id)
    if (instance) {
      const type = instance.type
      this.kill(id)
      return this.create({ id, cwd, type, shell })
    }
    return false
  }

  getCwd(id: string): string | null {
    const instance = this.instances.get(id)
    if (instance) {
      return instance.cwd
    }
    return null
  }

  dispose(): void {
    for (const id of [...this.instances.keys()]) {
      this.kill(id)
    }
  }
}
