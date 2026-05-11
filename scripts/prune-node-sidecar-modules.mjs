#!/usr/bin/env node
// Prune known cross-platform native package directories from the Tauri
// sidecar node_modules tree. This keeps release resources from carrying
// stale binaries for platforms that are not part of the current build.

import { readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const defaultRoot = join(repoRoot, 'node-sidecar', 'node_modules')

export function normalizeArch(value = process.arch) {
  if (value === 'x64') return 'x64'
  if (value === 'arm64') return 'arm64'
  return String(value || process.arch)
}

export function normalizePlatform(value = process.platform) {
  return String(value || process.platform)
}

function linuxLibcSuffix() {
  if (process.platform !== 'linux') return ''
  const glibc = process.report?.getReport?.()?.header?.glibcVersionRuntime
  return glibc ? '' : '-musl'
}

export function targetAnthropicAgentSdkPackage(platform, arch, libcSuffix = linuxLibcSuffix()) {
  const normalizedPlatform = normalizePlatform(platform)
  const normalizedArch = normalizeArch(arch)
  if (normalizedPlatform === 'linux') {
    return `claude-agent-sdk-linux-${normalizedArch}${libcSuffix}`
  }
  return `claude-agent-sdk-${normalizedPlatform}-${normalizedArch}`
}

export function targetOpenAICodexPackage(platform, arch) {
  return `codex-${normalizePlatform(platform)}-${normalizeArch(arch)}`
}

function isOpenAICodexPlatformPackage(name) {
  return /^codex-(darwin|linux|win32)-/.test(name)
}

async function pruneScopedFamily(scopeRoot, shouldRemove) {
  let entries
  try {
    entries = await readdir(scopeRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const removed = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!shouldRemove(entry.name)) continue
    const fullPath = join(scopeRoot, entry.name)
    await rm(fullPath, { recursive: true, force: true })
    removed.push(fullPath)
  }
  return removed
}

export async function pruneNodeSidecarModules({
  root = defaultRoot,
  platform = process.platform,
  arch = process.arch,
  libcSuffix = linuxLibcSuffix(),
} = {}) {
  const anthropicTarget = targetAnthropicAgentSdkPackage(platform, arch, libcSuffix)
  const openaiTarget = targetOpenAICodexPackage(platform, arch)
  const removed = []

  removed.push(...await pruneScopedFamily(join(root, '@anthropic-ai'), (name) => (
    name.startsWith('claude-agent-sdk-') && name !== anthropicTarget
  )))

  removed.push(...await pruneScopedFamily(join(root, '@openai'), (name) => (
    isOpenAICodexPlatformPackage(name) && name !== openaiTarget
  )))

  return removed
}

function parseArgs(argv) {
  const out = { root: defaultRoot, platform: process.platform, arch: process.arch }
  for (const arg of argv) {
    if (arg.startsWith('--root=')) out.root = resolve(arg.slice('--root='.length))
    else if (arg.startsWith('--platform=')) out.platform = arg.slice('--platform='.length)
    else if (arg.startsWith('--arch=')) out.arch = arg.slice('--arch='.length)
  }
  return out
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  pruneNodeSidecarModules(args)
    .then((removed) => {
      for (const path of removed) {
        console.log(`[prune-node-sidecar-modules] removed ${path}`)
      }
      const noun = removed.length === 1 ? 'directory' : 'directories'
      console.log(`[prune-node-sidecar-modules] removed ${removed.length} native package ${noun}`)
    })
    .catch((err) => {
      console.error('[prune-node-sidecar-modules] failed:', err)
      process.exit(1)
    })
}
