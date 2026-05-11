import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const tauriConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const nsis = tauriConfig?.bundle?.windows?.nsis

assert.equal(nsis?.installMode, 'currentUser', 'Tauri NSIS must keep Electron-compatible per-user install mode')
assert.equal(nsis?.installerHooks, 'windows/nsis-hooks.nsh', 'Tauri NSIS must load the installer hook')

const hook = await readFile(new URL('../src-tauri/windows/nsis-hooks.nsh', import.meta.url), 'utf8')

assert.match(
  hook,
  /LOCALAPPDATA\\Programs\\BetterAgentTerminal/,
  'Tauri NSIS default install directory should match Electron Builder',
)
assert.match(
  hook,
  /LOCALAPPDATA\\BetterAgentTerminal/,
  'Tauri NSIS hook should only rewrite the Tauri default directory',
)

console.log('tauri-windows-installer: passed')
