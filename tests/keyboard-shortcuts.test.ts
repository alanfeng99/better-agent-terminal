import assert from 'node:assert/strict'
import { isBackquoteShortcutEvent, isImeReservedKeyEvent } from '../renderer/src/utils/keyboard-shortcuts'

assert.equal(isBackquoteShortcutEvent({ key: '`', code: 'Backquote' }), true)
assert.equal(isBackquoteShortcutEvent({ key: '~', code: 'Backquote' }), true)
assert.equal(isBackquoteShortcutEvent({ key: 'Dead', code: 'Backquote' }), false)
assert.equal(isBackquoteShortcutEvent({ key: 'Process', code: 'Backquote', keyCode: 229 }), false)
assert.equal(isBackquoteShortcutEvent({ key: 'Unidentified', code: 'Backquote' }), false)
assert.equal(isBackquoteShortcutEvent({ key: 'a', code: 'KeyA' }), false)

assert.equal(isImeReservedKeyEvent({ key: '`', code: 'Backquote', isComposing: true }), true)
assert.equal(isImeReservedKeyEvent({ key: '`', code: 'Backquote', keyCode: 229 }), true)
assert.equal(isImeReservedKeyEvent({ key: '`', code: 'Backquote', which: 229 }), true)

console.info('keyboard shortcut tests passed')
