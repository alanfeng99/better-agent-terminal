#!/usr/bin/env node
// Validate the prepared Tauri preview bundle inputs. This complements
// verify:tauri-preview by checking the release staging artifacts that must
// exist before `tauri build` can produce a self-contained app.

import { access, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const requiredResourceSources = [
  '../node-sidecar/dist/server.mjs',
  '../node-sidecar/package.json',
  '../node-sidecar/node_modules/',
  '../node-sidecar/runtime/',
]

const runtimeExecutables = {
  'win32-x64': join('windows-x86_64', 'node.exe'),
  'darwin-x64': join('darwin-x86_64', 'bin', 'node'),
  'darwin-arm64': join('darwin-aarch64', 'bin', 'node'),
  'linux-x64': join('linux-x86_64', 'bin', 'node'),
  'linux-arm64': join('linux-aarch64', 'bin', 'node'),
}

function runtimeKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function fileSize(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

async function dirExists(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function loadResourceSources(configPath) {
  const raw = await readFile(configPath, 'utf8')
  const parsed = JSON.parse(raw)
  return new Set(Object.keys(parsed?.bundle?.resources || {}))
}

export async function collectTauriPreviewReadiness(options = {}) {
  const root = resolve(options.root || repoRoot)
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const key = runtimeKey(platform, arch)
  const runtimeRel = options.runtimeRel || runtimeExecutables[key]
  const configPath = options.configPath || join(root, 'src-tauri', 'tauri.conf.json')
  const sidecarRoot = join(root, 'node-sidecar')
  const checks = []

  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  const resourceSources = await loadResourceSources(configPath)
  for (const source of requiredResourceSources) {
    add(
      `resource:${source}`,
      resourceSources.has(source),
      resourceSources.has(source) ? 'configured' : 'missing from tauri.conf.json',
    )
  }

  const serverPath = join(sidecarRoot, 'dist', 'server.mjs')
  const serverBytes = await fileSize(serverPath)
  add('sidecar:dist-server', serverBytes > 0, `${serverBytes} bytes`)

  const sidecarPackagePath = join(sidecarRoot, 'package.json')
  add('sidecar:package-json', await pathExists(sidecarPackagePath), sidecarPackagePath)

  const nodeModulesPath = join(sidecarRoot, 'node_modules')
  add('sidecar:node-modules', await dirExists(nodeModulesPath), nodeModulesPath)

  const runtimeRoot = join(sidecarRoot, 'runtime')
  add('runtime:root', await dirExists(runtimeRoot), runtimeRoot)
  if (runtimeRel) {
    const runtimePath = join(runtimeRoot, runtimeRel)
    const runtimeBytes = await fileSize(runtimePath)
    add(`runtime:${key}`, runtimeBytes > 0, `${runtimePath} (${runtimeBytes} bytes)`)
  } else {
    add(`runtime:${key}`, false, `unsupported platform/arch for preview runtime: ${key}`)
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  }
}

function parseArgs(argv) {
  const out = { root: repoRoot, json: false }
  for (const arg of argv) {
    if (arg === '--json') out.json = true
    else if (arg.startsWith('--root=')) out.root = resolve(arg.slice('--root='.length))
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = await collectTauriPreviewReadiness({ root: args.root })
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const check of result.checks) {
      console.log(`${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.detail}`)
    }
  }
  if (!result.ok) {
    throw new Error('Tauri preview readiness checks failed')
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[check-tauri-preview-readiness] failed:', err.message || err)
    process.exit(1)
  })
}
