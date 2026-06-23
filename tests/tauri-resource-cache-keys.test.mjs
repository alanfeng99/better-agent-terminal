import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const { stdout } = await execFileAsync(process.execPath, ['scripts/tauri-resource-cache-keys.mjs'])
const keys = Object.fromEntries(
  stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('=')),
)

for (const name of ['sidecar_native_modules', 'codex_runtime', 'node_runtime']) {
  assert.match(keys[name], /^[a-f0-9]{24}$/, `${name} should be a stable short sha256 key`)
}

assert.notEqual(keys.sidecar_native_modules, keys.codex_runtime)
console.log('tauri-resource-cache-keys: passed')
