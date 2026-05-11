import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))

assert.equal(
  config?.bundle?.resources?.['../node-sidecar/dist-node_modules/'],
  'node-sidecar/node_modules/',
  'Tauri should package the minimal sidecar node_modules tree',
)
assert.equal(
  config?.bundle?.resources?.['../node-sidecar/node_modules/'],
  undefined,
  'Tauri should not package the full sidecar node_modules tree',
)

const distModules = new URL('../node-sidecar/dist-node_modules/@anthropic-ai', import.meta.url)
let packages = []
try {
  packages = await readdir(distModules)
} catch (err) {
  if (err?.code === 'ENOENT') {
    console.log('tauri-sidecar-minimal-modules: skipped (run prepare:tauri-bundle first)')
    process.exit(0)
  }
  throw err
}

assert.ok(
  packages.some((name) => /^claude-agent-sdk-(win32|darwin|linux)-/.test(name)),
  'minimal sidecar node_modules must retain the platform Claude native package',
)
assert.ok(
  !packages.includes('claude-agent-sdk'),
  'minimal sidecar node_modules should not contain the JS Claude SDK package',
)

const server = join(root, 'node-sidecar', 'dist', 'server.mjs')
const serverInfo = await stat(server)
assert.ok(serverInfo.size > 1024 * 1024, 'bundled sidecar should include JS dependencies')

console.log('tauri-sidecar-minimal-modules: passed')
