import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DEV_VERSION, getVersion, normalizeVersion, updateProjectVersion } = require('../scripts/build-version.js')

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

  assert.equal(normalizeVersion('v2.9.0-pre.19'), '2.9.0-pre.19')
  assert.equal(normalizeVersion('2.9.0'), '2.9.0')

  const oldVersionEnv = process.env.VERSION
  const oldCiEnv = process.env.CI
  const oldGithubActionsEnv = process.env.GITHUB_ACTIONS
  const oldGithubRefTypeEnv = process.env.GITHUB_REF_TYPE
  const oldGithubRefNameEnv = process.env.GITHUB_REF_NAME
  try {
    delete process.env.VERSION
    delete process.env.CI
    delete process.env.GITHUB_ACTIONS
    delete process.env.GITHUB_REF_TYPE
    delete process.env.GITHUB_REF_NAME
    assert.equal(getVersion(), DEV_VERSION)

    process.env.VERSION = 'v2.9.0-pre.20'
    assert.equal(getVersion(), '2.9.0-pre.20')

    delete process.env.VERSION
    process.env.GITHUB_ACTIONS = 'true'
    process.env.GITHUB_REF_TYPE = 'tag'
    process.env.GITHUB_REF_NAME = 'v2.9.0-pre.21'
    assert.equal(getVersion(), '2.9.0-pre.21')
  } finally {
    if (oldVersionEnv === undefined) delete process.env.VERSION
    else process.env.VERSION = oldVersionEnv
    if (oldCiEnv === undefined) delete process.env.CI
    else process.env.CI = oldCiEnv
    if (oldGithubActionsEnv === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = oldGithubActionsEnv
    if (oldGithubRefTypeEnv === undefined) delete process.env.GITHUB_REF_TYPE
    else process.env.GITHUB_REF_TYPE = oldGithubRefTypeEnv
    if (oldGithubRefNameEnv === undefined) delete process.env.GITHUB_REF_NAME
    else process.env.GITHUB_REF_NAME = oldGithubRefNameEnv
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('build-version-script: passed')
