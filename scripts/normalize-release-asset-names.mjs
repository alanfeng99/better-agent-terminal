#!/usr/bin/env node

import { readdir, rename, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const defaultReleaseDir = resolve('src-tauri', 'target', 'release', 'bundle')

function normalizeVersion(value) {
  const version = String(value || '').trim()
  return version.startsWith('v') ? version.slice(1) : version
}

function normalizePlatform(value) {
  if (value === 'darwin') return 'mac'
  if (value === 'win32') return 'win'
  return value || process.platform
}

function normalizeArch(value) {
  if (value === 'aarch64') return 'arm64'
  if (value === 'x86_64') return 'x64'
  return value || (process.arch === 'arm64' ? 'arm64' : 'x64')
}

function normalizeBundleMode(value) {
  const mode = String(value || '').trim()
  if (!mode) return ''
  if (mode !== 'all-in-one' && mode !== 'lightweight') {
    throw new Error(`unsupported release bundle mode: ${mode}`)
  }
  return mode
}

function withModeSuffix(name, mode) {
  if (mode === 'all-in-one') return name
  return mode ? `${name}.${mode}` : name
}

function isIgnoredReleaseArtifact(filePath) {
  return /^rw\.\d+\..+\.dmg$/.test(basename(filePath))
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath))
    } else if (entry.isFile() && !isIgnoredReleaseArtifact(fullPath)) {
      files.push(fullPath)
    }
  }
  return files
}

function targetNameFor({ filePath, platform, version, arch, mode }) {
  const ext = extname(filePath)
  if (platform === 'mac' && ext === '.dmg') {
    return `${withModeSuffix(`BetterAgentTerminal-${version}-${normalizeArch(arch)}`, mode)}.dmg`
  }
  if (platform === 'linux' && ext === '.AppImage') {
    // Keep the historical x64 asset name (no arch marker) so existing download
    // links, install.sh, and updater entries keep resolving; only disambiguate
    // non-x64 arches so multi-arch AppImages don't collide on one release.
    const archSuffix = normalizeArch(arch) === 'x64' ? '' : `-${normalizeArch(arch)}`
    return `${withModeSuffix(`BetterAgentTerminal-${version}${archSuffix}`, mode)}.AppImage`
  }
  if (platform === 'win' && ext === '.exe') {
    return `${withModeSuffix(`BetterAgentTerminal.Setup.${version}`, mode)}.exe`
  }
  return null
}

export async function normalizeReleaseAssetNames(options = {}) {
  const releaseDir = resolve(options.releaseDir || defaultReleaseDir)
  const platform = normalizePlatform(options.platform || process.env.BAT_RELEASE_PLATFORM)
  const version = normalizeVersion(options.version || process.env.VERSION || process.env.GITHUB_REF_NAME)
  const arch = options.arch || process.env.BAT_RELEASE_ARCH
  const mode = normalizeBundleMode(options.mode || process.env.BAT_RELEASE_BUNDLE_MODE)

  if (!version) {
    throw new Error('missing release version; set VERSION or GITHUB_REF_NAME')
  }

  const files = await listFiles(releaseDir)
  const renamed = []
  for (const filePath of files) {
    const targetName = targetNameFor({ filePath, platform, version, arch, mode })
    if (!targetName || basename(filePath) === targetName) continue

    const targetPath = join(dirname(filePath), targetName)
    try {
      await stat(targetPath)
      throw new Error(`target already exists: ${targetPath}`)
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }

    await rename(filePath, targetPath)
    renamed.push({ from: filePath, to: targetPath })
  }

  return renamed
}

async function main() {
  const releaseDir = process.argv[2] || defaultReleaseDir
  const renamed = await normalizeReleaseAssetNames({ releaseDir })
  if (renamed.length === 0) {
    console.log('[normalize-release-asset-names] no release assets needed renaming')
    return
  }
  for (const item of renamed) {
    console.log(`[normalize-release-asset-names] ${basename(item.from)} -> ${basename(item.to)}`)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[normalize-release-asset-names] failed:', err.message || err)
    process.exit(1)
  })
}
