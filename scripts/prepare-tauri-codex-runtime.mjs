#!/usr/bin/env node
// Prepare the Codex app-server executable as a Rust-owned Tauri resource.
// The Node sidecar no longer carries @openai/codex-* native packages.

import { chmod, copyFile, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const outputRoot = join(repoRoot, 'codex-runtime')
const rootRequire = createRequire(join(repoRoot, 'package.json'))

const codexPlatformPackages = {
  'win32-x64': 'codex-win32-x64',
  'win32-arm64': 'codex-win32-arm64',
  'darwin-x64': 'codex-darwin-x64',
  'darwin-arm64': 'codex-darwin-arm64',
  'linux-x64': 'codex-linux-x64',
  'linux-arm64': 'codex-linux-arm64',
}

const codexTargetTriples = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

export function codexRuntimeLayoutCandidates(codexSource, codexTriple, exeName, rgName) {
  const vendorRoot = join(codexSource, 'vendor', codexTriple)
  return {
    binary: [
      join(vendorRoot, 'bin', exeName),
      join(vendorRoot, 'codex', exeName),
    ],
    ripgrep: [
      join(vendorRoot, 'codex-path', rgName),
      join(vendorRoot, 'path', rgName),
    ],
  }
}

async function firstExistingDirectory(candidates, label) {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return candidate
    } catch { /* try next candidate */ }
  }
  throw new Error(`${label} missing; tried:\n${candidates.map(path => `  - ${path}`).join('\n')}`)
}

async function assertFile(path, label) {
  let info
  try {
    info = await stat(path)
  } catch (err) {
    throw new Error(`${label} missing: ${path} (${err.message})`)
  }
  if (!info.isFile()) {
    throw new Error(`${label} is not a file: ${path}`)
  }
}

async function firstExistingFile(candidates, label) {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch { /* try next candidate */ }
  }
  throw new Error(`${label} missing; tried:\n${candidates.map(path => `  - ${path}`).join('\n')}`)
}

export async function prepareTauriCodexRuntime(options = {}) {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const key = platformKey(platform, arch)
  const codexPackage = codexPlatformPackages[key]
  const codexTriple = codexTargetTriples[key]
  if (!codexPackage || !codexTriple) {
    throw new Error(`unsupported platform/arch for Codex runtime: ${key}`)
  }

  const codexSourceCandidates = [
    join(repoRoot, 'node_modules', '@openai', codexPackage),
    join(repoRoot, 'node_modules', '.pnpm', 'node_modules', '@openai', codexPackage),
  ]
  try {
    const codexMetaPackage = dirname(rootRequire.resolve('@openai/codex/package.json'))
    const codexMetaRealPath = await realpath(codexMetaPackage)
    codexSourceCandidates.push(join(dirname(codexMetaRealPath), codexPackage))
  } catch { /* @openai/codex is not installed as a direct resolver target */ }

  const codexSource = await realpath(await firstExistingDirectory(codexSourceCandidates, '@openai Codex native package'))
  const exeName = platform === 'win32' ? 'codex.exe' : 'codex'
  const rgName = platform === 'win32' ? 'rg.exe' : 'rg'
  const sourceFiles = codexRuntimeLayoutCandidates(codexSource, codexTriple, exeName, rgName)
  const sourceBinary = await firstExistingFile(sourceFiles.binary, '@openai Codex native binary')
  await assertFile(sourceBinary, '@openai Codex native binary')
  const sourceRipgrep = await firstExistingFile(sourceFiles.ripgrep, '@openai Codex vendored ripgrep')

  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  const targetBinary = join(outputRoot, exeName)
  await copyFile(sourceBinary, targetBinary)
  const targetPathDir = join(outputRoot, 'path')
  await mkdir(targetPathDir, { recursive: true })
  const targetRipgrep = join(targetPathDir, rgName)
  await copyFile(sourceRipgrep, targetRipgrep)
  if (platform !== 'win32') {
    await chmod(targetBinary, 0o755)
    await chmod(targetRipgrep, 0o755)
  }

  return {
    outputRoot,
    binary: targetBinary,
    ripgrep: targetRipgrep,
    sourcePackage: `@openai/${codexPackage}`,
  }
}

async function main() {
  const result = await prepareTauriCodexRuntime()
  console.log(`[prepare-tauri-codex-runtime] wrote ${result.binary}`)
  console.log(`[prepare-tauri-codex-runtime] wrote ${result.ripgrep}`)
  console.log(`[prepare-tauri-codex-runtime] source ${result.sourcePackage}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[prepare-tauri-codex-runtime] failed:', err.message || err)
    process.exit(1)
  })
}
