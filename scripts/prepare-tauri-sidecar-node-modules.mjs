#!/usr/bin/env node
// Prepare the minimal node_modules tree required by the bundled Tauri
// sidecar. `dist/server.mjs` contains the JS dependencies; this directory
// only keeps platform native binaries that must remain real files.

import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const sidecarRoot = join(repoRoot, 'node-sidecar')
const sourceRoot = join(sidecarRoot, 'node_modules')
const outputRoot = join(sidecarRoot, 'dist-node_modules')

const claudeNativePackages = {
  'win32-x64': 'claude-agent-sdk-win32-x64',
  'win32-arm64': 'claude-agent-sdk-win32-arm64',
  'darwin-x64': 'claude-agent-sdk-darwin-x64',
  'darwin-arm64': 'claude-agent-sdk-darwin-arm64',
  'linux-x64': 'claude-agent-sdk-linux-x64',
  'linux-arm64': 'claude-agent-sdk-linux-arm64',
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

async function assertDirectory(path, label) {
  let info
  try {
    info = await stat(path)
  } catch (err) {
    throw new Error(`${label} missing: ${path} (${err.message})`)
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`)
  }
}

async function compressLinuxClaudeBinary(packageDir, platform) {
  if (platform !== 'linux') return null
  const binary = join(packageDir, 'claude')
  const compressed = `${binary}.gz`
  const bytes = await readFile(binary)
  await writeFile(compressed, gzipSync(bytes, { level: 9 }), { mode: 0o644 })
  await rm(binary, { force: true })
  return compressed
}

export async function prepareTauriSidecarNodeModules(options = {}) {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const key = platformKey(platform, arch)
  const claudePackage = claudeNativePackages[key]
  if (!claudePackage) {
    throw new Error(`unsupported platform/arch for sidecar native package: ${key}`)
  }

  const anthropicSourceLink = join(sourceRoot, '@anthropic-ai', claudePackage)
  await assertDirectory(anthropicSourceLink, '@anthropic-ai Claude native package')
  const anthropicSource = await realpath(anthropicSourceLink)

  await rm(outputRoot, { recursive: true, force: true })
  const anthropicTargetRoot = join(outputRoot, '@anthropic-ai')
  await mkdir(anthropicTargetRoot, { recursive: true })
  const anthropicTarget = join(anthropicTargetRoot, claudePackage)
  await cp(anthropicSource, anthropicTarget, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  })
  const compressedClaudeBinary = await compressLinuxClaudeBinary(anthropicTarget, platform)

  return {
    outputRoot,
    packages: [`@anthropic-ai/${claudePackage}`],
    compressedClaudeBinary,
  }
}

async function main() {
  const result = await prepareTauriSidecarNodeModules()
  console.log(`[prepare-tauri-sidecar-node-modules] wrote ${result.outputRoot}`)
  for (const pkg of result.packages) {
    console.log(`[prepare-tauri-sidecar-node-modules] kept ${pkg}`)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[prepare-tauri-sidecar-node-modules] failed:', err.message || err)
    process.exit(1)
  })
}
