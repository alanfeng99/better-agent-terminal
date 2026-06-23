// Tests for scripts/generate-update-manifest.mjs — specifically the channel
// fan-out rules:
//   stable tag -> writes latest-stable-* AND latest-pre-* (Preview channel
//                 must also receive new stable releases)
//   pre tag    -> writes ONLY latest-pre-* (stable installs must never be
//                 offered a -pre build)
//
// Run with: node tests/generate-update-manifest.test.mjs

import * as assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateUpdateManifests } from '../scripts/generate-update-manifest.mjs'

function makeArtifacts(root, version) {
  // Two modes × one target each, mirroring the updater-meta sidecars the
  // build legs upload. The lightweight leg also exercises the separate
  // updater-tarball staging path.
  const a = join(root, 'updater-meta-win-all-in-one')
  mkdirSync(a, { recursive: true })
  writeFileSync(join(a, 'updater-meta.json'), JSON.stringify({
    target: 'windows-x86_64',
    mode: 'all-in-one',
    version,
    assetName: `BetterAgentTerminal.Setup.${version}.exe`,
    signature: 'sig-win-aio',
  }))

  const b = join(root, 'updater-meta-linux-lightweight')
  mkdirSync(b, { recursive: true })
  const tarball = `BetterAgentTerminal-${version}.lightweight.AppImage.tar.gz`
  writeFileSync(join(b, 'updater-meta.json'), JSON.stringify({
    target: 'linux-x86_64',
    mode: 'lightweight',
    version,
    assetName: tarball,
    signature: 'sig-linux-lw',
  }))
  writeFileSync(join(b, tarball), 'fake-tarball-bytes')
}

let failures = 0
function test(name, fn) {
  try { fn(); console.log('  ok  -', name) } catch (err) {
    failures++; console.error('  FAIL-', name, '\n   ', err.message)
  }
}

async function run() {
  // ---- stable tag fans out to both channels ----
  {
    const root = mkdtempSync(join(tmpdir(), 'bat-manifest-stable-'))
    const out = join(root, 'out')
    makeArtifacts(root, '9.9.9')
    const result = await generateUpdateManifests({
      artifactsDir: root, outDir: out, tag: 'v9.9.9', pubDate: '2026-01-01T00:00:00.000Z',
    })
    test('stable: channel detected as stable', () => assert.equal(result.channel, 'stable'))
    test('stable: writes both channels for every mode', () => {
      const files = readdirSync(out).filter(f => f.endsWith('.json')).sort()
      assert.deepEqual(files, [
        'latest-pre-all-in-one.json',
        'latest-pre-lightweight.json',
        'latest-stable-all-in-one.json',
        'latest-stable-lightweight.json',
      ])
    })
    test('stable: pre copy is byte-identical to the stable manifest', () => {
      for (const mode of ['all-in-one', 'lightweight']) {
        const stable = readFileSync(join(out, `latest-stable-${mode}.json`), 'utf8')
        const pre = readFileSync(join(out, `latest-pre-${mode}.json`), 'utf8')
        assert.equal(pre, stable)
      }
    })
    test('stable: updater tarball staged under stable fixed name', () => {
      const staged = readdirSync(out).filter(f => f.endsWith('.tar.gz'))
      assert.deepEqual(staged, ['bat-updater-stable-lightweight-linux-x86_64.AppImage.tar.gz'])
      const manifest = JSON.parse(readFileSync(join(out, 'latest-pre-lightweight.json'), 'utf8'))
      assert.match(manifest.platforms['linux-x86_64'].url, /bat-updater-stable-lightweight/)
    })
    rmSync(root, { recursive: true, force: true })
  }

  // ---- pre tag stays on the pre channel only ----
  {
    const root = mkdtempSync(join(tmpdir(), 'bat-manifest-pre-'))
    const out = join(root, 'out')
    makeArtifacts(root, '9.9.10-pre.1')
    const result = await generateUpdateManifests({
      artifactsDir: root, outDir: out, tag: 'v9.9.10-pre.1', pubDate: '2026-01-01T00:00:00.000Z',
    })
    test('pre: channel detected as pre', () => assert.equal(result.channel, 'pre'))
    test('pre: never writes stable manifests', () => {
      const files = readdirSync(out).filter(f => f.endsWith('.json')).sort()
      assert.deepEqual(files, ['latest-pre-all-in-one.json', 'latest-pre-lightweight.json'])
    })
    rmSync(root, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\ngenerate-update-manifest: passed' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch(err => { console.error(err); process.exit(1) })
