// Tests for the Claude CLI (subscription) agent building blocks:
//   - claude-cli-frames.mjs   (transcript classifier)
//   - claude-cli-transcript.mjs (locator + incremental tailer)
//
// Deterministic + offline: synthetic transcript lines, no `claude` spawn,
// no tokens. Run with: node node-sidecar/tests/claude-cli.test.mjs

import * as assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseTranscriptLine, FRAME_KINDS, FRAME_CATEGORY } from '../src/runtimes/claude-cli-frames.mjs'
import { createTranscriptTailer, locateTranscriptBySessionId } from '../src/runtimes/claude-cli-transcript.mjs'

let failures = 0
function test(name, fn) {
  try { fn(); console.log('  ok  -', name) } catch (err) {
    failures++; console.error('  FAIL-', name, '\n   ', err.message)
  }
}

const L = {
  userString: JSON.stringify({
    type: 'user', sessionId: 's1', uuid: 'u1', timestamp: 't',
    message: { role: 'user', content: 'hello world' },
  }),
  assistantMulti: JSON.stringify({
    type: 'assistant', sessionId: 's1', uuid: 'a1', timestamp: 't',
    message: {
      role: 'assistant', model: 'claude-opus-4-8',
      content: [
        { type: 'thinking', thinking: 'let me think', signature: 'sig' },
        { type: 'text', text: 'here is my reply' },
        { type: 'tool_use', id: 'tool1', name: 'Read', input: { file: 'x' } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
    },
  }),
  toolResult: JSON.stringify({
    type: 'user', sessionId: 's1', uuid: 'u2', timestamp: 't',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'file body', is_error: false }] },
  }),
  bookkeeping: JSON.stringify({ type: 'ai-title', title: 'whatever' }),
}

// ---- classifier ----

test('user string -> you', () => {
  const f = parseTranscriptLine(L.userString)
  assert.equal(f.length, 1)
  assert.equal(f[0].kind, FRAME_KINDS.USER)
  assert.equal(FRAME_CATEGORY[f[0].kind], 'you')
  assert.equal(f[0].payload.text, 'hello world')
})

test('assistant multi-block -> thinking + message + tool + usage', () => {
  const f = parseTranscriptLine(L.assistantMulti)
  const kinds = f.map(x => x.kind)
  assert.deepEqual(kinds, [FRAME_KINDS.THINKING, FRAME_KINDS.ASSISTANT, FRAME_KINDS.TOOL_USE, FRAME_KINDS.USAGE])
  assert.equal(f[0].payload.text, 'let me think')
  assert.equal(f[2].payload.name, 'Read')
  assert.equal(f[3].payload.model, 'claude-opus-4-8')
  assert.equal(f[3].payload.output_tokens, 5)
  // Each frame carries its block index so consumers can build entry ids that
  // don't collide when blocks share message.id.
  assert.equal(f[0].meta.blockIndex, 0)
  assert.equal(f[1].meta.blockIndex, 1)
  assert.equal(f[2].meta.blockIndex, 2)
})

test('user tool_result -> tool (not you)', () => {
  const f = parseTranscriptLine(L.toolResult)
  assert.equal(f.length, 1)
  assert.equal(f[0].kind, FRAME_KINDS.TOOL_RESULT)
  assert.equal(FRAME_CATEGORY[f[0].kind], 'tool')
  assert.equal(f[0].payload.tool_use_id, 'tool1')
})

test('bookkeeping rows are skipped', () => {
  assert.deepEqual(parseTranscriptLine(L.bookkeeping), [])
  assert.deepEqual(parseTranscriptLine(''), [])
  assert.deepEqual(parseTranscriptLine('{not json'), [])
})

// ---- tailer ----

test('tailer streams appended lines + handles split lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bat-cli-tail-'))
  const file = join(dir, 'sess.jsonl')
  const got = []
  let tailer
  try {
    tailer = createTranscriptTailer({ filePath: file, onFrames: fr => got.push(...fr), pollMs: 9999 })
    tailer._flushNow() // file doesn't exist yet
    assert.equal(got.length, 0)

    writeFileSync(file, L.userString + '\n')
    tailer._flushNow()
    assert.equal(got.length, 1)
    assert.equal(got[0].kind, FRAME_KINDS.USER)

    appendFileSync(file, L.assistantMulti + '\n' + L.toolResult + '\n')
    tailer._flushNow()
    const kinds = got.map(g => g.kind)
    assert.deepEqual(kinds, [
      FRAME_KINDS.USER, FRAME_KINDS.THINKING, FRAME_KINDS.ASSISTANT,
      FRAME_KINDS.TOOL_USE, FRAME_KINDS.USAGE, FRAME_KINDS.TOOL_RESULT,
    ])

    // split a line across two writes (no trailing newline first)
    const half = L.userString.slice(0, 12)
    const rest = L.userString.slice(12)
    appendFileSync(file, half)
    tailer._flushNow()
    assert.equal(got.length, 6) // buffered, nothing new
    appendFileSync(file, rest + '\n')
    tailer._flushNow()
    assert.equal(got.length, 7)
    assert.equal(got[6].kind, FRAME_KINDS.USER)
  } finally {
    tailer?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('locateTranscriptBySessionId finds nested file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bat-cli-loc-'))
  try {
    const proj = join(dir, 'projects', 'C--some-cwd')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'abc-123.jsonl'), '')
    const found = locateTranscriptBySessionId('abc-123', { projectsDir: join(dir, 'projects') })
    assert.equal(found, join(proj, 'abc-123.jsonl'))
    assert.equal(locateTranscriptBySessionId('nope', { projectsDir: join(dir, 'projects') }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
