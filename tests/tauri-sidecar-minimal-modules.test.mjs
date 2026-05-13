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

const anthropicModules = new URL('../node-sidecar/dist-node_modules/@anthropic-ai', import.meta.url)
const openaiModules = new URL('../node-sidecar/dist-node_modules/@openai', import.meta.url)
let anthropicPackages = []
let openaiPackages = []
try {
  anthropicPackages = await readdir(anthropicModules)
} catch (err) {
  if (err?.code === 'ENOENT') {
    console.log('tauri-sidecar-minimal-modules: skipped (run prepare:tauri-bundle first)')
    process.exit(0)
  }
  throw err
}
try {
  openaiPackages = await readdir(openaiModules)
} catch (err) {
  if (err?.code !== 'ENOENT') throw err
}

assert.ok(
  anthropicPackages.some((name) => /^claude-agent-sdk-(win32|darwin|linux)-/.test(name)),
  'minimal sidecar node_modules must retain the platform Claude native package',
)
assert.ok(
  !anthropicPackages.includes('claude-agent-sdk'),
  'minimal sidecar node_modules should not contain the JS Claude SDK package',
)
assert.ok(
  !openaiPackages.some((name) => /^codex-(win32|darwin|linux)-/.test(name)),
  'minimal sidecar node_modules must not contain Codex native packages',
)
assert.ok(
  !openaiPackages.includes('codex') && !openaiPackages.includes('codex-sdk'),
  'minimal sidecar node_modules should not contain Codex JS packages',
)

const codexRuntimeBinary = new URL(`../codex-runtime/${process.platform === 'win32' ? 'codex.exe' : 'codex'}`, import.meta.url)
const codexRuntimeInfo = await stat(codexRuntimeBinary)
assert.ok(codexRuntimeInfo.size > 1024 * 1024, 'Codex app-server runtime should be packaged outside sidecar node_modules')

const server = join(root, 'node-sidecar', 'dist', 'server.mjs')
const serverInfo = await stat(server)
assert.ok(serverInfo.size > 1024 * 1024, 'bundled sidecar should include JS dependencies')

console.log('tauri-sidecar-minimal-modules: passed')
