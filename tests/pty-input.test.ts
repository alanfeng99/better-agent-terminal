import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeInputForPipeShell } from '../electron/pty-input.ts'

test('normalizes carriage returns for plain text pipe input', () => {
  assert.equal(normalizeInputForPipeShell('echo test\r'), 'echo test\n')
  assert.equal(normalizeInputForPipeShell('a\r\nb\r'), 'a\nb\n')
})

test('preserves escape sequences such as arrow keys', () => {
  assert.equal(normalizeInputForPipeShell('\x1b[D'), '\x1b[D')
  assert.equal(normalizeInputForPipeShell('abc\x1b[A\r'), 'abc\x1b[A\r')
})

test('preserves other control characters', () => {
  assert.equal(normalizeInputForPipeShell('\x03'), '\x03')
})
