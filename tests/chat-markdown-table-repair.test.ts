// Tests for repairBrokenTableRows in renderer/src/utils/chat-markdown.ts —
// models occasionally hard-wrap a table row mid-cell, which makes GFM reject
// the entire table and render it as a run-on paragraph.
//
// Run with: tsx tests/chat-markdown-table-repair.test.ts

import * as assert from 'node:assert/strict'
import { marked } from 'marked'
import { repairBrokenTableRows } from '../renderer/src/utils/chat-markdown'

let failures = 0
function test(name: string, fn: () => void) {
  try { fn(); console.log('  ok  -', name) } catch (err) {
    failures++
    console.error('  FAIL-', name, '\n   ', err instanceof Error ? err.message : err)
  }
}

// The exact in-the-wild case: header row split inside a CJK word.
const broken = [
  '## 對照表',
  '',
  '| # | 桌面變更 | mobile 現況 | 該不該做 | 工',
  '程量 |',
  '|---|---------|------------|---------|------|',
  '| 1 | **workspace** `windowId` | 仍在送 | 要 | 低 |',
].join('\n')

test('repairs the real-world broken CJK header row', () => {
  const repaired = repairBrokenTableRows(broken)
  assert.ok(repaired.includes('| # | 桌面變更 | mobile 現況 | 該不該做 | 工程量 |'))
  assert.ok((marked.parse(repaired) as string).includes('<table'))
})

test('repairs a broken BODY row too', () => {
  const text = [
    '| A | B |',
    '|---|---|',
    '| long content that',
    'wrapped | x |',
  ].join('\n')
  const repaired = repairBrokenTableRows(text)
  assert.ok(repaired.includes('| long content thatwrapped | x |'))
  assert.ok((marked.parse(repaired) as string).includes('<table'))
})

test('leaves well-formed tables untouched', () => {
  const ok = ['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n')
  assert.equal(repairBrokenTableRows(ok), ok)
})

test('does nothing when there is no delimiter row', () => {
  const text = '| just a pipe-leading line\nwithout any table'
  assert.equal(repairBrokenTableRows(text), text)
})

test('never joins inside fenced code blocks', () => {
  const text = [
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '```',
    '| raw pipe line without terminator',
    'next code line |',
    '```',
  ].join('\n')
  assert.equal(repairBrokenTableRows(text), text)
})

test('gives up when no terminator appears within a few lines', () => {
  const text = [
    '| A | B |',
    '|---|---|',
    '| dangling start',
    'one', 'two', 'three', 'four', 'five',
  ].join('\n')
  assert.equal(repairBrokenTableRows(text), text)
})

console.log(failures === 0 ? '\nchat-markdown-table-repair: passed' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
