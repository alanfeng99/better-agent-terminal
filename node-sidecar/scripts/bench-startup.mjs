#!/usr/bin/env node
// Startup-cost benchmark for the sidecar's claude.* handlers.
//
// Measures the actual cost of every RPC the renderer fires during a
// fresh ClaudeAgentPanel mount, in isolation from Tauri / Vite / window
// startup so the numbers reflect SDK + Node + handler overhead only.
//
// Usage:
//   node node-sidecar/scripts/bench-startup.mjs
//
// Phases:
//   1. Module import       — ESM resolution + lib/* + handlers/* eval
//   2. SDK lazy load       — first loadAnthropicSdk() call
//   3. claude.authStatus   — execs claude CLI subprocess (cold)
//   4. claude.getCliPath   — pure PATH walk
//   5. claude.accountList  — disk read of accounts index
//   6. getSupportedModels  — first sdk.query() instance + supportedModels()
//   7. getSupportedCommands — second sdk.query() instance
//   8. getSupportedAgents   — third sdk.query() instance
//   9. getAccountInfo       — fourth sdk.query() instance
//
// Outputs a markdown table sorted by elapsed ms. Numbers are
// per-machine — run on the affected platform (mac for the original
// report) to get the relevant figure.

import { performance } from 'node:perf_hooks'

function fmt(ms) {
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 1000) return `${ms.toFixed(0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

async function timed(label, fn) {
  const t0 = performance.now()
  let result
  let err
  try {
    result = await fn()
  } catch (e) {
    err = e
  }
  const elapsed = performance.now() - t0
  return { label, elapsed, result, err }
}

const rows = []
function record(r) {
  rows.push(r)
  const tag = r.err ? '[ERR]' : '[ok]'
  process.stderr.write(`  ${tag} ${r.label.padEnd(32)} ${fmt(r.elapsed)}\n`)
  if (r.err) process.stderr.write(`        ${r.err.message}\n`)
}

async function main() {
  process.stderr.write('Sidecar startup-cost bench\n')
  process.stderr.write('--------------------------\n')

  // --- Phase 1: module import ---
  const importT0 = performance.now()
  const mod = await import('../src/server.mjs')
  const importMs = performance.now() - importT0
  record({ label: 'import server.mjs (cold)', elapsed: importMs })

  const { dispatch } = mod

  // --- Phase 2: SDK lazy load ---
  // First call to loadAnthropicSdk pays the import cost of
  // @anthropic-ai/claude-agent-sdk + its (large) transitive deps.
  // Subsequent calls return the cached module, ~free.
  record(await timed('loadAnthropicSdk (cold)', async () => mod.loadAnthropicSdk()))
  record(await timed('loadAnthropicSdk (warm)', async () => mod.loadAnthropicSdk()))

  // --- Phase 3-5: cheap RPCs ---
  record(await timed('claude.getCliPath', async () =>
    dispatch({ jsonrpc: '2.0', id: 1, method: 'claude.getCliPath' })
  ))
  record(await timed('claude.authStatus', async () =>
    dispatch({ jsonrpc: '2.0', id: 2, method: 'claude.authStatus' })
  ))
  record(await timed('claude.accountList', async () =>
    dispatch({ jsonrpc: '2.0', id: 3, method: 'claude.accountList' })
  ))

  // --- Phase 6-9: the 4 metadata RPCs that fire on panel mount ---
  // Each currently spawns its own sdk.query() instance. This is what
  // Tony flagged: 4× cold SDK query spawns in a row.
  record(await timed('getSupportedModels (1st)', async () =>
    dispatch({ jsonrpc: '2.0', id: 11, method: 'claude.getSupportedModels' })
  ))
  record(await timed('getSupportedCommands (1st)', async () =>
    dispatch({ jsonrpc: '2.0', id: 12, method: 'claude.getSupportedCommands' })
  ))
  record(await timed('getSupportedAgents (1st)', async () =>
    dispatch({ jsonrpc: '2.0', id: 13, method: 'claude.getSupportedAgents' })
  ))
  record(await timed('getAccountInfo (1st)', async () =>
    dispatch({ jsonrpc: '2.0', id: 14, method: 'claude.getAccountInfo' })
  ))

  // Second round — would benefit from a per-process cache (the fix
  // Tony suggested in (2)). Right now each call cold-spawns again.
  record(await timed('getSupportedModels (2nd)', async () =>
    dispatch({ jsonrpc: '2.0', id: 21, method: 'claude.getSupportedModels' })
  ))
  record(await timed('getSupportedCommands (2nd)', async () =>
    dispatch({ jsonrpc: '2.0', id: 22, method: 'claude.getSupportedCommands' })
  ))
  record(await timed('getSupportedAgents (2nd)', async () =>
    dispatch({ jsonrpc: '2.0', id: 23, method: 'claude.getSupportedAgents' })
  ))
  record(await timed('getAccountInfo (2nd)', async () =>
    dispatch({ jsonrpc: '2.0', id: 24, method: 'claude.getAccountInfo' })
  ))

  // --- Summary ---
  process.stderr.write('\nSummary (sorted by cost):\n')
  process.stderr.write('-------------------------\n')
  const sorted = [...rows].sort((a, b) => b.elapsed - a.elapsed)
  for (const r of sorted) {
    process.stderr.write(`  ${fmt(r.elapsed).padStart(10)}  ${r.label}\n`)
  }
  const panelMountTotal = rows
    .filter(r => /\(1st\)|authStatus|accountList|getCliPath/.test(r.label))
    .reduce((s, r) => s + r.elapsed, 0)
  process.stderr.write(`\nPanel-mount path (excluding module import): ${fmt(panelMountTotal)}\n`)
  process.stderr.write(`Total (with module import + SDK load):    ${fmt(panelMountTotal + importMs + (rows.find(r => r.label.includes('SDK (cold)'))?.elapsed ?? 0))}\n`)

  // Also emit JSON to stdout so a wrapper can parse it.
  process.stdout.write(JSON.stringify({
    rows: rows.map(r => ({ label: r.label, ms: r.elapsed, ok: !r.err })),
    panelMountTotal,
  }, null, 2) + '\n')
}

main().catch(err => {
  process.stderr.write(`bench failed: ${err.stack || err.message || err}\n`)
  process.exit(1)
})
