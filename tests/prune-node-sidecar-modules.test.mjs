import assert from 'node:assert/strict'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  pruneNodeSidecarModules,
  targetAnthropicAgentSdkPackage,
  targetOpenAICodexPackage,
} from '../scripts/prune-node-sidecar-modules.mjs'

async function makeDir(path) {
  await mkdir(path, { recursive: true })
}

async function list(path) {
  return (await readdir(path)).sort()
}

const root = join(tmpdir(), `bat-prune-sidecar-${process.pid}`)
await rm(root, { recursive: true, force: true })

try {
  await makeDir(join(root, '@anthropic-ai', 'claude-agent-sdk'))
  await makeDir(join(root, '@anthropic-ai', 'sdk'))
  await makeDir(join(root, '@anthropic-ai', 'claude-agent-sdk-darwin-arm64'))
  await makeDir(join(root, '@anthropic-ai', 'claude-agent-sdk-darwin-x64'))
  await makeDir(join(root, '@anthropic-ai', 'claude-agent-sdk-win32-x64'))
  await makeDir(join(root, '@openai', 'codex'))
  await makeDir(join(root, '@openai', 'codex-sdk'))
  await makeDir(join(root, '@openai', 'codex-darwin-arm64'))
  await makeDir(join(root, '@openai', 'codex-darwin-x64'))
  await makeDir(join(root, '@openai', 'codex-win32-x64'))

  assert.equal(
    targetAnthropicAgentSdkPackage('darwin', 'arm64'),
    'claude-agent-sdk-darwin-arm64',
  )
  assert.equal(targetOpenAICodexPackage('darwin', 'arm64'), 'codex-darwin-arm64')

  const removed = await pruneNodeSidecarModules({
    root,
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.equal(removed.length, 4)

  assert.deepEqual(await list(join(root, '@anthropic-ai')), [
    'claude-agent-sdk',
    'claude-agent-sdk-darwin-arm64',
    'sdk',
  ])
  assert.deepEqual(await list(join(root, '@openai')), [
    'codex',
    'codex-darwin-arm64',
    'codex-sdk',
  ])

  console.log('prune-node-sidecar-modules: passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
