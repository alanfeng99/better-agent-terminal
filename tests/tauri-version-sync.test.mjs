import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const tauriConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))

assert.equal(
  tauriConfig.version,
  packageJson.version,
  'src-tauri/tauri.conf.json version must match package.json before preview release',
)

console.log('tauri-version-sync: passed')
