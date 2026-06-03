#!/usr/bin/env node

// Collect the Tauri updater artifacts produced by `tauri build`
// (createUpdaterArtifacts: true) for ONE matrix entry and emit a single
// `updater-meta.json` describing the platform key, the minisign signature, and
// the release asset the updater should download.
//
// Runs on each build runner AFTER normalize-release-asset-names.mjs, so the
// installers already carry their deterministic public names. The macOS updater
// bundle (.app.tar.gz) is renamed in place to match its dmg base so both bundle
// modes can coexist as distinct assets on the same GitHub release.
//
// The generate-update-manifest.mjs step later merges every entry's meta into
// the per-channel/per-mode latest-*.json manifests.

import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const defaultBundleDir = resolve('src-tauri', 'target', 'release', 'bundle')
const defaultOutDir = resolve('updater-meta')

function normalizeVersion(value) {
  const version = String(value || '').trim()
  return version.startsWith('v') ? version.slice(1) : version
}

function normalizePlatform(value) {
  if (value === 'darwin') return 'mac'
  if (value === 'win32') return 'win'
  return value || process.platform
}

function normalizeMode(value) {
  const mode = String(value || '').trim()
  return mode === 'lightweight' ? 'lightweight' : 'all-in-one'
}

// Tauri updater platform key = `{target_os}-{target_arch}`.
function targetTripleFor(platform, arch) {
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (platform === 'mac') return `darwin-${cpu}`
  if (platform === 'win') return `windows-${cpu}`
  if (platform === 'linux') return `linux-${cpu}`
  throw new Error(`unsupported updater platform: ${platform}`)
}

async function listFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Don't descend into the macOS .app bundle: it holds thousands of files
      // (frameworks, the bundled node/codex runtimes) and the updater bundle we
      // want is the sibling `<name>.app.tar.gz`, not anything inside the .app.
      if (entry.name.endsWith('.app')) continue
      files.push(...await listFiles(full))
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files
}

function isIgnoredDmg(filePath) {
  return /^rw\.\d+\..+\.dmg$/.test(basename(filePath))
}

function pickOne(files, predicate, label) {
  const matches = files.filter(predicate)
  if (matches.length === 0) throw new Error(`no ${label} found`)
  if (matches.length > 1) {
    throw new Error(`expected one ${label}, found ${matches.length}: ${matches.map(basename).join(', ')}`)
  }
  return matches[0]
}

async function readSignature(sigPath) {
  const raw = await readFile(sigPath, 'utf8')
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`empty signature file: ${sigPath}`)
  return trimmed
}

// Resolve { assetName, signature, sourcePath } per platform. `assetName` is the
// basename the updater downloads for this target; `sourcePath` is the resolved
// updater file on disk (so separate *.tar.gz bundles can be copied next to the
// meta and published to the pinned `manifests` release instead of the versioned
// release).
async function resolvePlatform({ platform, files }) {
  if (platform === 'mac') {
    const tarball = pickOne(files, f => f.endsWith('.app.tar.gz'), 'macOS .app.tar.gz updater bundle')
    const sig = pickOne(files, f => f.endsWith('.app.tar.gz.sig'), 'macOS .app.tar.gz.sig')
    const dmg = pickOne(files, f => f.endsWith('.dmg') && !isIgnoredDmg(f), 'normalized .dmg')
    const base = basename(dmg).replace(/\.dmg$/, '')
    const assetName = `${base}.app.tar.gz`
    const renamed = join(dirname(tarball), assetName)
    if (renamed !== tarball) await rename(tarball, renamed)
    return { assetName, signature: await readSignature(sig), sourcePath: renamed }
  }

  if (platform === 'win') {
    const sig = pickOne(files, f => f.endsWith('.exe.sig'), 'Windows -setup.exe.sig')
    const installer = pickOne(files, f => f.endsWith('.exe'), 'normalized -setup.exe')
    return { assetName: basename(installer), signature: await readSignature(sig), sourcePath: installer }
  }

  if (platform === 'linux') {
    const tarSig = files.find(f => f.endsWith('.AppImage.tar.gz.sig'))
    const appImage = pickOne(files, f => f.endsWith('.AppImage'), 'normalized .AppImage')
    if (tarSig) {
      // Tarball form: the updater downloads a .AppImage.tar.gz; rename it to the
      // AppImage base so it is a distinct, deterministic release asset.
      const tarball = pickOne(files, f => f.endsWith('.AppImage.tar.gz'), '.AppImage.tar.gz updater bundle')
      const base = basename(appImage).replace(/\.AppImage$/, '')
      const assetName = `${base}.AppImage.tar.gz`
      const renamed = join(dirname(tarball), assetName)
      if (renamed !== tarball) await rename(tarball, renamed)
      return { assetName, signature: await readSignature(tarSig), sourcePath: renamed }
    }
    // Bare form: the AppImage itself is the updater target.
    const sig = pickOne(files, f => f.endsWith('.AppImage.sig'), '.AppImage.sig')
    return { assetName: basename(appImage), signature: await readSignature(sig), sourcePath: appImage }
  }

  throw new Error(`unsupported updater platform: ${platform}`)
}

export async function stageUpdaterArtifacts(options = {}) {
  const bundleDir = resolve(options.bundleDir || defaultBundleDir)
  const outDir = resolve(options.outDir || defaultOutDir)
  const platform = normalizePlatform(options.platform || process.env.BAT_RELEASE_PLATFORM)
  const arch = options.arch || process.env.BAT_RELEASE_ARCH
  const mode = normalizeMode(options.mode || process.env.BAT_BUNDLE_MODE)
  const version = normalizeVersion(options.version || process.env.VERSION || process.env.GITHUB_REF_NAME)

  if (!arch) throw new Error('missing arch; set BAT_RELEASE_ARCH')
  if (!version) throw new Error('missing version; set VERSION or GITHUB_REF_NAME')

  const target = targetTripleFor(platform, arch)
  const files = await listFiles(bundleDir)
  const { assetName, signature, sourcePath } = await resolvePlatform({ platform, files })

  const meta = { target, mode, version, assetName, signature }
  await mkdir(outDir, { recursive: true })
  // Separate updater bundles (*.tar.gz) are NOT shipped on the versioned release
  // — they'd confuse users about which file to download. Copy them next to the
  // meta so they travel in the updater-meta artifact, and generate-update-manifest
  // later publishes them to the pinned `manifests` release under a fixed name.
  // Installers that double as the updater target (.exe, bare .AppImage) already
  // live on the versioned release, so they are not copied here.
  if (assetName.endsWith('.tar.gz')) {
    await copyFile(sourcePath, join(outDir, assetName))
  }
  const metaPath = join(outDir, 'updater-meta.json')
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return { meta, metaPath }
}

async function main() {
  const bundleDir = process.argv[2] || defaultBundleDir
  const outDir = process.argv[3] || defaultOutDir
  const { meta, metaPath } = await stageUpdaterArtifacts({ bundleDir, outDir })
  console.log(`[stage-updater-artifacts] ${meta.target} (${meta.mode}) -> ${meta.assetName}`)
  console.log(`[stage-updater-artifacts] wrote ${metaPath}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[stage-updater-artifacts] failed:', err?.message || err)
    process.exit(1)
  })
}
