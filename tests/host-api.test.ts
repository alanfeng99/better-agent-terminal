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

    assert.deepEqual(invokeCalls, [
      { cmd: 'settings_load', args: undefined },
      { cmd: 'settings_save', args: { data: '{"theme":"dark"}' } },
      { cmd: 'shell_open_external', args: { url: 'https://example.com' } },
      { cmd: 'shell_open_path', args: { path: 'C:/Users/me/project' } },
      { cmd: 'dialog_confirm', args: { message: 'Proceed?', title: 'Heads up' } },
      { cmd: 'dialog_confirm', args: { message: 'Just a message', title: undefined } },
      { cmd: 'fs_read_file', args: { path: 'C:/Users/me/notes.txt' } },
      { cmd: 'settings_get_shell_path', args: { shellType: 'zsh' } },
    ])
  }

  // 4) Tauri detection still throws "not implemented" for unported namespaces
  {
    const invoke: TauriInvoke = async () => undefined as unknown as never
    setWindow({ __TAURI_INTERNALS__: { invoke } })
    const mod = await loadFreshAdapter()
    assert.throws(() => (mod.host as { pty: { create: () => unknown } }).pty.create(),
      /pty\.create is not yet implemented under Tauri/)
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
