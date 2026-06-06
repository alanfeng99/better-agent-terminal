#!/usr/bin/env node
// Bundle the Tauri Node sidecar source tree into a single ESM entry file.
// Keep only platform-specific native SDK packages external so release
// resources do not need to extract the whole sidecar node_modules tree.

import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const entry = join(repoRoot, 'node-sidecar', 'src', 'server.mjs')
const outfile = join(repoRoot, 'node-sidecar', 'dist', 'server.mjs')

await mkdir(dirname(outfile), { recursive: true })
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  external: [
    '@anthropic-ai/claude-agent-sdk-*',
    // node-pty is a native module: its Windows conpty path uses `__dirname` and
    // forks on-disk helper files, neither of which survive ESM bundling. Keep it
    // external so it loads from node_modules at runtime (createRequire/dynamic
    // import); when it's unavailable the channel runtime falls back to
    // child_process instead of crashing with "__dirname is not defined".
    '@lydell/node-pty',
  ],
  banner: {
    js: "import { createRequire as __batCreateRequire } from 'node:module'; const require = __batCreateRequire(import.meta.url);",
  },
  legalComments: 'eof',
})

console.log(`[build-node-sidecar] bundled ${entry} -> ${outfile}`)
