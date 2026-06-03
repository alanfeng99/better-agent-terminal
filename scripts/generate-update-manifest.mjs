#!/usr/bin/env node

// Merge the per-build `updater-meta.json` sidecars (produced by
// stage-updater-artifacts.mjs and downloaded as `updater-meta-*` artifacts)
// into the Tauri dynamic-update manifests the app polls.
//
// One manifest per bundle mode for the channel implied by the tag:
//   v*-pre*  -> latest-pre-{all-in-one,lightweight}.json
//   v*       -> latest-stable-{all-in-one,lightweight}.json
//
// These filenames MUST match manifest_endpoint() in
// src-tauri/src/commands/update.rs (latest-{channel}-{mode}.json), and are
// uploaded to the pinned `manifests` GitHub release.

import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'tony1223/better-agent-terminal'
const defaultArtifactsDir = resolve('artifacts')
const defaultOutDir = resolve('manifests-out')

// Separate updater bundles (.app.tar.gz / .AppImage.tar.gz) are published to the
// pinned `manifests` release under a fixed, per-channel/mode/target name and
// clobbered each release — keeping the versioned release free of confusing
// download-which-one *.tar.gz assets. Installers that double as the updater
// target (Windows .exe, bare Linux .AppImage) stay on the versioned release.
const MANIFESTS_RELEASE_BASE = `https://github.com/${REPO}/releases/download/manifests`

function updaterTarballExt(assetName) {
  if (assetName.endsWith('.app.tar.gz')) return '.app.tar.gz'
  if (assetName.endsWith('.AppImage.tar.gz')) return '.AppImage.tar.gz'
  return null
}

function stripV(value) {
  const v = String(value || '').trim()
  return v.startsWith('v') ? v.slice(1) : v
}

function channelForTag(tag) {
  return String(tag || '').includes('-pre') ? 'pre' : 'stable'
}

async function findMetaFiles(dir) {
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
    if (entry.isDirectory()) files.push(...await findMetaFiles(full))
    else if (entry.isFile() && entry.name === 'updater-meta.json') files.push(full)
  }
  return files
}

export async function generateUpdateManifests(options = {}) {
  const artifactsDir = resolve(options.artifactsDir || defaultArtifactsDir)
  const outDir = resolve(options.outDir || defaultOutDir)
  const tag = options.tag || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME
  const pubDate = options.pubDate || new Date().toISOString()

  if (!tag) throw new Error('missing release tag; set RELEASE_TAG')

  const channel = channelForTag(tag)
  const version = stripV(tag)
  const releaseBase = `https://github.com/${REPO}/releases/download/${tag}`

  const metaFiles = await findMetaFiles(artifactsDir)
  if (metaFiles.length === 0) {
    throw new Error(`no updater-meta.json found under ${artifactsDir} — did the build stage updater artifacts?`)
  }

  await mkdir(outDir, { recursive: true })

  // mode -> { [target]: { signature, url } }
  const byMode = new Map()
  for (const file of metaFiles) {
    const meta = JSON.parse(await readFile(file, 'utf8'))
    const { target, mode, version: metaVersion, assetName, signature } = meta
    if (!target || !mode || !assetName || !signature) {
      throw new Error(`incomplete updater meta in ${file}: ${JSON.stringify(meta)}`)
    }
    if (stripV(metaVersion) !== version) {
      throw new Error(`version mismatch in ${file}: meta ${metaVersion} vs tag ${version}`)
    }
    if (!byMode.has(mode)) byMode.set(mode, {})
    const platforms = byMode.get(mode)
    if (platforms[target]) {
      throw new Error(`duplicate target ${target} for mode ${mode} (${assetName})`)
    }

    const ext = updaterTarballExt(assetName)
    let url
    if (ext) {
      // Separate updater bundle: it was copied next to this meta by
      // stage-updater-artifacts. Re-stage it into the manifest output under a
      // fixed name so the publish step uploads it to the pinned `manifests`
      // release (clobbered every release), and point the manifest there.
      const fixedName = `bat-updater-${channel}-${mode}-${target}${ext}`
      const src = join(dirname(file), assetName)
      try {
        await copyFile(src, join(outDir, fixedName))
      } catch (err) {
        throw new Error(`updater bundle missing for ${target} (${mode}): expected ${src} — ${err?.message || err}`)
      }
      url = `${MANIFESTS_RELEASE_BASE}/${fixedName}`
    } else {
      // Installer that doubles as the updater target (Windows .exe, bare Linux
      // .AppImage): it already ships on the versioned release.
      url = `${releaseBase}/${assetName}`
    }
    platforms[target] = { signature, url }
  }

  const written = []
  for (const [mode, platforms] of byMode) {
    const manifest = { version, notes: '', pub_date: pubDate, platforms }
    const name = `latest-${channel}-${mode}.json`
    const outPath = join(outDir, name)
    await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    written.push({ name, targets: Object.keys(platforms) })
  }
  return { channel, version, written }
}

async function main() {
  const artifactsDir = process.argv[2] || defaultArtifactsDir
  const outDir = process.argv[3] || defaultOutDir
  const { channel, version, written } = await generateUpdateManifests({ artifactsDir, outDir })
  console.log(`[generate-update-manifest] channel=${channel} version=${version}`)
  for (const item of written) {
    console.log(`[generate-update-manifest] ${item.name} -> [${item.targets.join(', ')}]`)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[generate-update-manifest] failed:', err?.message || err)
    process.exit(1)
  })
}
