// Host API adapter.
//
// Renderer code should import { host } from this module instead of reading
// window.batAppAPI directly. The adapter delegates straight to
// window.batAppAPI under Electron and routes ported namespaces through
// tauri-invoke commands under Tauri. Anything that isn't ported yet
// throws a clear "not yet implemented" error so missing coverage fails
// loudly instead of silently no-oping.
//
// Runtime selection happens via getHostKind() — Electron is detected by the
// presence of window.batAppAPI, Tauri by window.__TAURI_INTERNALS__ (the
// stable detection hook for tauri 2.x; we also accept the legacy __TAURI__
// global so older shells keep working). Neither implies the other; we never
// fall back silently.

// Pull the surface type from the global declaration (src/types/electron.d.ts)
// rather than importing it directly from electron/preload, so we don't drag
// the renderer tsconfig into a project reference rebuild every time the
// preload changes.
type BatAppAPI = Window['batAppAPI']

export type HostKind = 'electron' | 'tauri' | 'unknown'

interface TauriInternals { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }

export function getHostKind(): HostKind {
  if (typeof globalThis === 'undefined') return 'unknown'
  const g = globalThis as unknown as { window?: unknown }
  const win = g.window as (TauriInternals & { batAppAPI?: unknown }) | undefined
  if (!win) return 'unknown'
  if (win.batAppAPI) return 'electron'
  if (win.__TAURI_INTERNALS__ !== undefined || win.__TAURI__ !== undefined) return 'tauri'
  return 'unknown'
}

export const isElectron = (): boolean => getHostKind() === 'electron'
export const isTauri = (): boolean => getHostKind() === 'tauri'

// The Tauri impl never changes shape so we lazily memoise it; the Electron
// API is resolved on every access so renderer reloads (or test scenarios
// that swap `window`) pick up the fresh reference without a manual reset.
let tauriImpl: BatAppAPI | null = null

function resolveHost(): BatAppAPI {
  const kind = getHostKind()
  if (kind === 'electron') {
    const api = (globalThis as unknown as { window?: { batAppAPI?: BatAppAPI } }).window?.batAppAPI
    if (!api) throw new Error('host-api: electron runtime detected but window.batAppAPI is missing')
    return api
  }
  if (kind === 'tauri') {
    if (!tauriImpl) tauriImpl = createTauriHost()
    return tauriImpl
  }
  throw new Error('host-api: no host runtime detected (neither Electron nor Tauri)')
}

// Single proxy so callers can keep a stable reference. Property reads forward
// to the resolved host object on each access — cheap, and safe across HMR
// reloads where the underlying impl might be swapped.
export const host: BatAppAPI = new Proxy({} as BatAppAPI, {
  get(_target, prop) {
    const target = resolveHost() as unknown as Record<string | symbol, unknown>
    return target[prop]
  },
}) as BatAppAPI

// --- Tauri implementation ----------------------------------------------------
//
// Each ported namespace lives in its own factory so adding the next one is a
// localised change. Anything unported delegates to a "not implemented" stub.

function notImplemented(name: string): never {
  throw new Error(`host-api: ${name} is not yet implemented under Tauri`)
}

// We import @tauri-apps/api lazily so nothing in this module pulls Tauri's
// runtime when we're under Electron — the tree-shaker can keep it out of the
// renderer bundle entirely if isTauri() is never true at build time.
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
function getInvoke(): Invoke {
  // Resolved synchronously through the Tauri-injected window global. We do
  // NOT cache because the global gets swapped during HMR and tests, and
  // the property read is cheap.
  const g = (globalThis as unknown as { window?: { __TAURI_INTERNALS__?: { invoke: Invoke } } }).window
  const direct = g?.__TAURI_INTERNALS__?.invoke
  if (direct) return direct
  throw new Error('host-api: tauri invoke not available; ensure window.__TAURI_INTERNALS__ is present')
}

function createTauriHost(): BatAppAPI {
  // Build a partial implementation: only ported namespaces are real; the rest
  // throw via a Proxy so missing coverage fails loudly.
  const ported: Record<string, unknown> = {
    settings: {
      load: () => getInvoke()<string | null>('settings_load'),
      save: (data: string) => getInvoke()<void>('settings_save', { data }),
      // Tauri auto-camelCases Rust args, so `shell_type: String` lands as
      // `shellType` in the invoke payload.
      getShellPath: (shell: string) =>
        getInvoke()<string>('settings_get_shell_path', { shellType: shell }),
      // Not yet ported — defer to Electron-shaped errors so callers see a
      // consistent failure mode.
      clearTerminalHistory: () => notImplemented('settings.clearTerminalHistory'),
      detectCx: () => notImplemented('settings.detectCx'),
    },
    shell: {
      openExternal: (url: string) => getInvoke()<void>('shell_open_external', { url }),
      openPath: (path: string) => getInvoke()<void>('shell_open_path', { path }),
      getPathForFile: () => notImplemented('shell.getPathForFile'),
    },
    dialog: {
      confirm: (message: string, title?: string) =>
        getInvoke()<boolean>('dialog_confirm', { message, title }),
      selectFolder: () => getInvoke()<string[] | null>('dialog_select_folder'),
      selectImages: () => getInvoke()<string[]>('dialog_select_images'),
      selectFiles: () => getInvoke()<string[]>('dialog_select_files'),
    },
    clipboard: {
      writeText: (text: string) => getInvoke()<boolean>('clipboard_write_text', { text }),
      // Image clipboard requires a separate raw-bytes bridge; not ported yet.
      saveImage: () => notImplemented('clipboard.saveImage'),
      writeImage: () => notImplemented('clipboard.writeImage'),
      onCopyShortcut: () => notImplemented('clipboard.onCopyShortcut'),
    },
    image: {
      readAsDataUrl: (filePath: string) =>
        getInvoke()<string>('image_read_as_data_url', { path: filePath }),
      // saveDataUrl needs a save-file picker + raw bytes write; pending.
      saveDataUrl: () => notImplemented('image.saveDataUrl'),
    },
    fs: {
      readFile: (filePath: string) =>
        getInvoke()<{ content?: string; error?: string; size?: number }>(
          'fs_read_file',
          { path: filePath },
        ),
      readdir: (dirPath: string) =>
        getInvoke()<{ name: string; path: string; isDirectory: boolean }[]>(
          'fs_readdir',
          { dirPath },
        ),
      home: () => getInvoke()<string>('fs_home'),
      listDirs: (dirPath: string, includeHidden: boolean) =>
        getInvoke()<
          | { current: string; parent: string | null; entries: { name: string; path: string }[] }
          | { error: string }
        >('fs_list_dirs', { dirPath, includeHidden }),
      mkdir: (parentPath: string, name: string) =>
        getInvoke()<{ path: string } | { error: string }>('fs_mkdir', { parentPath, name }),
      deletePath: (targetPath: string) =>
        getInvoke()<{ path: string } | { error: string }>('fs_delete_path', { targetPath }),
      quickLocations: () =>
        getInvoke()<{ name: string; path: string; kind: 'home' | 'drive' | 'volume' | 'root' }[]>(
          'fs_quick_locations',
        ),
      search: (dirPath: string, query: string) =>
        getInvoke()<{ name: string; path: string; isDirectory: boolean }[]>(
          'fs_search',
          { dirPath, query },
        ),
      // Watcher + path-link resolution are not ported yet — they need an
      // event-streaming bridge and language-aware path heuristics
      // respectively.
      resolvePathLinks: () => notImplemented('fs.resolvePathLinks'),
      watch: () => notImplemented('fs.watch'),
      unwatch: () => notImplemented('fs.unwatch'),
      onChanged: () => notImplemented('fs.onChanged'),
    },
  }

  return new Proxy({}, {
    get(_target, prop) {
      const key = String(prop)
      if (key in ported) return ported[key]
      // Synthesise a nested namespace proxy so calls like host.foo.bar()
      // produce a useful error instead of TypeError on undefined access.
      return new Proxy({}, {
        get(_t, sub) { notImplemented(`${key}.${String(sub)}`) },
      })
    },
  }) as BatAppAPI
}

// Permissive shim used to keep the React tree alive while we port the rest
// of the host surface. Unlike createTauriHost(), this version returns
// best-effort no-op values for unimplemented methods so synchronous reads
// during render (e.g. window.batAppAPI.platform, getDetachedId(),
// onSomething(cb)) don't blow up. Each unported access logs once via
// console.warn so the gap is visible in DevTools.
//
// Wire via installTauriShim() from main.tsx — it is intentionally NOT the
// default behaviour of `host`, because tests and ported call sites should
// continue to fail loudly instead of silently no-oping.

function detectPlatform(): 'win32' | 'darwin' | 'linux' {
  if (typeof navigator === 'undefined') return 'linux'
  const p = (navigator as { platform?: string }).platform || ''
  if (/win/i.test(p)) return 'win32'
  if (/mac/i.test(p)) return 'darwin'
  return 'linux'
}

const warned = new Set<string>()
function warnOnce(name: string): void {
  if (warned.has(name)) return
  warned.add(name)
  // eslint-disable-next-line no-console
  console.warn(`host-api: ${name} called under Tauri but not yet implemented; returning a no-op value`)
}

function permissiveValueFor(name: string, asFunction = true): unknown {
  warnOnce(name)
  if (!asFunction) return null
  // Return a function that lazily resolves to null/Promise<null> so both
  // sync and async callers get a sensible shape. Listener registrations
  // (on*) are usually unsubscribers; we return a no-op for those.
  if (name.includes('.on')) return () => () => {}
  return (..._args: unknown[]) => {
    // Heuristic: methods named getX, listX, fetchX, loadX, saveX etc. tend
    // to be promise-returning. We can't tell statically, so default to a
    // resolved promise — synchronous callers can still chain .then() on a
    // promise.
    return Promise.resolve(null)
  }
}

// Namespaces whose methods are routed through Tauri invoke. Listed here so
// the permissive shim can prefer the real impl when present.
const PORTED_NAMESPACES = new Set(['settings', 'shell', 'dialog', 'fs', 'clipboard', 'image'])

export function installTauriShim(): void {
  if (getHostKind() !== 'tauri') return
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window
  if (!win || win.batAppAPI) return
  const real = createTauriHost() as unknown as Record<string, unknown>
  const platform = detectPlatform()
  const shim = new Proxy({}, {
    get(_t, prop) {
      const key = String(prop)
      if (key === 'platform') return platform
      if (key === 'systemVersion') return ''
      if (PORTED_NAMESPACES.has(key)) return real[key]
      // Build a nested namespace proxy that returns permissive values.
      return new Proxy({}, {
        get(_n, sub) {
          const subKey = String(sub)
          // getDetachedId is the one synchronous method preload.ts exposes
          // that the renderer reads during initial render — return null so
          // React doesn't choke.
          if (key === 'workspace' && subKey === 'getDetachedId') {
            return () => { warnOnce('workspace.getDetachedId'); return null }
          }
          return permissiveValueFor(`${key}.${subKey}`)
        },
      })
    },
  })
  win.batAppAPI = shim
}
