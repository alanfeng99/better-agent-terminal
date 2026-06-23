// Verify claude-cli-frames against REAL transcripts (counts only, no content).
//
// Walks <configDir>/projects (or a dir/glob arg), classifies every line, and
// reports frame-kind tallies + invariants. Prints NO conversation text.
//
// Usage:
//   node node-sidecar/scripts/verify-classify-transcripts.mjs [dir] [maxFiles]

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseTranscriptLine, FRAME_KINDS, FRAME_CATEGORY } from '../src/runtimes/claude-cli-frames.mjs'

function projectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'projects')
}

function findJsonl(dir, out) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) findJsonl(full, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
  }
}

const dirArg = process.argv[2] || projectsDir()
const maxFiles = Number(process.argv[3] || 40)

const files = []
findJsonl(dirArg, files) // collect ALL, then sort by size, then pick
if (files.length === 0) {
  console.error('no .jsonl files under', dirArg)
  process.exit(2)
}
// Largest files first → exercise the most varied content.
files.sort((a, b) => statSync(b).size - statSync(a).size)
const picked = files.slice(0, maxFiles)

const kindCounts = new Map()
const catCounts = new Map()
const toolUseIds = new Set()
const toolResultIds = new Set()
let totalLines = 0
let totalFrames = 0
let threw = 0
let leakSuspect = 0 // frames missing expected payload shape

for (const f of picked) {
  let raw
  try { raw = readFileSync(f, 'utf8') } catch { continue }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    totalLines++
    let frames
    try { frames = parseTranscriptLine(line) } catch { threw++; continue }
    for (const fr of frames) {
      totalFrames++
      kindCounts.set(fr.kind, (kindCounts.get(fr.kind) || 0) + 1)
      const cat = FRAME_CATEGORY[fr.kind] || '<unknown>'
      catCounts.set(cat, (catCounts.get(cat) || 0) + 1)
      if (fr.kind === FRAME_KINDS.TOOL_USE) toolUseIds.add(fr.payload.id)
      if (fr.kind === FRAME_KINDS.TOOL_RESULT) toolResultIds.add(fr.payload.tool_use_id)
      // shape sanity (no content printed)
      if (fr.kind === FRAME_KINDS.TOOL_USE && !fr.payload.name) leakSuspect++
      if (fr.kind === FRAME_KINDS.ASSISTANT && typeof fr.payload.text !== 'string') leakSuspect++
    }
  }
}

let matched = 0
for (const id of toolResultIds) if (toolUseIds.has(id)) matched++
const orphanResults = toolResultIds.size - matched

console.log('=== classify verification (counts only) ===')
console.log('files:', picked.length, 'lines:', totalLines, 'frames:', totalFrames)
console.log('parse exceptions:', threw, 'shape-suspect frames:', leakSuspect)
console.log('\n-- frames by kind --')
for (const k of Object.values(FRAME_KINDS)) console.log(`  ${k}: ${kindCounts.get(k) || 0}`)
console.log('\n-- frames by category (the 4 buckets + usage) --')
for (const [c, n] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`)
console.log('\n-- tool pairing --')
console.log(`  tool_use ids: ${toolUseIds.size}, tool_result ids: ${toolResultIds.size}`)
console.log(`  results matched to a call: ${matched}, orphan results: ${orphanResults}`)
console.log('\nresult:', threw === 0 && leakSuspect === 0 ? 'PASS' : 'CHECK')
