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

// Tauri's event bus is async (`listen()` returns Promise<UnlistenFn>) but
// the Electron preload contract is `onX(cb): () => void`. We adapt by
// resolving listen() synchronously through the Tauri-injected globals,
// which expose a `listen` helper alongside `invoke`. Returning an
// unsubscribe function that awaits the underlying promise is enough — any
// events that fire before the promise resolves will queue at Tauri's
// dispatch layer, so callers don't need to await registration.
type UnlistenFn = () => void
type ListenEvent<T> = { event: string; payload: T; id: number }
type ListenFn = <T>(
  event: string,
  handler: (event: ListenEvent<T>) => void,
) => Promise<UnlistenFn>

function getListen(): ListenFn {
  type Win = { __TAURI_INTERNALS__?: unknown }
  const g = (globalThis as unknown as { window?: Win }).window
  if (!g?.__TAURI_INTERNALS__) {
    throw new Error('host-api: tauri listen not available; ensure window.__TAURI_INTERNALS__ is present')
  }
  // Lazy import: the `@tauri-apps/api/event` module reads
  // window.__TAURI_INTERNALS__ on call, so this only runs under Tauri.
  // We wrap it in a thunk so the import isn't pulled into Electron bundles
  // that never call host.pty.onOutput / onExit.
  return ((event: string, handler: (e: ListenEvent<unknown>) => void) =>
    import('@tauri-apps/api/event').then(m => m.listen(event, handler))
  ) as ListenFn
}

function listenAdapter<T>(
  event: string,
  cb: (payload: T) => void,
): UnlistenFn {
  let unlisten: UnlistenFn | null = null
  let cancelled = false
  getListen()<T>(event, e => cb(e.payload))
    .then(fn => {
      if (cancelled) fn()
      else unlisten = fn
    })
    .catch(() => { /* ignore — listen failed; caller already has noop */ })
  return () => {
    cancelled = true
    if (unlisten) unlisten()
  }
}

type PtyOutputPayload = { id: string; data: string }
type PtyExitPayload = { id: string; exitCode: number }
type NotificationEntry = {
  id: string
  sessionId: string
  windowId: string | null
  profileId: string | null
  workspaceName: string
  cwd: string
  reason: 'completed' | 'error' | 'aborted'
  result?: string
  error?: string
  timestamp: number
  read: boolean
  agentKind?: 'claude' | 'codex' | 'openai'
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
    update: {
      getVersion: () => getInvoke()<string>('update_get_version'),
      // GitHub release polling lives in Phase 3 (packaging) — until the
      // signing pipeline is rebuilt under Tauri there's no point checking.
      check: () => notImplemented('update.check'),
    },
    debug: {
      // Renderer logs forward to the Rust side, which currently writes to
      // stderr. A future commit can route this into <app-data>/logs/.
      log: (...args: unknown[]) => getInvoke()<void>('debug_log', { args }),
      // The renderer reads this synchronously during render.
      isDebugMode: false,
    },
    workspace: {
      load: () => getInvoke()<string | null>('workspace_load'),
      save: (data: string) => getInvoke()<boolean>('workspace_save', { data }),
      // Multi-window features are intentionally unported — the Tauri MVP
      // is single-window. They throw "not implemented" under Tauri.
      detach: () => notImplemented('workspace.detach'),
      reattach: () => notImplemented('workspace.reattach'),
      moveToWindow: () => notImplemented('workspace.moveToWindow'),
      // Synchronous query the renderer reads during initial render — the
      // Tauri build never opens a detached child window, so always null.
      getDetachedId: () => null,
      onDetached: () => () => {},
      onReattached: () => () => {},
    },
    snippet: {
      // JSON-backed env snippet store. Mirrors
      // electron/snippet-db.ts. Tauri auto-camelCases struct field
      // names, so e.g. CreateSnippetInput.workspace_id surfaces as
      // workspaceId in the invoke payload.
      getAll: () => getInvoke()<unknown[]>('snippet_get_all'),
      getById: (id: number) => getInvoke()<unknown>('snippet_get_by_id', { id }),
      getFavorites: () => getInvoke()<unknown[]>('snippet_get_favorites'),
      search: (query: string) => getInvoke()<unknown[]>('snippet_search', { query }),
      getByWorkspace: (workspaceId?: string) =>
        getInvoke()<unknown[]>('snippet_get_by_workspace', { workspaceId }),
      getCategories: () => getInvoke()<string[]>('snippet_get_categories'),
      create: (input: unknown) => getInvoke()<unknown>('snippet_create', { input }),
      update: (id: number, updates: unknown) =>
        getInvoke()<unknown>('snippet_update', { id, updates }),
      delete: (id: number) => getInvoke()<boolean>('snippet_delete', { id }),
      toggleFavorite: (id: number) =>
        getInvoke()<unknown>('snippet_toggle_favorite', { id }),
    },
    notification: {
      // In-memory store on the Rust side — see
      // src-tauri/src/commands/notification.rs. Push updates fire
      // via the "notification:update" Tauri event.
      list: () => getInvoke()<NotificationEntry[]>('notification_list'),
      markRead: (id: string) => getInvoke()<boolean>('notification_mark_read', { id }),
      markAllRead: () => getInvoke()<boolean>('notification_mark_all_read'),
      markWindowRead: () => getInvoke()<boolean>('notification_mark_window_read'),
      clear: () => getInvoke()<boolean>('notification_clear'),
      focusLatestUnread: () =>
        getInvoke()<{ id: string; windowId: string } | null>('notification_focus_latest_unread'),
      focusEntry: (id: string) =>
        getInvoke()<{ id: string; windowId: string } | null>('notification_focus_entry', { id }),
      onUpdate: (cb: (entries: NotificationEntry[]) => void) =>
        listenAdapter<NotificationEntry[]>('notification:update', cb),
    },
    system: {
      // Sleep/wake detection isn't wired up on the Tauri side yet —
      // tauri-plugin-os surfaces platform info but not power events.
      // Returning a no-op unsub keeps subscribers happy; the
      // Electron-side App.tsx handler that re-checks accounts on
      // resume just doesn't fire.
      onResume: (_cb: () => void) => () => {},
    },
    app: {
      // Single-window MVP: see src-tauri/src/commands/app.rs.
      getWindowId: () => getInvoke()<string | null>('app_get_window_id'),
      getWindowIndex: () => getInvoke()<number>('app_get_window_index'),
      getLaunchProfile: () => getInvoke()<string | null>('app_get_launch_profile'),
      getWindowProfile: () => getInvoke()<string | null>('app_get_window_profile'),
      newWindow: () => getInvoke()<string>('app_new_window'),
      focusNextWindow: () => getInvoke()<boolean>('app_focus_next_window'),
      openNewInstance: (profileId: string) =>
        getInvoke()<{ alreadyOpen: boolean }>('app_open_new_instance', { profileId }),
      setDockBadge: (count: number) => getInvoke()<void>('app_set_dock_badge', { count }),
    },
    github: {
      // gh CLI shell-out — see src-tauri/src/commands/github.rs.
      // Read commands return either parsed JSON (Value passes through
      // as `unknown`) or `{error: msg}` matching the Electron shape.
      checkCli: () =>
        getInvoke()<{ installed: boolean; authenticated: boolean }>('github_check_cli'),
      listPRs: (cwd: string) => getInvoke()<unknown>('github_pr_list', { cwd }),
      listIssues: (cwd: string) => getInvoke()<unknown>('github_issue_list', { cwd }),
      viewPR: (cwd: string, number: number) =>
        getInvoke()<unknown>('github_pr_view', { cwd, number }),
      viewIssue: (cwd: string, number: number) =>
        getInvoke()<unknown>('github_issue_view', { cwd, number }),
      commentPR: (cwd: string, number: number, body: string) =>
        getInvoke()<{ success: true } | { error: string }>(
          'github_pr_comment',
          { cwd, number, body },
        ),
      commentIssue: (cwd: string, number: number, body: string) =>
        getInvoke()<{ success: true } | { error: string }>(
          'github_issue_comment',
          { cwd, number, body },
        ),
    },
    git: {
      // Read-only git wrappers — see src-tauri/src/commands/git.rs.
      // The Rust side returns safe defaults (None / empty Vec / empty String)
      // when git fails or the cwd isn't a repo, mirroring the Electron handlers.
      getGithubUrl: (folderPath: string) =>
        getInvoke()<string | null>('git_get_github_url', { folderPath }),
      getBranch: (cwd: string) =>
        getInvoke()<string | null>('git_get_branch', { cwd }),
      getLog: (cwd: string, count?: number) =>
        getInvoke()<{ hash: string; author: string; date: string; message: string }[]>(
          'git_get_log',
          { cwd, count },
        ),
      getDiff: (cwd: string, commitHash?: string, filePath?: string) =>
        getInvoke()<string>('git_get_diff', { cwd, commitHash, filePath }),
      getDiffFiles: (cwd: string, commitHash?: string) =>
        getInvoke()<{ status: string; file: string }[]>(
          'git_get_diff_files',
          { cwd, commitHash },
        ),
      getRoot: (cwd: string) =>
        getInvoke()<string | null>('git_get_root', { cwd }),
      getStatus: (cwd: string) =>
        getInvoke()<{ status: string; file: string }[]>('git_get_status', { cwd }),
    },
    pty: {
      create: (options: unknown) =>
        getInvoke()<string>('pty_create', { options: options as Record<string, unknown> }),
      write: (id: string, data: string) => getInvoke()<void>('pty_write', { id, data }),
      resize: (id: string, cols: number, rows: number) =>
        getInvoke()<void>('pty_resize', { id, cols, rows }),
      kill: (id: string) => getInvoke()<void>('pty_kill', { id }),
      // restart / getCwd are not yet ported — they need child-process
      // tracking that's substantially more involved on Windows ConPTY.
      restart: () => notImplemented('pty.restart'),
      getCwd: () => notImplemented('pty.getCwd'),
      onOutput: (callback: (id: string, data: string) => void) =>
        listenAdapter<PtyOutputPayload>('pty:output', p => callback(p.id, p.data)),
      onExit: (callback: (id: string, exitCode: number) => void) =>
        listenAdapter<PtyExitPayload>('pty:exit', p => callback(p.id, p.exitCode)),
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
const PORTED_NAMESPACES = new Set([
  'settings', 'shell', 'dialog', 'fs', 'clipboard', 'image',
  'pty', 'workspace', 'update', 'debug', 'git', 'app',
  'notification', 'system', 'github', 'snippet',
])

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
