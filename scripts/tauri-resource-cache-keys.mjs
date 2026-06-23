#!/usr/bin/env node
// Compute narrow cache keys for generated Tauri resource directories.
// These keys intentionally track the runtime slices independently so a
// regular app dependency change does not always invalidate every large
// prepared resource.

import { createHash } from 'node:crypto'
import { appendFile, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function listFiles(root) {
  if (!await pathExists(root)) return []
  const files = []
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        files.push(path)
      }
    }
  }
  await visit(root)
  return files
}

function lockExcerpt(raw, patterns) {
  const lines = raw.split(/\r?\n/)
  const included = new Set()
  for (let index = 0; index < lines.length; index += 1) {
    if (!patterns.some((pattern) => pattern.test(lines[index]))) continue
    for (let offset = -2; offset <= 8; offset += 1) {
      const target = index + offset
      if (target >= 0 && target < lines.length) included.add(target)
    }
  }
  return [...included].sort((a, b) => a - b).map((index) => lines[index]).join('\n')
}

async function hashParts(parts) {
  const hash = createHash('sha256')
  for (const part of parts) {
    if (part.type === 'text') {
      hash.update(`text:${part.name}\n${part.value}\n`)
      continue
    }
    if (part.type === 'file') {
      const path = resolve(repoRoot, part.path)
      hash.update(`file:${part.path}\n`)
      hash.update(await readFile(path))
      hash.update('\n')
      continue
    }
    if (part.type === 'dir') {
      const root = resolve(repoRoot, part.path)
      const files = await listFiles(root)
      for (const file of files) {
        hash.update(`file:${relative(repoRoot, file)}\n`)
        hash.update(await readFile(file))
        hash.update('\n')
      }
    }
  }
  return hash.digest('hex').slice(0, 24)
}

async function computeKeys() {
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const sidecarPackageJson = JSON.parse(await readFile(join(repoRoot, 'node-sidecar', 'package.json'), 'utf8'))
  const pnpmLock = await readFile(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  const sidecarLock = await readFile(join(repoRoot, 'node-sidecar', 'pnpm-lock.yaml'), 'utf8')
  const sidecarClaudeLock = lockExcerpt(sidecarLock, [
    /@anthropic-ai\/claude-agent-sdk/,
    /claude-agent-sdk-(darwin|linux|win32)-/,
  ])
  const codexLock = lockExcerpt(pnpmLock, [
    /@openai\/codex/,
    /codex-(darwin|linux|win32)-/,
  ])

  const sidecarNativeModules = await hashParts([
    { type: 'file', path: 'scripts/prepare-tauri-sidecar-node-modules.mjs' },
    {
      type: 'text',
      name: 'node-sidecar-package-claude-native',
      value: JSON.stringify({
        packageManager: packageJson.packageManager,
        claudeAgentSdk: sidecarPackageJson.dependencies?.['@anthropic-ai/claude-agent-sdk'],
        supportedArchitectures: packageJson.pnpm?.supportedArchitectures,
      }),
    },
    { type: 'text', name: 'node-sidecar-pnpm-lock-claude-native', value: sidecarClaudeLock },
  ])

  const codexRuntime = await hashParts([
    { type: 'file', path: 'scripts/prepare-tauri-codex-runtime.mjs' },
    {
      type: 'text',
      name: 'package-json-codex',
      value: JSON.stringify({
        packageManager: packageJson.packageManager,
        codex: packageJson.dependencies?.['@openai/codex'],
        supportedArchitectures: packageJson.pnpm?.supportedArchitectures,
      }),
    },
    { type: 'text', name: 'pnpm-lock-codex', value: codexLock },
  ])

  const nodeRuntime = await hashParts([
    { type: 'file', path: 'scripts/fetch-node-runtime.mjs' },
  ])

  return {
    sidecar_native_modules: sidecarNativeModules,
    codex_runtime: codexRuntime,
    node_runtime: nodeRuntime,
  }
}

const keys = await computeKeys()
for (const [name, value] of Object.entries(keys)) {
  console.log(`${name}=${value}`)
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(keys).map(([name, value]) => `${name}=${value}`).join('\n') + '\n',
  )
}
