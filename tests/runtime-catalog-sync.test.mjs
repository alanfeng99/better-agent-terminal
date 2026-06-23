// Offline guard for runtime-catalog.json — the single source of truth for the
// pinned native runtime versions (Claude agent-sdk CLI, Codex CLI, Node) read
// by both the Rust host (src-tauri/src/runtime_catalog.rs) and the Node sidecar
// (node-sidecar/src/handlers/claude-auth.mjs).
//
// It asserts the committed catalog versions track the installed dependencies
// (and fetch-node-runtime's DEFAULT_VERSION) so a dependency bump that forgets
// to regenerate the catalog is caught without needing network access. Integrity
// fetching is intentionally NOT exercised here — that happens during
// prepare:tauri-bundle:* via scripts/sync-runtime-catalog.mjs.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { expectedVersions, PLATFORMS } from '../scripts/sync-runtime-catalog.mjs'

const catalog = JSON.parse(
  await readFile(new URL('../runtime-catalog.json', import.meta.url), 'utf8'),
)

const expected = expectedVersions()
const keys = PLATFORMS.map((p) => p.key)

assert.equal(
  catalog.claude.version,
  expected.claude,
  `runtime-catalog claude.version (${catalog.claude.version}) must match installed @anthropic-ai/claude-agent-sdk (${expected.claude}); run \`pnpm run sync:runtime-catalog\``,
)
assert.equal(
  catalog.codex.version,
  expected.codex,
  `runtime-catalog codex.version (${catalog.codex.version}) must match installed @openai/codex (${expected.codex}); run \`pnpm run sync:runtime-catalog\``,
)
assert.equal(
  catalog.node.version,
  expected.node,
  `runtime-catalog node.version (${catalog.node.version}) must match fetch-node-runtime DEFAULT_VERSION (${expected.node}); run \`pnpm run sync:runtime-catalog\``,
)

for (const key of keys) {
  const claude = catalog.claude.platforms[key]
  assert.ok(claude, `runtime-catalog missing claude platform ${key}`)
  assert.equal(claude.packageName, `claude-agent-sdk-${key}`, `claude ${key} packageName mismatch`)
  assert.match(claude.integrity, /^sha512-/, `claude ${key} integrity must be an sha512 SRI`)

  const codex = catalog.codex.platforms[key]
  assert.ok(codex, `runtime-catalog missing codex platform ${key}`)
  assert.equal(codex.npmVersion, `${expected.codex}-${key}`, `codex ${key} npmVersion mismatch`)
  assert.match(codex.integrity, /^sha512-/, `codex ${key} integrity must be an sha512 SRI`)

  const node = catalog.node.platforms[key]
  assert.ok(node, `runtime-catalog missing node platform ${key}`)
  assert.match(node.sha256, /^[0-9a-f]{64}$/, `node ${key} sha256 must be a 64-hex digest`)
}

assert.equal(
  Object.keys(catalog.claude.platforms).length,
  keys.length,
  'runtime-catalog claude.platforms must cover exactly the known platform keys',
)
assert.equal(
  Object.keys(catalog.codex.platforms).length,
  keys.length,
  'runtime-catalog codex.platforms must cover exactly the known platform keys',
)
assert.equal(
  Object.keys(catalog.node.platforms).length,
  keys.length,
  'runtime-catalog node.platforms must cover exactly the known platform keys',
)

console.log('runtime-catalog-sync: passed')
