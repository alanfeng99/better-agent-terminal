import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { updateProjectVersion } = require('../scripts/build-version.js')

const root = await mkdtemp(join(tmpdir(), `bat-build-version-${process.pid}-`))
try {
  await mkdir(join(root, 'src-tauri'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  )
  await writeFile(
    join(root, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({ productName: 'Test App', version: '1.0.0' }, null, 2) + '\n',
  )

  updateProjectVersion('2.3.4-pre.1', root)

  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const tauriConfig = JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))

  assert.equal(packageJson.version, '2.3.4-pre.1')
  assert.equal(tauriConfig.version, '2.3.4-pre.1')
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('build-version-script: passed')
