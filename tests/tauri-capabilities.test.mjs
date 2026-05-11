import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const raw = await readFile(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8')
const capability = JSON.parse(raw)
const windows = capability.windows || []

assert.ok(windows.includes('main'), 'main window must keep renderer capability')
assert.ok(
  windows.includes('profile-*'),
  'Tauri profile windows created by Ctrl+N/app.openNewInstance need renderer capability',
)
assert.ok(
  windows.includes('detached-*'),
  'Tauri detached workspace windows need renderer capability',
)
assert.ok(
  capability.permissions?.includes('core:default'),
  'dynamic renderer windows need core invoke/event/window permissions',
)

console.log('tauri-capabilities: passed')
