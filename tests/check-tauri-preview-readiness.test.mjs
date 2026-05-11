import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { collectTauriPreviewReadiness } from '../scripts/check-tauri-preview-readiness.mjs'

const root = join(tmpdir(), `bat-tauri-preview-readiness-${process.pid}`)
await rm(root, { recursive: true, force: true })

try {
  await mkdir(join(root, 'src-tauri'), { recursive: true })
  await mkdir(join(root, 'node-sidecar', 'dist'), { recursive: true })
  await mkdir(join(root, 'node-sidecar', 'node_modules'), { recursive: true })
  await mkdir(join(root, 'node-sidecar', 'runtime', 'windows-x86_64'), { recursive: true })

  await writeFile(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({
    bundle: {
      resources: {
        '../node-sidecar/dist/server.mjs': 'node-sidecar/dist/server.mjs',
        '../node-sidecar/package.json': 'node-sidecar/package.json',
        '../node-sidecar/node_modules/': 'node-sidecar/node_modules/',
        '../node-sidecar/runtime/': 'node-runtime/',
      },
    },
  }))
  await writeFile(join(root, 'node-sidecar', 'dist', 'server.mjs'), 'console.log("ok")')
  await writeFile(join(root, 'node-sidecar', 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'node-sidecar', 'runtime', 'windows-x86_64', 'node.exe'), 'node')

  const ready = await collectTauriPreviewReadiness({
    root,
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal(ready.ok, true)

  await writeFile(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({
    bundle: {
      resources: {
        '../node-sidecar/dist/server.mjs': 'node-sidecar/dist/server.mjs',
      },
    },
  }))
  const notReady = await collectTauriPreviewReadiness({
    root,
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal(notReady.ok, false)
  assert.ok(notReady.checks.some((check) => check.name === 'resource:../node-sidecar/runtime/' && !check.ok))

  console.log('check-tauri-preview-readiness: passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
