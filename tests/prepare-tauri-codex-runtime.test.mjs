import assert from 'node:assert/strict'
import { join } from 'node:path'

import { codexRuntimeLayoutCandidates } from '../scripts/prepare-tauri-codex-runtime.mjs'

const candidates = codexRuntimeLayoutCandidates(
  '/tmp/codex-native',
  'aarch64-apple-darwin',
  'codex',
  'rg',
)

assert.deepEqual(candidates.binary, [
  join('/tmp/codex-native', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'),
  join('/tmp/codex-native', 'vendor', 'aarch64-apple-darwin', 'codex', 'codex'),
])

assert.deepEqual(candidates.ripgrep, [
  join('/tmp/codex-native', 'vendor', 'aarch64-apple-darwin', 'codex-path', 'rg'),
  join('/tmp/codex-native', 'vendor', 'aarch64-apple-darwin', 'path', 'rg'),
])

console.log('prepare-tauri-codex-runtime: passed')
