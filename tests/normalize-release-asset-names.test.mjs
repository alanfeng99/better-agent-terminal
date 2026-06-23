import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { normalizeReleaseAssetNames } from '../scripts/normalize-release-asset-names.mjs'

const root = await mkdtemp(join(tmpdir(), 'bat-release-assets-'))

try {
  const macDir = join(root, 'dmg')
  await mkdir(macDir)
  await writeFile(join(macDir, 'BetterAgentTerminal_2.9.0-pre.15_aarch64.dmg'), 'dmg')
  await normalizeReleaseAssetNames({
    releaseDir: root,
    platform: 'mac',
    version: 'v2.9.0-pre.15',
    arch: 'arm64',
    mode: 'all-in-one',
  })
  assert.deepEqual(await readdir(macDir), ['BetterAgentTerminal-2.9.0-pre.15-arm64.dmg'])

  // Linux x64 keeps the historical arch-less name so existing links/updater stay valid.
  const linuxDir = join(root, 'appimage')
  await mkdir(linuxDir)
  await writeFile(join(linuxDir, 'BetterAgentTerminal_2.9.0-pre.15_amd64.AppImage'), 'appimage')
  await normalizeReleaseAssetNames({
    releaseDir: linuxDir,
    platform: 'linux',
    version: '2.9.0-pre.15',
    arch: 'x64',
  })
  assert.deepEqual(await readdir(linuxDir), ['BetterAgentTerminal-2.9.0-pre.15.AppImage'])

  // Linux arm64 gets an arch marker so it doesn't collide with the x64 AppImage.
  const linuxArmDir = join(root, 'appimage-arm64')
  await mkdir(linuxArmDir)
  await writeFile(join(linuxArmDir, 'BetterAgentTerminal_2.9.0-pre.15_aarch64.AppImage'), 'appimage')
  await normalizeReleaseAssetNames({
    releaseDir: linuxArmDir,
    platform: 'linux',
    version: '2.9.0-pre.15',
    arch: 'arm64',
  })
  assert.deepEqual(await readdir(linuxArmDir), ['BetterAgentTerminal-2.9.0-pre.15-arm64.AppImage'])

  const winDir = join(root, 'nsis')
  await mkdir(winDir)
  await writeFile(join(winDir, 'BetterAgentTerminal_2.9.0-pre.15_x64-setup.exe'), 'exe')
  await normalizeReleaseAssetNames({
    releaseDir: winDir,
    platform: 'win',
    version: '2.9.0-pre.15',
    mode: 'lightweight',
  })
  assert.deepEqual(await readdir(winDir), ['BetterAgentTerminal.Setup.2.9.0-pre.15.lightweight.exe'])

  console.log('normalize-release-asset-names: passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
