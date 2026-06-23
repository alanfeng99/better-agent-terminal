import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { collectTauriResourceStats } from '../scripts/check-tauri-resources.mjs'

const root = join(tmpdir(), `bat-tauri-resources-${process.pid}`)
await rm(root, { recursive: true, force: true })

try {
  const tauriDir = join(root, 'src-tauri')
  const resourcesDir = join(root, 'resources')
  await mkdir(join(resourcesDir, 'dir', 'nested'), { recursive: true })
  await writeFile(join(resourcesDir, 'one.txt'), '1234')
  await writeFile(join(resourcesDir, 'dir', 'two.txt'), '12')
  await writeFile(join(resourcesDir, 'dir', 'nested', 'three.txt'), '123')
  await mkdir(tauriDir, { recursive: true })

  const configPath = join(tauriDir, 'tauri.conf.json')
  await writeFile(configPath, JSON.stringify({
    bundle: {
      resources: {
        '../resources/one.txt': 'one.txt',
        '../resources/dir/': 'dir/',
        '../resources/missing.txt': 'missing.txt',
      },
    },
  }))

  const stats = await collectTauriResourceStats(configPath)
  assert.equal(stats.totalFiles, 3)
  assert.equal(stats.totalBytes, 9)
  assert.deepEqual(stats.missing, ['../resources/missing.txt'])
  assert.equal(stats.entries.find((entry) => entry.source === '../resources/dir/').files, 2)

  const extraConfigPath = join(tauriDir, 'tauri.all-in-one.conf.json')
  await writeFile(extraConfigPath, JSON.stringify({
    bundle: {
      resources: {
        '../resources/one.txt': 'one-copy.txt',
      },
    },
  }))
  const mergedStats = await collectTauriResourceStats(configPath, [extraConfigPath])
  assert.equal(mergedStats.entries.length, 3)
  assert.ok(mergedStats.entries.some((entry) => entry.target === 'one-copy.txt'))

  console.log('check-tauri-resources: passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
