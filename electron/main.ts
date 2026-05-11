import { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerMonitor, clipboard, nativeImage, safeStorage, Notification } from 'electron'
import path from 'path'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import { execFileSync } from 'child_process'
import { setDataDir } from './server-core/data-dir'
import { setSafeStorage } from './server-core/safe-storage'
import { setNotifier } from './server-core/notifier'
import { registerProxiedHandlers } from './server-core/register-handlers'
import { WindowRegistry } from './window-registry'
import { notificationCenter, type NotificationEntry } from './notification-center'

// Fix PATH for GUI-launched apps on macOS.
// When launched via .dmg / Applications, macOS gives a minimal PATH that
// doesn't include Homebrew (/opt/homebrew/bin), NVM, etc.
// We source the user's login shell to get the real PATH.
if (process.platform === 'darwin') {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    // fish stores PATH as a list; use string join to get colon-separated output
    const isFish = shell.endsWith('/fish') || shell === 'fish'
    const cmd = isFish ? 'string join : $PATH' : 'echo $PATH'
    const rawPath = execFileSync(shell, ['-l', '-c', cmd], {
      timeout: 3000,
      encoding: 'utf8',
    }).trim()
    if (rawPath) {
      process.env.PATH = rawPath
    }
  } catch {
    // Fallback: prepend the most common node locations
    const extraPaths = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      `${process.env.HOME}/.volta/bin`,
    ]
    // Resolve nvm: find the latest installed version's bin directory.
    // NOTE: This intentionally duplicates the semver sort from node-resolver.ts
    // because this code runs at the top level before any ES module imports,
    // and importing node-resolver here would break the PATH fix ordering.
    try {
      const nvmDir = `${process.env.HOME}/.nvm/versions/node`
      const versions = fsSync.readdirSync(nvmDir).filter((v: string) => v.startsWith('v'))
      if (versions.length > 0) {
        versions.sort((a: string, b: string) => {
          const pa = a.replace(/^v/, '').split('.').map(Number)
          const pb = b.replace(/^v/, '').split('.').map(Number)
          for (let i = 0; i < 3; i++) { const d = (pa[i]||0) - (pb[i]||0); if (d !== 0) return d; }
          return 0
        })
        extraPaths.push(`${nvmDir}/${versions[versions.length - 1]}/bin`)
      }
    } catch { /* nvm not installed */ }
    process.env.PATH = `${extraPaths.join(':')}:${process.env.PATH || ''}`
  }
}
import { PtyManager } from './pty-manager'
import { ClaudeAgentManager } from './claude-agent-manager'
import { CodexAgentManager } from './codex-agent-manager'
import { checkForUpdates, UpdateCheckResult } from './update-checker'
import { snippetDb } from './snippet-db'
import { ProfileManager, type ProfileSnapshot } from './profile-manager'
import { invokeHandler } from './remote/handler-registry'
import { PROXIED_CHANNELS } from './remote/protocol'
import { RemoteServer } from './remote/remote-server'
import { RemoteClient } from './remote/remote-client'
import { getConnectionInfo } from './remote/tunnel-manager'
import { logger } from './logger'
import { isSensitivePath } from './path-guard'

// Startup timing — capture module load time before anything else
const _processStart = Number(process.env._BAT_T0 || Date.now())
console.log(`[startup] main.ts module loaded: +${Date.now() - _processStart}ms from process start`)

// Global error handlers — prevent silent crashes in main process
process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
  // EPIPE errors are expected when writing to pipes of killed subprocesses (e.g. Claude agent)
  // They are harmless and should not pollute logs.
  if (error.code === 'EPIPE') return
  logger.error('Uncaught exception:', error)
})
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason)
})

// GPU disk cache: set dedicated path to avoid "Unable to move the cache" errors on Windows.
// These errors block GPU compositing and can add seconds to first paint.
app.commandLine.appendSwitch('gpu-disk-cache-dir', path.join(app.getPath('temp'), 'bat-gpu-cache'))
// Disable GPU shader disk cache (another source of "Unable to create cache" errors)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// Disable Service Workers — we don't use them, and a corrupted SW database
// causes Chromium to block the renderer for 4+ seconds on Windows during I/O recovery.
app.commandLine.appendSwitch('disable-features', 'ServiceWorker')

// Set app name (shown in dock/taskbar instead of "Electron" during dev)
app.setName('BetterAgentTerminal')

// --runtime=N or BAT_RUNTIME=N: allow multiple independent instances with separate data directories
// Each runtime gets its own user data path and single-instance lock
// CLI arg takes precedence over env var; env var works reliably in dev mode (vite-plugin-electron)
const runtimeArg = process.argv.find(a => a.startsWith('--runtime='))
const runtimeId = runtimeArg ? runtimeArg.split('=')[1] : (process.env.BAT_RUNTIME || undefined)
if (runtimeId) {
  const basePath = app.getPath('userData')
  const runtimePath = path.join(path.dirname(basePath), `${path.basename(basePath)}-runtime-${runtimeId}`)
  app.setPath('userData', runtimePath)
  console.log(`[runtime] BAT_RUNTIME=${runtimeId}, userData=${runtimePath}`)
} else {
  console.log(`[runtime] default instance, userData=${app.getPath('userData')}`)
}

// Wire server-core providers — must run before any consumer (handlers, managers)
// reads getDataDir() / getSafeStorage() / getNotifier(). Headless CLI provides
// its own implementations.
setDataDir(app.getPath('userData'))
setSafeStorage({
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (s) => safeStorage.encryptString(s),
  decryptString: (b) => safeStorage.decryptString(b),
})
setNotifier({
  isSupported: () => Notification.isSupported(),
  show: ({ title, body, silent, onClick }) => {
    const n = new Notification({ title, body, silent })
    if (onClick) n.on('click', onClick)
    n.show()
  },
})

// Set AppUserModelId for Windows taskbar pinning (must be before app.whenReady)
if (process.platform === 'win32') {
  const appModelId = runtimeId
    ? `org.tonyq.better-agent-terminal.runtime-${runtimeId}`
    : 'org.tonyq.better-agent-terminal'
  app.setAppUserModelId(appModelId)

  // Fix Start Menu shortcut AppUserModelId for Windows notifications (issue #77).
  // NSIS installer may not embed the AppUserModelId into the .lnk, causing Windows
  // to silently drop all toast notifications. Patch it at startup if needed.
  if (!runtimeId) {
    try {
      const shortcutPath = path.join(
        app.getPath('appData'),
        'Microsoft', 'Windows', 'Start Menu', 'Programs', 'BetterAgentTerminal.lnk'
      )
      if (fsSync.existsSync(shortcutPath)) {
        const shortcut = shell.readShortcutLink(shortcutPath)
        if (shortcut.appUserModelId !== appModelId) {
          shell.writeShortcutLink(shortcutPath, 'update', { appUserModelId: appModelId })
        }
      }
    } catch { /* non-critical — notification may not work but app still runs */ }
  }
}

// Single instance lock — if a second instance is launched, focus existing and open new window
// Each --runtime=N has its own lock (via separate userData path)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // Another instance with the same runtime is already running
  app.quit()
}

const windowMap = new Map<string, BrowserWindow>() // windowId → BrowserWindow
let ptyManager: PtyManager | null = null
let claudeManager: ClaudeAgentManager | null = null
let codexManager: CodexAgentManager | null = null
const sessionManagerMap = new Map<string, 'claude' | 'codex'>()
let updateCheckResult: UpdateCheckResult | null = null
const profileManager = new ProfileManager()
const remoteServer = new RemoteServer()
const remoteClientsByProfileId = new Map<string, RemoteClient>()
const detachedWindows = new Map<string, BrowserWindow>() // workspaceId → BrowserWindow
let isAppQuitting = false // Distinguishes Cmd+Q (preserve) from Cmd+W (remove window)

type RemoteBindInterface = 'localhost' | 'tailscale' | 'all'

function normalizeRemoteBindInterface(value: unknown): RemoteBindInterface {
  return value === 'tailscale' || value === 'all' ? value : 'localhost'
}

function getRemoteClient(profileId: string | null | undefined): RemoteClient | null {
  if (!profileId) return null
  return remoteClientsByProfileId.get(profileId) ?? null
}

function setRemoteClient(profileId: string | null | undefined, client: RemoteClient): void {
  if (!profileId) {
    try { client.disconnect() } catch { /* ignore */ }
    return
  }
  try { remoteClientsByProfileId.get(profileId)?.disconnect() } catch { /* ignore */ }
  remoteClientsByProfileId.set(profileId, client)
}

function disconnectRemoteClient(profileId: string | null | undefined): void {
  if (!profileId) return
  try { remoteClientsByProfileId.get(profileId)?.disconnect() } catch { /* ignore */ }
  remoteClientsByProfileId.delete(profileId)
}

function disconnectAllRemoteClients(): void {
  for (const client of remoteClientsByProfileId.values()) {
    try { client.disconnect() } catch { /* ignore */ }
  }
  remoteClientsByProfileId.clear()
}

function readStartupSettings(): { remoteServerAutoStart?: boolean; remoteServerPort?: number; remoteServerBindInterface?: RemoteBindInterface } {
  try {
    const configPath = path.join(app.getPath('userData'), 'settings.json')
    const raw = fsSync.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      remoteServerAutoStart: parsed.remoteServerAutoStart === true,
      remoteServerPort: typeof parsed.remoteServerPort === 'number' ? parsed.remoteServerPort : undefined,
      remoteServerBindInterface: normalizeRemoteBindInterface(parsed.remoteServerBindInterface),
    }
  } catch {
    return {}
  }
}

async function maybeAutoStartRemoteServer(defaultWindowId: string | null): Promise<void> {
  const settings = readStartupSettings()
  if (settings.remoteServerAutoStart !== true || remoteServer.isRunning) return
  remoteServer.setDefaultWindowId(defaultWindowId)
  try {
    const result = await remoteServer.start({
      port: settings.remoteServerPort || 9876,
      bindInterface: settings.remoteServerBindInterface || 'localhost',
    })
    logger.log(`[RemoteServer] auto-started on ${result.boundHost}:${result.port} (iface=${result.bindInterface})`)
  } catch (err) {
    logger.error('[RemoteServer] auto-start failed:', err instanceof Error ? err.message : String(err))
  }
}

/** Attach a will-resize throttle to a BrowserWindow to reduce DWM pressure on Windows. */
function setupResizeThrottle(win: BrowserWindow, label: string) {
  let lastResizeTime = 0
  let throttledCount = 0
  win.on('will-resize', (event, newBounds) => {
    const now = Date.now()
    const elapsed = now - lastResizeTime
    if (elapsed < 100) {
      event.preventDefault()
      throttledCount++
    } else {
      if (throttledCount > 0) {
        logger.log(`[resize] ${label} will-resize: ${throttledCount} events throttled since last ALLOWED`)
        throttledCount = 0
      }
      lastResizeTime = now
      logger.log(`[resize] ${label} will-resize ALLOWED ${newBounds.width}x${newBounds.height}`)
    }
  })
}

function getAllWindows(): BrowserWindow[] {
  const wins: BrowserWindow[] = []
  for (const win of windowMap.values()) {
    if (!win.isDestroyed()) wins.push(win)
  }
  for (const win of detachedWindows.values()) {
    if (!win.isDestroyed()) wins.push(win)
  }
  return wins
}

function focusNextAppWindow(source: Electron.WebContents): boolean {
  const windows = Array.from(windowMap.values()).filter(win => !win.isDestroyed())
  if (windows.length <= 1) return false

  const currentIndex = windows.findIndex(win => win.webContents === source)
  const startIndex = currentIndex >= 0 ? currentIndex : windows.findIndex(win => win.isFocused())
  const nextIndex = ((startIndex >= 0 ? startIndex : -1) + 1) % windows.length
  const nextWindow = windows[nextIndex]

  if (nextWindow.isMinimized()) nextWindow.restore()
  if (!nextWindow.isVisible()) nextWindow.show()
  nextWindow.focus()
  return true
}

/** Sync filter: windows whose registry entry's profileId matches `profileId`.
 *  Used to scope remote event broadcasts to the correct profile's windows. */
function getWindowsForProfile(profileId: string | null): BrowserWindow[] {
  if (!profileId) return []
  const entries = windowRegistry.getCachedEntries()
  const matchIds = new Set(entries.filter(e => e.profileId === profileId).map(e => e.id))
  const wins: BrowserWindow[] = []
  for (const [id, win] of windowMap) {
    if (matchIds.has(id) && !win.isDestroyed()) wins.push(win)
  }
  for (const [id, win] of detachedWindows) {
    if (matchIds.has(id) && !win.isDestroyed()) wins.push(win)
  }
  return wins
}

async function getWorkspaceMoveRealm(profileId: string | null): Promise<string> {
  if (!profileId) return 'local'
  const profile = await profileManager.getProfile(profileId)
  if (!profile || profile.type !== 'remote') return 'local'
  const host = (profile.remoteHost || '').trim().toLowerCase()
  const port = profile.remotePort || 9876
  const fingerprint = (profile.remoteFingerprint || '').replace(/:/g, '').trim().toLowerCase()
  return `remote:${fingerprint || host}:${port}`
}

/** Reverse lookup: find windowId from a WebContents (for IPC sender context) */
function getWindowIdByWebContents(wc: Electron.WebContents): string | null {
  for (const [id, win] of windowMap) {
    if (!win.isDestroyed() && win.webContents === wc) return id
  }
  return null
}

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const GITHUB_REPO_URL = 'https://github.com/tony1223/better-agent-terminal'

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'GitHub Repository',
          click: () => shell.openExternal(GITHUB_REPO_URL)
        },
        {
          label: 'Report Issue',
          click: () => shell.openExternal(`${GITHUB_REPO_URL}/issues`)
        },
        {
          label: 'Releases',
          click: () => shell.openExternal(`${GITHUB_REPO_URL}/releases`)
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            const focusedWin = BrowserWindow.getFocusedWindow() || [...windowMap.values()][0]
            if (focusedWin) {
              dialog.showMessageBox(focusedWin, {
                type: 'info',
                title: 'About Better Agent Terminal',
                message: 'Better Agent Terminal',
                detail: `Version: ${app.getVersion()}\n\nA terminal aggregator with multi-workspace support and Claude Agent integration.\n\nAuthor: TonyQ`
              })
            }
          }
        }
      ]
    }
  ]

  // Add Update menu item if update is available
  if (updateCheckResult?.hasUpdate && updateCheckResult.latestRelease) {
    template.push({
      label: '🎉 Update Available!',
      submenu: [
        {
          label: `View ${updateCheckResult.latestRelease.tagName} on GitHub`,
          click: () => shell.openExternal(`${GITHUB_REPO_URL}/releases`)
        }
      ]
    })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function setupCopyShortcutForwarding(win: BrowserWindow) {
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    if (input.shift) return
    if (!(input.control || input.meta)) return
    if (input.key.toLowerCase() !== 'c') return
    win.webContents.send('app:copy-shortcut')
  })
}

function attachWindowLoadDiagnostics(win: BrowserWindow, label: string) {
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logger.error(`[window:${label}] did-fail-load main=${isMainFrame} code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`[window:${label}] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.on('unresponsive', () => {
    logger.warn(`[window:${label}] unresponsive`)
  })
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return
    logger.log(`[window:${label}] console level=${level} ${sourceId}:${line} ${message}`)
  })
}

function createWindow(windowId: string, bounds?: { x: number; y: number; width: number; height: number }) {
  const win = new BrowserWindow({
    width: bounds?.width || 1400,
    height: bounds?.height || 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 800,
    minHeight: 600,
    show: true,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    frame: true,
    titleBarStyle: 'default',
    title: 'Better Agent Terminal',
    icon: nativeImage.createFromPath(path.join(__dirname, process.platform === 'win32' ? '../assets/icon.ico' : '../assets/icon.png'))
  })

  setupCopyShortcutForwarding(win)
  attachWindowLoadDiagnostics(win, windowId)
  windowMap.set(windowId, win)

  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png'))
    app.dock.setIcon(dockIcon)
  }

  // Create managers once (shared across all windows)
  if (!ptyManager) ptyManager = new PtyManager(getAllWindows)
  if (!claudeManager) claudeManager = new ClaudeAgentManager(getAllWindows, getWindowsForProfile)
  if (!codexManager) codexManager = new CodexAgentManager(getAllWindows, undefined, getWindowsForProfile)

  const urlParam = `?windowId=${encodeURIComponent(windowId)}`
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL + urlParam)
    if (windowMap.size === 1) win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'), { search: urlParam })
  }

  // Open all external links in the system browser, never inside Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const appUrl = VITE_DEV_SERVER_URL || `file://${path.join(__dirname, '../dist/index.html')}`
    if (!url.startsWith(appUrl.split('?')[0])) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  setupResizeThrottle(win, `window-${windowId.slice(0, 12)}`)

  // Save window bounds on move/resize (debounced)
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const b = win.getBounds()
      windowRegistry.getEntry(windowId).then(entry => {
        if (entry) {
          entry.bounds = b
          entry.lastActiveAt = Date.now()
          windowRegistry.saveEntry(entry)
        }
      })
    }, 1000)
  }
  win.on('moved', saveBounds)
  win.on('resized', saveBounds)

  win.on('close', (e) => {
    if (isAppQuitting) {
      // App quitting (Cmd+Q): save handled by before-quit, just let it close
      return
    }

    // Manual close (Cmd+W / click X)
    e.preventDefault()
    windowRegistry.getEntry(windowId).then(async (entry) => {
      if (!entry?.profileId) {
        // No profile — just close and remove entry
        await windowRegistry.removeEntry(windowId)
        win.destroy()
        return
      }

      // Count how many windows this profile currently has open
      const allEntries = await windowRegistry.readAll()
      const profileWindowCount = allEntries.filter(e =>
        e.profileId === entry.profileId && windowMap.has(e.id)
      ).length

      if (profileWindowCount <= 1) {
        // Last window in profile — preserve snapshot but mark profile inactive
        disconnectRemoteClient(entry.profileId)
        await profileManager.deactivateProfile(entry.profileId!)
        win.destroy()
        return
      }

      // No workspaces — silently remove from profile without asking
      if (!entry.workspaces || entry.workspaces.length === 0) {
        const profileId = entry.profileId!
        await windowRegistry.removeEntry(windowId)
        await profileManager.save(profileId).catch(() => { /* ignore */ })
        const remaining = (await windowRegistry.readAll()).filter(e =>
          e.profileId === profileId && windowMap.has(e.id) && e.id !== windowId
        )
        if (remaining.length === 0) {
          disconnectRemoteClient(profileId)
          await profileManager.deactivateProfile(profileId)
        }
        win.destroy()
        return
      }

      // Multiple windows — ask user
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Remove from profile', 'Close only', 'Cancel'],
        defaultId: 1,
        cancelId: 2,
        title: 'Close Window',
        message: 'How do you want to close this window?',
        detail: 'Remove from profile: this window won\'t be restored next time.\nClose only: preserve it in the profile for next launch.',
      })

      if (response === 2) return // Cancel

      if (response === 0) {
        // Remove from profile: delete entry, then save remaining windows
        const profileId = entry.profileId!
        await windowRegistry.removeEntry(windowId)
        await profileManager.save(profileId).catch(() => { /* ignore */ })
        // If that was the last open window for this profile, deactivate it
        const remaining = (await windowRegistry.readAll()).filter(e =>
          e.profileId === profileId && windowMap.has(e.id) && e.id !== windowId
        )
        if (remaining.length === 0) {
          disconnectRemoteClient(profileId)
          await profileManager.deactivateProfile(profileId)
        }
      }
      // response === 1: Close only — keep entry in registry, save snapshot so it persists
      if (response === 1 && entry.profileId) {
        await profileManager.save(entry.profileId).catch(() => { /* ignore */ })
      }

      win.destroy()
    }).catch(() => { /* ignore */ })
  })

  win.on('closed', () => {
    windowMap.delete(windowId)
    // Close detached windows that were opened from this window
    // (for now close all detached — same as before)
    if (windowMap.size === 0) {
      for (const [, dw] of detachedWindows) {
        if (!dw.isDestroyed()) dw.close()
      }
      detachedWindows.clear()
    }
  })

  return win
}

function cleanupAllProcesses() {
  disconnectAllRemoteClients()
  try { remoteServer.stop() } catch { /* ignore */ }
  try { claudeManager?.killAll() } catch { /* ignore */ }
  try { claudeManager?.dispose() } catch { /* ignore */ }
  try { codexManager?.killAll() } catch { /* ignore */ }
  try { codexManager?.dispose() } catch { /* ignore */ }
  try { ptyManager?.dispose() } catch { /* ignore */ }
  try { snippetDb.close() } catch { /* ignore */ }
  claudeManager = null
  codexManager = null
  sessionManagerMap.clear()
  ptyManager = null
}

// Handle launch arguments (kept for backward compat but no longer spawns processes)
const profileArg = process.argv.find(a => a.startsWith('--profile='))
const launchProfileId = profileArg ? profileArg.split('=')[1] || null : null

const windowRegistry = new WindowRegistry()
profileManager.setWindowRegistry(windowRegistry)

// Serialize remote client connect/disconnect so two profile loads don't race.
let remoteClientConnectInFlight: Promise<void> | null = null

async function withRemoteClientLock<T>(fn: () => Promise<T>): Promise<T> {
  while (remoteClientConnectInFlight) {
    await remoteClientConnectInFlight
  }
  let release!: () => void
  remoteClientConnectInFlight = new Promise<void>(r => { release = r })
  try {
    return await fn()
  } finally {
    release()
    remoteClientConnectInFlight = null
  }
}

type SnapshotLoadResult =
  | { kind: 'ok'; snapshot: ProfileSnapshot | null }
  | { kind: 'remote-unreachable'; host: string; port: number; label: string }

// Helper: load snapshot for a profile, handling remote profiles by fetching from the remote server
async function loadProfileSnapshotDetailed(profileId: string): Promise<SnapshotLoadResult> {
  const profileEntry = await profileManager.getProfile(profileId)
  if (profileEntry?.type === 'remote' && profileEntry.remoteHost && profileEntry.remoteToken && profileEntry.remoteFingerprint) {
    const host = profileEntry.remoteHost
    const port = profileEntry.remotePort || 9876
    const label = profileEntry.name || profileId
    return await withRemoteClientLock(async () => {
      try {
        const client = new RemoteClient(() => getWindowsForProfile(profileId))
        const ok = await client.connect({
          host,
          port,
          token: profileEntry.remoteToken!,
          fingerprint: profileEntry.remoteFingerprint!
        })
        if (!ok) {
          logger.error(`[profile] remote connect failed for profile ${profileId} (${host}:${port})`)
          return { kind: 'remote-unreachable', host, port, label }
        }
        setRemoteClient(profileId, client)
        const targetProfileId = profileEntry.remoteProfileId || 'default'
        const snapshot = await client.invoke('profile:load-snapshot', [targetProfileId]) as ProfileSnapshot | null
        logger.log(`[profile] remote profile ${profileId} → got ${snapshot?.windows?.length ?? 0} window(s) from remote (target: ${targetProfileId})`)
        return { kind: 'ok', snapshot }
      } catch (err) {
        logger.error(`[profile] remote profile ${profileId} snapshot fetch failed:`, err instanceof Error ? err.message : String(err))
        return { kind: 'remote-unreachable', host, port, label }
      }
    })
  }
  if (profileEntry?.type === 'remote' && !profileEntry.remoteFingerprint) {
    logger.warn(`[profile] remote profile ${profileId} is missing remoteFingerprint — refusing to connect (legacy plaintext setup, please re-pair)`)
    return { kind: 'remote-unreachable', host: profileEntry.remoteHost || '', port: profileEntry.remotePort || 9876, label: profileEntry.name || profileId }
  }
  return { kind: 'ok', snapshot: await profileManager.loadSnapshot(profileId) }
}

function showRemoteUnreachableDialog(host: string, port: number, label: string): void {
  dialog.showMessageBox({
    type: 'warning',
    title: 'Remote profile unreachable',
    message: `Cannot connect to remote profile "${label}"`,
    detail: `The remote server at ${host}:${port} is not running or did not respond within 6 seconds.`,
    buttons: ['OK']
  }).catch(() => { /* ignore */ })
}

async function pickFallbackProfileId(excludeProfileId: string): Promise<string | null> {
  const { profiles } = await profileManager.list()
  const local = profiles.filter(p => p.type !== 'remote' && p.id !== excludeProfileId)
  if (local.length > 0) {
    return (local.find(p => p.id === 'default') || local[0]).id
  }
  const other = profiles.find(p => p.id !== excludeProfileId)
  return other?.id || null
}

app.whenReady().then(async () => {
  const t0 = Date.now()
  logger.init(app.getPath('userData'))
  logger.log(`[startup] ═══════════════════════════════════════`)
  logger.log(`[startup] app.whenReady fired at +${t0 - _t0}ms from IPC reg, +${t0 - _processStart}ms from process`)

  // Ensure profile system is initialized (migrates from workspaces.json on first run)
  const migratedEntries = await windowRegistry.ensureInitialized()

  // If migration just happened (first run after upgrade), save migrated data as profile snapshot
  // BEFORE clearing windows.json, so workspaces aren't lost
  if (migratedEntries.length > 0) {
    const profileIds = [...new Set(migratedEntries.filter(e => e.profileId).map(e => e.profileId!))]
    for (const pid of profileIds) {
      const saved = await profileManager.save(pid).catch(() => false)
      logger.log(`[startup] saved migration snapshot for profile ${pid}: ${saved}`)
    }
  }

  // Collect window IDs to create
  const windowsToCreate: { id: string; bounds?: { x: number; y: number; width: number; height: number } }[] = []

  // Clear windows.json — it's purely runtime state, snapshots are the source of truth
  await windowRegistry.clear()

  // Helper: apply a snapshot's windows into the registry
  const applySnapshot = async (profileId: string, snapshot: ProfileSnapshot): Promise<number> => {
    if (!snapshot || snapshot.windows.length === 0) return 0
    for (const winSnap of snapshot.windows) {
      const entry = await windowRegistry.createEntry({ profileId })
      entry.workspaces = winSnap.workspaces
      entry.activeWorkspaceId = winSnap.activeWorkspaceId
      entry.activeGroup = winSnap.activeGroup
      entry.terminals = winSnap.terminals
      entry.activeTerminalId = winSnap.activeTerminalId
      entry.bounds = winSnap.bounds
      await windowRegistry.saveEntry(entry)
      windowsToCreate.push({ id: entry.id, bounds: winSnap.bounds })
    }
    return snapshot.windows.length
  }

  // Helper: restore windows for a profile at startup
  const restoreFromSnapshot = async (profileId: string): Promise<{ count: number; unreachable?: { host: string; port: number; label: string } }> => {
    const result = await loadProfileSnapshotDetailed(profileId)
    if (result.kind === 'remote-unreachable') {
      return { count: 0, unreachable: { host: result.host, port: result.port, label: result.label } }
    }
    if (!result.snapshot) return { count: 0 }
    return { count: await applySnapshot(profileId, result.snapshot) }
  }

  // Track remote-unreachable failures so we can show a dialog once windows exist
  const unreachableFailures: { host: string; port: number; label: string }[] = []

  if (launchProfileId) {
    // --profile= launch: restore that profile's windows
    const { count, unreachable } = await restoreFromSnapshot(launchProfileId)
    if (unreachable) unreachableFailures.push(unreachable)
    if (count === 0 && !unreachable) {
      // No snapshot — create empty window
      const entry = await windowRegistry.createEntry({ profileId: launchProfileId })
      windowsToCreate.push({ id: entry.id })
    }
    if (!unreachable) await profileManager.activateProfile(launchProfileId)
    logger.log(`[startup] profile launch ${launchProfileId} → ${windowsToCreate.length} window(s)`)

    // Remote unreachable and no other windows — fall back to any available profile
    if (unreachable && windowsToCreate.length === 0) {
      const fallbackId = await pickFallbackProfileId(launchProfileId)
      if (fallbackId) {
        logger.log(`[startup] remote launch profile unreachable, falling back to ${fallbackId}`)
        const { count: fbCount, unreachable: fbUnreachable } = await restoreFromSnapshot(fallbackId)
        if (fbUnreachable) unreachableFailures.push(fbUnreachable)
        await profileManager.activateProfile(fallbackId)
        if (fbCount === 0) {
          const entry = await windowRegistry.createEntry({ profileId: fallbackId })
          windowsToCreate.push({ id: entry.id })
        }
      } else {
        const entry = await windowRegistry.createEntry({ profileId: launchProfileId })
        windowsToCreate.push({ id: entry.id })
      }
    }
  } else {
    // Normal launch: restore windows for all active profiles
    let activeProfileIds = await profileManager.getActiveProfileIds()
    logger.log(`[startup] active profiles: ${activeProfileIds.join(', ') || '(none)'}`)

    // If no active profiles, fallback to default or first local profile
    if (activeProfileIds.length === 0) {
      const { profiles } = await profileManager.list()
      const fallback = profiles.find(p => p.id === 'default') || profiles.find(p => p.type === 'local') || profiles[0]
      const fallbackId = fallback?.id || 'default'
      activeProfileIds = [fallbackId]
      await profileManager.activateProfile(fallbackId)
      logger.log(`[startup] no active profiles, falling back to ${fallbackId}`)
    }

    for (const pid of activeProfileIds) {
      const { count, unreachable } = await restoreFromSnapshot(pid)
      if (unreachable) unreachableFailures.push(unreachable)
      logger.log(`[startup] restored ${count} window(s) from profile ${pid}${unreachable ? ' (remote unreachable)' : ''}`)
    }

    // If no windows (all snapshots empty or remote unreachable), create one empty window
    if (windowsToCreate.length === 0) {
      // Prefer a local fallback when the only active profiles were remote-unreachable
      let fallbackPid = activeProfileIds[0]
      if (unreachableFailures.length > 0) {
        const localFallback = await pickFallbackProfileId(fallbackPid)
        if (localFallback) {
          fallbackPid = localFallback
          await profileManager.activateProfile(localFallback)
          const { count } = await restoreFromSnapshot(localFallback)
          if (count > 0) {
            logger.log(`[startup] fell back to local profile ${localFallback} → ${count} window(s)`)
          }
        }
      }
      if (windowsToCreate.length === 0) {
        const entry = await windowRegistry.createEntry({ profileId: fallbackPid })
        windowsToCreate.push({ id: entry.id })
        logger.log(`[startup] created empty window for profile ${fallbackPid}`)
      }
    }
  }

  const t1 = Date.now()
  buildMenu()
  logger.log(`[startup] buildMenu: ${Date.now() - t1}ms`)
  remoteServer.configDir = app.getPath('userData')

  // Create all windows in this process
  for (const w of windowsToCreate) {
    const t2 = Date.now()
    const win = createWindow(w.id, w.bounds)
    logger.log(`[startup] createWindow ${w.id}: ${Date.now() - t2}ms`)
    // Startup instrumentation on first window only
    if (windowMap.size === 1) {
      win.webContents.on('did-start-loading', () => {
        logger.log(`[startup] did-start-loading: +${Date.now() - t0}ms from whenReady`)
      })
      win.webContents.on('dom-ready', () => {
        logger.log(`[startup] dom-ready: +${Date.now() - t0}ms from whenReady`)
      })
      win.webContents.on('did-finish-load', () => {
        logger.log(`[startup] did-finish-load: +${Date.now() - t0}ms from whenReady`)
      })
      const ipcSub = () => {
        logger.log(`[startup] first-renderer-ipc: +${Date.now() - t0}ms from whenReady`)
        win.webContents.removeListener('ipc-message', ipcSub)
      }
      win.webContents.on('ipc-message', ipcSub)
    }
  }

  await maybeAutoStartRemoteServer(windowsToCreate[0]?.id ?? null)

  // Show any remote-unreachable notifications after windows are created
  for (const fail of unreachableFailures) {
    showRemoteUnreachableDialog(fail.host, fail.port, fail.label)
  }

  // Second instance launched — open a new window in existing process
  app.on('second-instance', async (_event, argv) => {
    // Check if launched with --profile=
    const profileArg2 = argv.find(a => a.startsWith('--profile='))
    const profileId2 = profileArg2 ? profileArg2.split('=')[1] || null : null

    if (profileId2) {
      // Open profile (focus if already open, otherwise restore from snapshot)
      const entries = await windowRegistry.readAll()
      const existing = entries.filter(e => e.profileId === profileId2)
      const openWin = existing.find(e => {
        const w = windowMap.get(e.id)
        return w && !w.isDestroyed()
      })
      if (openWin) {
        const w = windowMap.get(openWin.id)!
        if (w.isMinimized()) w.restore()
        w.focus()
      } else {
        await profileManager.activateProfile(profileId2)
        const result = await loadProfileSnapshotDetailed(profileId2)
        if (result.kind === 'remote-unreachable') {
          showRemoteUnreachableDialog(result.host, result.port, result.label)
          await profileManager.deactivateProfile(profileId2).catch(() => { /* ignore */ })
          return
        }
        const snapshot = result.snapshot
        if (snapshot && snapshot.windows.length > 0) {
          for (const winSnap of snapshot.windows) {
            const entry = await windowRegistry.createEntry({ profileId: profileId2 })
            entry.workspaces = winSnap.workspaces
            entry.activeWorkspaceId = winSnap.activeWorkspaceId
            entry.activeGroup = winSnap.activeGroup
            entry.terminals = winSnap.terminals
            entry.activeTerminalId = winSnap.activeTerminalId
            entry.bounds = winSnap.bounds
            await windowRegistry.saveEntry(entry)
            createWindow(entry.id, winSnap.bounds)
          }
        } else {
          const entry = await windowRegistry.createEntry({ profileId: profileId2 })
          createWindow(entry.id)
        }
      }
    } else {
      // No profile arg — open new window inheriting first active profile
      const activeIds = await profileManager.getActiveProfileIds()
      const pid = activeIds[0] || 'default'
      const entry = await windowRegistry.createEntry({ profileId: pid })
      createWindow(entry.id)
    }
  })

  // Listen for system resume from sleep/hibernate
  powerMonitor.on('resume', () => {
    logger.log('System resumed from sleep')
    for (const win of getAllWindows()) {
      win.webContents.send('system:resume')
    }
  })

  // Check for updates after startup
  setTimeout(async () => {
    try {
      updateCheckResult = await checkForUpdates()
      if (updateCheckResult.hasUpdate) {
        // Rebuild menu to show update option
        buildMenu()
      }
    } catch (error) {
      logger.error('Failed to check for updates:', error)
    }
  }, 2000)
})

// Cleanup runs once: before-quit covers cmd+Q / File→Quit paths,
// window-all-closed covers the user closing the last window.
// Guard with a flag to avoid running twice.
let _cleanupDone = false
function runCleanupOnce() {
  if (_cleanupDone) return
  _cleanupDone = true
  cleanupAllProcesses()
}

app.on('before-quit', async (e) => {
  if (!isAppQuitting) {
    e.preventDefault()
    isAppQuitting = true

    // Save all open windows' profiles before quitting
    try {
      const allEntries = await windowRegistry.readAll()
      const profileIds = [...new Set(allEntries.filter(e => e.profileId).map(e => e.profileId!))]
      await Promise.all(profileIds.map(pid => profileManager.save(pid).catch(() => { /* ignore */ })))
      logger.log(`[quit] saved ${profileIds.length} profile snapshot(s)`)
    } catch (err) {
      logger.error(`[quit] failed to save profiles: ${err}`)
    }

    runCleanupOnce()
    app.quit()
  }
})

app.on('window-all-closed', () => {
  runCleanupOnce()
  app.quit()
  // Force exit — child processes (PTY shells, Claude CLI) may keep the event loop alive.
  if (process.platform !== 'darwin') {
    setTimeout(() => process.exit(0), 2000)
  }
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const entry = await windowRegistry.createEntry()
    createWindow(entry.id)
  }
})


// ── Bind all proxied handlers to ipcMain ──

// Channels that MUST run locally even when connected to a remote host.
// These handlers depend on ctx.windowId which the remote protocol doesn't
// forward; proxying them would return null and break the UI.
// The snapshot data for workspaces is already replicated into the local
// windowRegistry via applySnapshot() at startup, so reading locally works.
const ALWAYS_LOCAL_CHANNELS = new Set([
  'workspace:save', 'workspace:load',
])

function bindProxiedHandlersToIpc() {
  for (const channel of PROXIED_CHANNELS) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const windowId = getWindowIdByWebContents(event.sender)

      // ALWAYS_LOCAL channels never proxy.
      if (ALWAYS_LOCAL_CHANNELS.has(channel)) {
        return invokeHandler(channel, args, windowId)
      }

      // Route per sender window's profile type. A remote profile window
      // proxies to the remote server; a local profile window stays local
      // even if another window has an active remote connection.
      let senderIsRemote = false
      let senderProfileId: string | null = null
      if (windowId) {
        const entry = await windowRegistry.getEntry(windowId)
        if (entry?.profileId) {
          senderProfileId = entry.profileId
          const profile = await profileManager.getProfile(entry.profileId)
          senderIsRemote = profile?.type === 'remote'
        }
      }

      const remoteClient = getRemoteClient(senderProfileId)
      if (senderIsRemote && remoteClient?.isConnected) {
        return remoteClient.invoke(channel, args)
      }
      return invokeHandler(channel, args, windowId)
    })
  }
}

// ── Renderer debug log (fire-and-forget, no blocking) ──
ipcMain.on('debug:log', (_event, ...args: unknown[]) => {
  logger.log('[renderer]', ...args)
})
ipcMain.handle('debug:open-logs-folder', async () => {
  await shell.openPath(app.getPath('userData'))
  return true
})

// ── Local-only IPC handlers (not proxied) ──

function registerLocalHandlers() {
  // Local-only profile list (never proxied to remote). Used by the renderer
  // to resolve the window's own identity when connected to a remote host,
  // since the proxied profile:list returns the REMOTE host's profiles and
  // the client's local aliases won't be found there.
  ipcMain.handle('profile:list-local', () => profileManager.list())

  ipcMain.handle('dialog:select-folder', async (event) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parentWin!, {
      defaultPath: app.getPath('home'),
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    })
    return result.canceled ? null : result.filePaths
  })

  ipcMain.handle('dialog:select-images', async (event) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parentWin!, {
      defaultPath: app.getPath('home'),
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:select-files', async (event) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parentWin!, {
      defaultPath: app.getPath('home'),
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:confirm', async (event, message: string, title?: string) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showMessageBox(parentWin!, {
      type: 'warning',
      buttons: ['OK', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: title || 'Confirm',
      message,
    })
    return result.response === 0
  })

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (url.startsWith('file:///')) {
      let filePath = decodeURIComponent(new URL(url).pathname)
      // On Windows, URL.pathname gives "/C:/foo" — strip the leading slash before
      // the drive letter so fs/shell APIs accept it.
      if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1)
      const { existsSync } = await import('fs')
      if (!existsSync(filePath)) {
        const { dialog } = await import('electron')
        dialog.showMessageBox({ type: 'warning', title: 'File not found', message: `File does not exist:\n${filePath}` })
        return
      }
      // shell.openExternal treats file:// as a URL and relies on protocol handlers,
      // which silently fails for many file types. openPath uses the OS "open" verb.
      const err = await shell.openPath(filePath)
      if (err) logger.error(`[shell:open-external] openPath failed for ${filePath}: ${err}`)
      return
    }
    await shell.openExternal(url)
  })
  ipcMain.handle('shell:open-path', async (_event, folderPath: string) => { await shell.openPath(folderPath) })

  ipcMain.handle('update:check', async () => {
    try { return await checkForUpdates() }
    catch (error) { logger.error('Failed to check for updates:', error); return { hasUpdate: false, currentVersion: app.getVersion(), latestRelease: null } }
  })
  ipcMain.handle('update:get-version', () => app.getVersion())

  ipcMain.handle('clipboard:saveImage', async () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const os = await import('os')
    const filePath = path.join(os.tmpdir(), `bat-clipboard-${Date.now()}.png`)
    await fs.writeFile(filePath, image.toPNG())
    return filePath
  })
  ipcMain.handle('clipboard:writeImage', async (_event, filePath: string) => {
    const image = nativeImage.createFromPath(filePath)
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  })
  ipcMain.handle('clipboard:writeText', async (_event, text: string) => {
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle('image:save-data-url', async (event, dataUrl: string, defaultName?: string) => {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl)
    if (!match) throw new Error('Invalid image data URL')
    const extensionByMime: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
    }
    const ext = extensionByMime[match[1].toLowerCase()] || 'png'
    const safeDefaultName = (defaultName || `generated-image.${ext}`)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/\.+$/g, '')
    const filename = /\.[a-z0-9]+$/i.test(safeDefaultName) ? safeDefaultName : `${safeDefaultName}.${ext}`
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(parentWin!, {
      defaultPath: filename,
      filters: [
        { name: `${ext.toUpperCase()} Image`, extensions: [ext] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, Buffer.from(match[2].replace(/\s/g, ''), 'base64'))
    return result.filePath
  })

  // Remote server handlers (always local)
  ipcMain.handle('remote:start-server', async (event, options?: { port?: number; token?: string; bindInterface?: 'localhost' | 'tailscale' | 'all' }) => {
    remoteServer.setDefaultWindowId(getWindowIdByWebContents(event.sender))
    try { return await remoteServer.start(options ?? {}) }
    catch (err: unknown) { return { error: err instanceof Error ? err.message : String(err) } }
  })
  ipcMain.handle('remote:stop-server', async () => {
    remoteServer.stop()
    return true
  })
  ipcMain.handle('remote:server-status', async () => ({
    running: remoteServer.isRunning,
    port: remoteServer.port,
    fingerprint: remoteServer.fingerprint,
    bindInterface: remoteServer.isRunning ? remoteServer.bindInterface : null,
    boundHost: remoteServer.isRunning ? remoteServer.boundHost : null,
    clients: remoteServer.connectedClients
  }))

  // Mobile QR code connection: ensure server is running, return connection URL + fingerprint
  ipcMain.handle('tunnel:get-connection', async (event) => {
    try {
      const windowId = getWindowIdByWebContents(event.sender)
      remoteServer.setDefaultWindowId(windowId)
      let port: number
      let token: string
      let fingerprint: string
      let boundHost: string
      if (!remoteServer.isRunning) {
        // QR/mobile implies broader reachability — if the user explicitly
        // triggers this, start the server bound to all interfaces. They still
        // need the token + fingerprint to connect.
        const result = await remoteServer.start({ bindInterface: 'all' })
        port = result.port
        token = result.token
        fingerprint = result.fingerprint
        boundHost = result.boundHost
      } else {
        port = remoteServer.port!
        const persisted = remoteServer.getPersistedToken()
        if (!persisted) return { error: 'Server running but token is unavailable' }
        token = persisted
        fingerprint = remoteServer.fingerprint!
        boundHost = remoteServer.boundHost
      }
      const info = getConnectionInfo(port, token, fingerprint, boundHost)
      if ('error' in info) return info
      return { ...info, context: { windowId } }
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Remote client handlers
  ipcMain.handle('remote:connect', async (event, host: string, port: number, token: string, fingerprint: string, label?: string) => {
    return withRemoteClientLock(async () => {
      try {
        if (!fingerprint) return { error: 'fingerprint is required' }
        // Derive the bound profileId from the sender window so remote-event
        // broadcasts only reach this profile's windows.
        const senderWindowId = getWindowIdByWebContents(event.sender)
        const senderEntry = senderWindowId ? await windowRegistry.getEntry(senderWindowId) : null
        const boundProfileId = senderEntry?.profileId ?? null
        const client = new RemoteClient(() => getWindowsForProfile(boundProfileId))
        const ok = await client.connect({ host, port, token, fingerprint, label })
        if (!ok) {
          return { error: 'Connection failed (auth rejected, unreachable, or fingerprint mismatch)' }
        }
        setRemoteClient(boundProfileId, client)
        return { connected: true }
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    })
  })
  ipcMain.handle('remote:disconnect', async (event) => {
    return withRemoteClientLock(async () => {
      const senderWindowId = getWindowIdByWebContents(event.sender)
      const senderEntry = senderWindowId ? await windowRegistry.getEntry(senderWindowId) : null
      disconnectRemoteClient(senderEntry?.profileId ?? null)
      return true
    })
  })
  ipcMain.handle('remote:client-status', async (event) => {
    const senderWindowId = getWindowIdByWebContents(event.sender)
    const senderEntry = senderWindowId ? await windowRegistry.getEntry(senderWindowId) : null
    const senderProfileId = senderEntry?.profileId ?? null
    const remoteClient = getRemoteClient(senderProfileId)
    const connected = !!remoteClient?.isConnected
    return {
      connected,
      info: connected ? remoteClient?.connectionInfo ?? null : null,
    }
  })
  ipcMain.handle('remote:test-connection', async (_event, host: string, port: number, token: string, fingerprint: string) => {
    if (!fingerprint) return { ok: false, error: 'fingerprint is required' }
    const testClient = new RemoteClient(() => [])
    try {
      const ok = await testClient.connect({ host, port, token, fingerprint })
      testClient.disconnect()
      return { ok }
    } catch (err) {
      testClient.disconnect()
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('remote:list-profiles', async (_event, host: string, port: number, token: string, fingerprint: string) => {
    if (!fingerprint) return { error: 'fingerprint is required' }
    const tempClient = new RemoteClient(() => [])
    try {
      const ok = await tempClient.connect({ host, port, token, fingerprint })
      if (!ok) return { error: 'Connection failed' }
      const result = await tempClient.invoke('profile:list', []) as { profiles: { id: string; name: string; type: string }[]; activeProfileIds: string[] }
      tempClient.disconnect()
      return {
        profiles: result.profiles.map(p => ({ id: p.id, name: p.name, type: p.type })),
        activeProfileIds: result.activeProfileIds ?? [],
      }
    } catch (err) {
      tempClient.disconnect()
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Profile handlers (local-only — list/load/activate/deactivate/get-active-ids are proxied)
  ipcMain.handle('profile:create', async (_event, name: string, options?: { type?: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string; remoteFingerprint?: string; remoteProfileId?: string }) => profileManager.create(name, options))
  ipcMain.handle('profile:save', async (_event, profileId: string) => profileManager.save(profileId))
  ipcMain.handle('profile:delete', async (_event, profileId: string) => profileManager.delete(profileId))
  ipcMain.handle('profile:rename', async (_event, profileId: string, newName: string) => profileManager.rename(profileId, newName))
  ipcMain.handle('profile:duplicate', async (_event, profileId: string, newName: string) => profileManager.duplicate(profileId, newName))
  ipcMain.handle('profile:update', async (_event, profileId: string, updates: { remoteHost?: string; remotePort?: number; remoteToken?: string; remoteFingerprint?: string; remoteProfileId?: string }) => profileManager.update(profileId, updates))
  ipcMain.handle('profile:get', async (_event, profileId: string) => profileManager.getProfile(profileId))

  // Get the profile ID this instance was launched with (--profile= argument)
  ipcMain.handle('app:get-launch-profile', () => launchProfileId)
  ipcMain.handle('app:get-window-id', (event) => getWindowIdByWebContents(event.sender))
  // Get the profile ID bound to this window's registry entry
  ipcMain.handle('app:get-window-profile', async (event) => {
    const windowId = getWindowIdByWebContents(event.sender)
    if (!windowId) return null
    const entry = await windowRegistry.getEntry(windowId)
    return entry?.profileId ?? null
  })
  // Get this window's index within its profile (1-based)
  ipcMain.handle('app:get-window-index', async (event) => {
    const windowId = getWindowIdByWebContents(event.sender)
    if (!windowId) return 1
    const entries = await windowRegistry.readAll()
    const entry = entries.find(e => e.id === windowId)
    if (!entry?.profileId) return 1
    const sameProfile = entries.filter(e => e.profileId === entry.profileId)
    return sameProfile.findIndex(e => e.id === windowId) + 1
  })

  // Dock badge count (macOS/Linux)
  ipcMain.handle('app:set-dock-badge', (_event, count: number) => {
    if (process.platform === 'darwin') {
      app.dock.setBadge(count > 0 ? String(count) : '')
    } else if (process.platform === 'linux') {
      app.setBadgeCount(count)
    }
  })

  // Open new empty window (Cmd+N) — inherits profileId from source window
  ipcMain.handle('app:new-window', async (event) => {
    let profileId: string | undefined
    const sourceWindowId = getWindowIdByWebContents(event.sender)
    if (sourceWindowId) {
      const sourceEntry = await windowRegistry.getEntry(sourceWindowId)
      profileId = sourceEntry?.profileId
    }
    const entry = await windowRegistry.createEntry({ profileId })
    createWindow(entry.id)
    return entry.id
  })

  ipcMain.handle('app:focus-next-window', (event) => {
    return focusNextAppWindow(event.sender)
  })

  // ─── Notification center ────────────────────────────────────────
  // Resolve profileId → windowId for incoming notifications
  notificationCenter.setWindowResolver((profileId) => {
    if (!profileId) return null
    const entries = windowRegistry.getCachedEntries()
    const matchIds = entries.filter(e => e.profileId === profileId).map(e => e.id)
    for (const id of matchIds) {
      const win = windowMap.get(id)
      if (win && !win.isDestroyed()) return id
    }
    // No live window for the profile — pick the most recent matching entry
    const sorted = entries.filter(e => e.profileId === profileId).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return sorted[0]?.id ?? null
  })

  // Broadcast list updates to all windows (cross-window state sync)
  notificationCenter.on('change', (entries: NotificationEntry[]) => {
    for (const win of getAllWindows()) {
      try { win.webContents.send('notification:update', entries) } catch { /* ignore */ }
    }
  })

  ipcMain.handle('notification:list', () => notificationCenter.list())
  ipcMain.handle('notification:mark-read', (_event, id: string) => notificationCenter.markRead(id))
  ipcMain.handle('notification:mark-all-read', () => { notificationCenter.markAllRead(); return true })
  ipcMain.handle('notification:mark-window-read', (event) => {
    const wid = getWindowIdByWebContents(event.sender)
    if (wid) notificationCenter.markWindowRead(wid)
    return true
  })
  ipcMain.handle('notification:clear', () => { notificationCenter.clear(); return true })
  ipcMain.handle('notification:focus-latest-unread', () => {
    const entry = notificationCenter.getLatestUnread()
    if (!entry || !entry.windowId) return null
    const win = windowMap.get(entry.windowId)
    if (!win || win.isDestroyed()) return null
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    notificationCenter.markRead(entry.id)
    return { id: entry.id, windowId: entry.windowId }
  })
  ipcMain.handle('notification:focus-entry', (_event, id: string) => {
    const entry = notificationCenter.list().find(e => e.id === id)
    if (!entry || !entry.windowId) return null
    const win = windowMap.get(entry.windowId)
    if (!win || win.isDestroyed()) return null
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    notificationCenter.markRead(id)
    return { id, windowId: entry.windowId }
  })

  // Open profile windows (focus existing if already open, otherwise restore all from snapshot)
  ipcMain.handle('app:open-new-instance', async (_event, profileId: string) => {
    const entries = await windowRegistry.readAll()
    const existingForProfile = entries.filter(e => e.profileId === profileId)

    // If any windows already open for this profile, focus the most recent one
    const openWindows = existingForProfile.filter(e => {
      const win = windowMap.get(e.id)
      return win && !win.isDestroyed()
    })
    if (openWindows.length > 0) {
      const mostRecent = openWindows.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
      const win = windowMap.get(mostRecent.id)!
      if (win.isMinimized()) win.restore()
      win.focus()
      return { alreadyOpen: true, windowId: mostRecent.id }
    }

    // Mark profile as active
    await profileManager.activateProfile(profileId)

    // Load profile snapshot (handles both local and remote profiles)
    const result = await loadProfileSnapshotDetailed(profileId)
    if (result.kind === 'remote-unreachable') {
      showRemoteUnreachableDialog(result.host, result.port, result.label)
      await profileManager.deactivateProfile(profileId).catch(() => { /* ignore */ })
      return { alreadyOpen: false, windowIds: [], error: 'remote-unreachable' }
    }
    const snapshot = result.snapshot
    if (snapshot && snapshot.windows.length > 0) {
      const windowIds: string[] = []
      for (const winSnap of snapshot.windows) {
        const entry = await windowRegistry.createEntry({ profileId })
        entry.workspaces = winSnap.workspaces
        entry.activeWorkspaceId = winSnap.activeWorkspaceId
        entry.activeGroup = winSnap.activeGroup
        entry.terminals = winSnap.terminals
        entry.activeTerminalId = winSnap.activeTerminalId
        entry.bounds = winSnap.bounds
        await windowRegistry.saveEntry(entry)
        createWindow(entry.id, winSnap.bounds)
        windowIds.push(entry.id)
      }
      return { alreadyOpen: false, windowIds }
    }

    // Fallback: no snapshot data, open empty window
    const entry = await windowRegistry.createEntry({ profileId })
    createWindow(entry.id)
    return { alreadyOpen: false, windowIds: [entry.id] }
  })

  // Cross-window workspace move (re-index only, no session rebuild)
  ipcMain.handle('workspace:move-to-window', async (_event, sourceWindowId: string, targetWindowId: string, workspaceId: string, insertIndex: number) => {
    const sourceEntry = await windowRegistry.getEntry(sourceWindowId)
    const targetEntry = await windowRegistry.getEntry(targetWindowId)
    if (!sourceEntry || !targetEntry) return false
    const sourceRealm = await getWorkspaceMoveRealm(sourceEntry.profileId || null)
    const targetRealm = await getWorkspaceMoveRealm(targetEntry.profileId || null)
    if (sourceRealm !== targetRealm) {
      logger.warn(`[workspace] Refused cross-realm move ${workspaceId} from ${sourceWindowId} (${sourceRealm}) to ${targetWindowId} (${targetRealm})`)
      return false
    }

    // Find workspace in source
    const srcWorkspaces = sourceEntry.workspaces as any[]
    const wsIndex = srcWorkspaces.findIndex((w: any) => w.id === workspaceId)
    if (wsIndex === -1) return false
    const [workspace] = srcWorkspaces.splice(wsIndex, 1)

    // Move associated terminals (single pass)
    const movedTerminals: any[] = []
    const remainingTerminals: any[] = []
    for (const t of sourceEntry.terminals as any[]) {
      if (t.workspaceId === workspaceId) movedTerminals.push(t)
      else remainingTerminals.push(t)
    }
    sourceEntry.terminals = remainingTerminals

    // Insert workspace at target position
    const tgtWorkspaces = targetEntry.workspaces as any[]
    const clampedIndex = Math.min(insertIndex, tgtWorkspaces.length)
    tgtWorkspaces.splice(clampedIndex, 0, workspace)
    ;(targetEntry.terminals as any[]).push(...movedTerminals)

    // Fix activeWorkspaceId if the moved workspace was active in source
    if (sourceEntry.activeWorkspaceId === workspaceId) {
      sourceEntry.activeWorkspaceId = srcWorkspaces[0]?.id || null
    }
    // Set moved workspace as active in target
    targetEntry.activeWorkspaceId = workspaceId

    // Fix activeTerminalId in source if it belonged to the moved workspace
    const movedTerminalIds = new Set(movedTerminals.map((t: any) => t.id))
    if (sourceEntry.activeTerminalId && movedTerminalIds.has(sourceEntry.activeTerminalId)) {
      sourceEntry.activeTerminalId = (sourceEntry.terminals as any[]).find((t: any) => t.workspaceId === sourceEntry.activeWorkspaceId)?.id || null
    }
    targetEntry.activeTerminalId =
      (workspace as { focusedTerminalId?: string | null }).focusedTerminalId && movedTerminalIds.has((workspace as { focusedTerminalId?: string | null }).focusedTerminalId)
        ? (workspace as { focusedTerminalId: string }).focusedTerminalId
        : movedTerminals[0]?.id || null

    // Save both entries
    sourceEntry.lastActiveAt = Date.now()
    targetEntry.lastActiveAt = Date.now()
    await windowRegistry.saveEntry(sourceEntry)
    await windowRegistry.saveEntry(targetEntry)
    if (sourceEntry.profileId) {
      await profileManager.save(sourceEntry.profileId).catch(() => { /* ignore */ })
    }

    // Notify both renderers to reload
    const sourceWin = windowMap.get(sourceWindowId)
    const targetWin = windowMap.get(targetWindowId)
    if (sourceWin && !sourceWin.isDestroyed()) sourceWin.webContents.send('workspace:reload')
    if (targetWin && !targetWin.isDestroyed()) targetWin.webContents.send('workspace:reload')

    logger.log(`[workspace] Moved workspace ${workspaceId} from ${sourceWindowId} to ${targetWindowId}`)
    return true
  })

  // Workspace detach/reattach (local window management)
  ipcMain.handle('workspace:detach', async (event, workspaceId: string) => {
    if (detachedWindows.has(workspaceId)) {
      const existing = detachedWindows.get(workspaceId)!
      if (!existing.isDestroyed()) existing.focus()
      return true
    }
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const detachedWin = new BrowserWindow({
      width: 900, height: 700, minWidth: 600, minHeight: 400,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
      frame: true, titleBarStyle: 'default', icon: nativeImage.createFromPath(path.join(__dirname, process.platform === 'win32' ? '../assets/icon.ico' : '../assets/icon.png'))
    })
    setupCopyShortcutForwarding(detachedWin)
    attachWindowLoadDiagnostics(detachedWin, `detached-${workspaceId}`)
    setupResizeThrottle(detachedWin, 'detached')
    detachedWindows.set(workspaceId, detachedWin)
    const urlParam = `?detached=${encodeURIComponent(workspaceId)}`
    if (VITE_DEV_SERVER_URL) { detachedWin.loadURL(VITE_DEV_SERVER_URL + urlParam) }
    else { detachedWin.loadFile(path.join(__dirname, '../dist/index.html'), { search: urlParam }) }
    detachedWin.on('closed', () => {
      detachedWindows.delete(workspaceId)
      if (parentWin && !parentWin.isDestroyed()) parentWin.webContents.send('workspace:reattached', workspaceId)
    })
    if (parentWin && !parentWin.isDestroyed()) parentWin.webContents.send('workspace:detached', workspaceId)
    return true
  })

  ipcMain.handle('workspace:reattach', async (_event, workspaceId: string) => {
    const win = detachedWindows.get(workspaceId)
    if (win && !win.isDestroyed()) win.close()
    detachedWindows.delete(workspaceId)
    return true
  })

  // ── Worker buffer file operations ──
  const wbDir = path.join(app.getPath('userData'), 'worker-buffers')
  const workerBufferPath = (panelId: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(panelId)) {
      throw new Error('Invalid worker buffer id')
    }
    return path.join(wbDir, `${panelId}.jsonl`)
  }

  ipcMain.handle('worker-buffer:init', async (_event, panelId: string) => {
    await fs.mkdir(wbDir, { recursive: true })
    await fs.writeFile(workerBufferPath(panelId), '', 'utf-8')
  })

  ipcMain.handle('worker-buffer:append', async (_event, panelId: string, lines: string) => {
    await fs.appendFile(workerBufferPath(panelId), lines, 'utf-8')
  })

  ipcMain.handle('worker-buffer:readAll', async (_event, panelId: string) => {
    try {
      return await fs.readFile(workerBufferPath(panelId), 'utf-8')
    } catch { return '' }
  })

  ipcMain.handle('worker-buffer:clear', async (_event, panelId: string) => {
    try { await fs.unlink(workerBufferPath(panelId)) } catch { /* ignore */ }
  })
}

// ── Worker buffer cleanup on startup ──
const workerBufferDir = path.join(app.getPath('userData'), 'worker-buffers')
fs.rm(workerBufferDir, { recursive: true, force: true }).catch(() => {})

// ── Initialize all IPC ──
const _t0 = Date.now()
registerProxiedHandlers({
  getPtyManager: () => ptyManager,
  getClaudeManager: () => claudeManager,
  getCodexManager: () => codexManager,
  sessionManagerMap,
  windowRegistry,
  profileManager,
})
bindProxiedHandlersToIpc()
registerLocalHandlers()
console.log(`[startup] IPC registration: ${Date.now() - _t0}ms`)
