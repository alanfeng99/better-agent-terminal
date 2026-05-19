import assert from 'node:assert/strict'
import { shouldNavigateInputHistory } from '../renderer/src/utils/input-history-navigation'

assert.equal(
  shouldNavigateInputHistory('previous', { value: 'hello', selectionStart: 0, selectionEnd: 0 }),
  true,
)
assert.equal(
  shouldNavigateInputHistory('previous', { value: 'hello', selectionStart: 5, selectionEnd: 5 }),
  true,
)
assert.equal(
  shouldNavigateInputHistory('next', { value: 'hello', selectionStart: 0, selectionEnd: 0 }),
  true,
)
assert.equal(
  shouldNavigateInputHistory('next', { value: 'hello', selectionStart: 5, selectionEnd: 5 }),
  true,
)

assert.equal(
  shouldNavigateInputHistory('previous', { value: 'first\nsecond', selectionStart: 2, selectionEnd: 2 }),
  true,
)
assert.equal(
  shouldNavigateInputHistory('previous', { value: 'first\nsecond', selectionStart: 6, selectionEnd: 6 }),
  false,
)
assert.equal(
  shouldNavigateInputHistory('previous', { value: 'first\nsecond', selectionStart: 12, selectionEnd: 12 }),
  false,
)

assert.equal(
  shouldNavigateInputHistory('next', { value: 'first\nsecond', selectionStart: 0, selectionEnd: 0 }),
  false,
)
assert.equal(
  shouldNavigateInputHistory('next', { value: 'first\nsecond', selectionStart: 5, selectionEnd: 5 }),
  false,
)
assert.equal(
  shouldNavigateInputHistory('next', { value: 'first\nsecond', selectionStart: 6, selectionEnd: 6 }),
  true,
)

assert.equal(
  shouldNavigateInputHistory('previous', { value: 'first\nsecond', selectionStart: 0, selectionEnd: 5 }),
  false,
)
assert.equal(
  shouldNavigateInputHistory('next', { value: 'first\nsecond', selectionStart: 6, selectionEnd: 12 }),
  false,
)

assert.equal(
  shouldNavigateInputHistory('previous', { value: 'first\nsecond' }),
  false,
)
assert.equal(
  shouldNavigateInputHistory('next', { value: 'single line' }),
  true,
)

console.info('input history navigation tests passed')
