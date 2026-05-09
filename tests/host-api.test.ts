// Unit tests for src/host-api.ts.
//
// Run with: pnpm exec tsx tests/host-api.test.ts
// (or via the test:host-api script).

import * as assert from 'node:assert/strict'

// jsdom-free: we synthesise a globalThis.window that the adapter inspects.
type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
type WinShape = {
  batAppAPI?: unknown
  __TAURI_INTERNALS__?: { invoke?: TauriInvoke }
  __TAURI__?: unknown
}
const setWindow = (shape: WinShape | undefined) => {
  ;(globalThis as { window?: WinShape | undefined }).window = shape
}

// Force a fresh module per scenario so the adapter's cached host gets reset.
async function loadFreshAdapter() {
  const url = new URL('../src/host-api.ts', import.meta.url)
  const cacheBust = `${url.href}?t=${Date.now()}-${Math.random()}`
  return import(cacheBust)
}

async function run() {
  // 1) No window -> getHostKind === 'unknown'
  setWindow(undefined)
  {
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'unknown')
    assert.equal(mod.isElectron(), false)
    assert.equal(mod.isTauri(), false)
    assert.throws(() => (mod.host as { settings: { load: () => unknown } }).settings.load(),
      /no host runtime detected/)
  }

  // 2) Electron detection + delegation
  {
    const calls: string[] = []
    const batAppAPI = {
      settings: {
        load: () => { calls.push('load'); return Promise.resolve('{}') },
      },
      shell: {
        openExternal: (url: string) => { calls.push(`open:${url}`); return Promise.resolve() },
      },
    }
    setWindow({ batAppAPI })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'electron')
    assert.equal(mod.isElectron(), true)
    assert.equal(mod.isTauri(), false)
    await mod.host.settings.load()
    await mod.host.shell.openExternal('https://example.com')
    assert.deepEqual(calls, ['load', 'open:https://example.com'])
  }

  // 3) Tauri detection routes ported namespaces through invoke
  {
    const invokeCalls: { cmd: string; args?: Record<string, unknown> }[] = []
    const invoke: TauriInvoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args })
      // Mirror Rust return shapes for the commands we care about.
      if (cmd === 'settings_load') return null as unknown as T
      if (cmd === 'settings_save') return undefined as unknown as T
      if (cmd === 'shell_open_external') return undefined as unknown as T
      if (cmd === 'shell_open_path') return undefined as unknown as T
      if (cmd === 'dialog_confirm') return true as unknown as T
      if (cmd === 'fs_read_file') return { content: 'hello' } as unknown as T
      if (cmd === 'settings_get_shell_path') return '/bin/zsh' as unknown as T
      if (cmd === 'dialog_select_folder') return ['C:/picked/folder'] as unknown as T
      if (cmd === 'dialog_select_files') return ['C:/picked/a.txt', 'C:/picked/b.txt'] as unknown as T
      if (cmd === 'dialog_select_images') return ['C:/picked/a.png'] as unknown as T
      if (cmd === 'clipboard_write_text') return true as unknown as T
      if (cmd === 'fs_home') return '/home/me' as unknown as T
      if (cmd === 'fs_readdir') return [{ name: 'src', path: '/x/src', isDirectory: true }] as unknown as T
      if (cmd === 'fs_list_dirs') return { current: '/x', parent: null, entries: [] } as unknown as T
      if (cmd === 'fs_mkdir') return { path: '/x/foo' } as unknown as T
      if (cmd === 'fs_delete_path') return { path: '/x/foo' } as unknown as T
      if (cmd === 'fs_quick_locations') return [{ name: 'Home', path: '/home/me', kind: 'home' }] as unknown as T
      if (cmd === 'fs_search') return [{ name: 'hit.txt', path: '/x/hit.txt', isDirectory: false }] as unknown as T
      if (cmd === 'image_read_as_data_url') return 'data:image/png;base64,xx' as unknown as T
      if (cmd === 'pty_create') return 'term-1' as unknown as T
      if (cmd === 'pty_write') return undefined as unknown as T
      if (cmd === 'pty_resize') return undefined as unknown as T
      if (cmd === 'pty_kill') return undefined as unknown as T
      if (cmd === 'workspace_load') return null as unknown as T
      if (cmd === 'workspace_save') return true as unknown as T
      throw new Error(`unexpected invoke: ${cmd}`)
    }
    setWindow({ __TAURI_INTERNALS__: { invoke } })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'tauri')
    assert.equal(mod.isElectron(), false)
    assert.equal(mod.isTauri(), true)

    const loaded = await mod.host.settings.load()
    assert.equal(loaded, null)

    await mod.host.settings.save('{"theme":"dark"}')
    await mod.host.shell.openExternal('https://example.com')
    await mod.host.shell.openPath('C:/Users/me/project')
    const ok = await mod.host.dialog.confirm('Proceed?', 'Heads up')
    assert.equal(ok, true)
    // title is optional — the adapter passes undefined through.
    await mod.host.dialog.confirm('Just a message')

    const fsResult = await mod.host.fs.readFile('C:/Users/me/notes.txt')
    assert.deepEqual(fsResult, { content: 'hello' })

    const shellPath = await mod.host.settings.getShellPath('zsh')
    assert.equal(shellPath, '/bin/zsh')

    const folder = await mod.host.dialog.selectFolder()
    assert.deepEqual(folder, ['C:/picked/folder'])
    const files = await mod.host.dialog.selectFiles()
    assert.deepEqual(files, ['C:/picked/a.txt', 'C:/picked/b.txt'])
    const images = await mod.host.dialog.selectImages()
    assert.deepEqual(images, ['C:/picked/a.png'])

    const wrote = await mod.host.clipboard.writeText('hello clipboard')
    assert.equal(wrote, true)

    const home = await mod.host.fs.home()
    assert.equal(home, '/home/me')
    const dirs = await mod.host.fs.readdir('/x')
    assert.deepEqual(dirs, [{ name: 'src', path: '/x/src', isDirectory: true }])
    const ls = await mod.host.fs.listDirs('/x', true)
    assert.deepEqual(ls, { current: '/x', parent: null, entries: [] })
    const made = await mod.host.fs.mkdir('/x', 'foo')
    assert.deepEqual(made, { path: '/x/foo' })
    const removed = await mod.host.fs.deletePath('/x/foo')
    assert.deepEqual(removed, { path: '/x/foo' })
    const ql = await mod.host.fs.quickLocations()
    assert.deepEqual(ql, [{ name: 'Home', path: '/home/me', kind: 'home' }])
    const found = await mod.host.fs.search('/x', 'hit')
    assert.deepEqual(found, [{ name: 'hit.txt', path: '/x/hit.txt', isDirectory: false }])

    const dataUrl = await mod.host.image.readAsDataUrl('/x/img.png')
    assert.equal(dataUrl, 'data:image/png;base64,xx')

    const ptyId = await mod.host.pty.create({
      id: 'term-1', cwd: '/x', type: 'terminal',
    } as unknown as Parameters<typeof mod.host.pty.create>[0])
    assert.equal(ptyId, 'term-1')
    await mod.host.pty.write('term-1', 'echo hi\n')
    await mod.host.pty.resize('term-1', 120, 32)
    await mod.host.pty.kill('term-1')

    const wsLoaded = await mod.host.workspace.load()
    assert.equal(wsLoaded, null)
    const wsSaved = await mod.host.workspace.save('{"workspaces":[]}')
    assert.equal(wsSaved, true)
    // workspace.getDetachedId is synchronous and always null under Tauri.
    assert.equal(mod.host.workspace.getDetachedId(), null)

    assert.deepEqual(invokeCalls, [
      { cmd: 'settings_load', args: undefined },
      { cmd: 'settings_save', args: { data: '{"theme":"dark"}' } },
      { cmd: 'shell_open_external', args: { url: 'https://example.com' } },
      { cmd: 'shell_open_path', args: { path: 'C:/Users/me/project' } },
      { cmd: 'dialog_confirm', args: { message: 'Proceed?', title: 'Heads up' } },
      { cmd: 'dialog_confirm', args: { message: 'Just a message', title: undefined } },
      { cmd: 'fs_read_file', args: { path: 'C:/Users/me/notes.txt' } },
      { cmd: 'settings_get_shell_path', args: { shellType: 'zsh' } },
      { cmd: 'dialog_select_folder', args: undefined },
      { cmd: 'dialog_select_files', args: undefined },
      { cmd: 'dialog_select_images', args: undefined },
      { cmd: 'clipboard_write_text', args: { text: 'hello clipboard' } },
      { cmd: 'fs_home', args: undefined },
      { cmd: 'fs_readdir', args: { dirPath: '/x' } },
      { cmd: 'fs_list_dirs', args: { dirPath: '/x', includeHidden: true } },
      { cmd: 'fs_mkdir', args: { parentPath: '/x', name: 'foo' } },
      { cmd: 'fs_delete_path', args: { targetPath: '/x/foo' } },
      { cmd: 'fs_quick_locations', args: undefined },
      { cmd: 'fs_search', args: { dirPath: '/x', query: 'hit' } },
      { cmd: 'image_read_as_data_url', args: { path: '/x/img.png' } },
      { cmd: 'pty_create', args: { options: { id: 'term-1', cwd: '/x', type: 'terminal' } } },
      { cmd: 'pty_write', args: { id: 'term-1', data: 'echo hi\n' } },
      { cmd: 'pty_resize', args: { id: 'term-1', cols: 120, rows: 32 } },
      { cmd: 'pty_kill', args: { id: 'term-1' } },
      { cmd: 'workspace_load', args: undefined },
      { cmd: 'workspace_save', args: { data: '{"workspaces":[]}' } },
    ])
  }

  // 4) Tauri detection still throws "not implemented" for unported namespaces
  {
    const invoke: TauriInvoke = async () => undefined as unknown as never
    setWindow({ __TAURI_INTERNALS__: { invoke } })
    const mod = await loadFreshAdapter()
    // git is still unported — use it as the canary for "namespace
    // not yet implemented" behaviour.
    assert.throws(() => (mod.host as { git: { status: () => unknown } }).git.status(),
      /git\.status is not yet implemented under Tauri/)
    // Within a ported namespace, individually unported entries (e.g.
    // pty.restart) still throw the same way.
    assert.throws(() => (mod.host as { pty: { restart: () => unknown } }).pty.restart(),
      /pty\.restart is not yet implemented under Tauri/)
  }

  // 5) Legacy __TAURI__ marker still works (detection only — invoke can't be
  //    resolved without __TAURI_INTERNALS__, so calls error clearly).
  {
    setWindow({ __TAURI__: {} })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'tauri')
    assert.throws(() => (mod.host as { settings: { load: () => unknown } }).settings.load(),
      /tauri invoke not available/)
  }

  // 6) Electron wins when both markers exist
  {
    setWindow({ batAppAPI: { ping: () => 'pong' }, __TAURI_INTERNALS__: { invoke: () => Promise.resolve(null) } })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'electron')
  }

  // 7) installTauriShim() lets unmigrated callsites no-op gracefully.
  //    - Ported APIs (settings.load) still go through invoke
  //    - Sync APIs return sensible defaults (workspace.getDetachedId -> null,
  //      platform -> detected)
  //    - Unknown async APIs return Promise.resolve(null)
  //    - Listener registrations (on*) return a no-op unsubscriber
  {
    const invokeCalls: string[] = []
    const invoke: TauriInvoke = async <T>(cmd: string) => {
      invokeCalls.push(cmd)
      return null as unknown as T
    }
    // No batAppAPI yet — the shim should install one.
    const win: WinShape = { __TAURI_INTERNALS__: { invoke } }
    setWindow(win)
    const mod = await loadFreshAdapter()
    mod.installTauriShim()
    const shimmed = (win as unknown as { batAppAPI?: Record<string, unknown> }).batAppAPI
    assert.ok(shimmed, 'installTauriShim should attach window.batAppAPI')

    // platform is synchronous and required by App.tsx during render
    const platform = (shimmed as { platform: string }).platform
    assert.ok(['win32', 'darwin', 'linux'].includes(platform), `unexpected platform: ${platform}`)

    // workspace.getDetachedId is synchronous; preload returns string|null
    const detached = (shimmed as { workspace: { getDetachedId: () => string | null } }).workspace.getDetachedId()
    assert.equal(detached, null)

    // Unknown async API returns Promise.resolve(null)
    const result = await (shimmed as { foo: { bar: () => Promise<unknown> } }).foo.bar()
    assert.equal(result, null)

    // Listener-style registration returns a no-op unsubscriber that itself returns void.
    const unsub = (shimmed as { pty: { onOutput: (cb: (...a: unknown[]) => void) => () => void } }).pty.onOutput(() => {})
    assert.equal(typeof unsub, 'function')
    assert.equal(unsub(), undefined)

    // Ported settings.load is still routed through invoke.
    await (shimmed as { settings: { load: () => Promise<unknown> } }).settings.load()
    assert.deepEqual(invokeCalls, ['settings_load'])
  }

  // 8) installTauriShim() is a no-op when not running under Tauri.
  {
    setWindow({ batAppAPI: { foo: 1 } })
    const mod = await loadFreshAdapter()
    mod.installTauriShim()
    const win = (globalThis as { window?: { batAppAPI: { foo: number } } }).window
    // The original batAppAPI is left alone.
    assert.equal(win?.batAppAPI?.foo, 1)
  }

  console.log('host-api: passed')
}

run().catch(err => {
  console.error(err)
  process.exitCode = 1
})
