// Structure-only inspector for Claude Code session transcripts.
//
// Prints the SHAPE of a transcript JSONL (envelope types, message keys,
// content-block types, presence of usage/model) WITHOUT printing any
// conversation text. Used to ground the claude-cli transcript classifier.
//
// Usage: node node-sidecar/scripts/inspect-transcript-schema.mjs <path-to.jsonl>

import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('usage: node inspect-transcript-schema.mjs <path-to.jsonl>')
  process.exit(2)
}

function add(map, key) {
  map.set(key, (map.get(key) || 0) + 1)
}

function blockTypesOf(content) {
  if (typeof content === 'string') return ['<string>']
  if (Array.isArray(content)) {
    return content.map(b => (b && typeof b === 'object' ? String(b.type ?? '<no-type>') : typeof b))
  }
  return [`<${content === null ? 'null' : typeof content}>`]
}

const raw = readFileSync(path, 'utf8')
const lines = raw.split('\n').filter(l => l.trim().length > 0)

const envelopeTypes = new Map()       // top-level "type"
const topKeys = new Set()             // union of top-level keys
const messageKeys = new Set()         // union of message keys
const usageKeys = new Set()           // union of message.usage keys
const comboCounts = new Map()         // `${type}|${role}|${blockType}`
const blockKeySamples = new Map()     // blockType -> union of keys
let withUsage = 0
let withModel = 0
let parseErrors = 0

for (const line of lines) {
  let obj
  try { obj = JSON.parse(line) } catch { parseErrors++; continue }
  if (!obj || typeof obj !== 'object') continue
  for (const k of Object.keys(obj)) topKeys.add(k)
  add(envelopeTypes, String(obj.type ?? '<none>'))
  const msg = obj.message
  if (msg && typeof msg === 'object') {
    for (const k of Object.keys(msg)) messageKeys.add(k)
    if (msg.usage && typeof msg.usage === 'object') {
      withUsage++
      for (const k of Object.keys(msg.usage)) usageKeys.add(k)
    }
    if (typeof msg.model === 'string') withModel++
    const role = String(msg.role ?? '<none>')
    for (const bt of blockTypesOf(msg.content)) {
      add(comboCounts, `${obj.type}|role=${role}|block=${bt}`)
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && typeof b === 'object') {
          const set = blockKeySamples.get(b.type) || new Set()
          for (const k of Object.keys(b)) set.add(k)
          blockKeySamples.set(b.type, set)
        }
      }
    }
  }
}

const sorted = m => [...m.entries()].sort((a, b) => b[1] - a[1])

console.log('=== transcript schema (structure only) ===')
console.log('file lines:', lines.length, 'parseErrors:', parseErrors)
console.log('\n-- top-level keys --\n', [...topKeys].sort().join(', '))
console.log('\n-- envelope types --')
for (const [k, n] of sorted(envelopeTypes)) console.log(`  ${k}: ${n}`)
console.log('\n-- message keys --\n', [...messageKeys].sort().join(', '))
console.log(`\n-- usage --  lines with usage: ${withUsage}, with model: ${withModel}`)
console.log('  usage keys:', [...usageKeys].sort().join(', ') || '(none)')
console.log('\n-- (type | role | block) combos --')
for (const [k, n] of sorted(comboCounts)) console.log(`  ${k}: ${n}`)
console.log('\n-- content block keys (per block type) --')
for (const [bt, set] of blockKeySamples) console.log(`  ${bt}: ${[...set].sort().join(', ')}`)
