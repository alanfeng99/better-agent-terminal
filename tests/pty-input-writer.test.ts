import assert from 'node:assert/strict'
import { createPtyInputWriter } from '../renderer/src/utils/pty-input-writer'
import {
  describeTerminalInputData,
  describeTerminalKeyEvent,
  getControlKeyInput,
  getExpectedPlainBackspaceInput,
  getNavigationKeyInput,
  getPrintableKeyInput,
  getTerminalKeyInput,
  getTerminalKeyInputOverride,
  isPrintableTerminalInputData,
  shouldTraceTerminalInputData,
  shouldTraceTerminalKeyEvent,
  shouldBlockForImeComposition,
  shouldUseDirectTerminalKeyInput,
} from '../renderer/src/utils/terminal-key-input'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function drainMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function drainInputWriter() {
  await new Promise((resolve) => setTimeout(resolve, 12))
  await drainMicrotasks()
}

async function main() {
  const calls: string[] = []
  const writer = createPtyInputWriter((chunk) => {
    calls.push(chunk)
  })

  writer.write('a')
  await drainInputWriter()
  assert.deepEqual(calls, ['a'])

  writer.write('b')
  writer.write('c')
  await drainInputWriter()
  assert.deepEqual(calls, ['a', 'bc'])

  {
    const calls: string[] = []
    const writer = createPtyInputWriter((chunk) => {
      calls.push(chunk)
    })

    writer.write('a')
    writer.write('b')
    await drainInputWriter()
    assert.deepEqual(calls, ['ab'])
  }

  {
    const calls: string[] = []
    const first = deferred()
    const writer = createPtyInputWriter((chunk) => {
      calls.push(chunk)
      return first.promise
    })

    writer.write('a')
    await drainInputWriter()
    writer.write('b')
    writer.dispose()
    first.resolve()
    await drainInputWriter()

    assert.deepEqual(calls, ['a'])
  }

  {
    const calls: string[] = []
    const first = deferred()
    const writer = createPtyInputWriter((chunk) => {
      calls.push(chunk)
      if (calls.length === 1) return first.promise
    })

    writer.write('o')
    await drainInputWriter()
    writer.write('p')
    writer.write('e')
    writer.write('n')
    await drainInputWriter()

    assert.deepEqual(calls, ['o'])
    first.resolve()
    await drainInputWriter()

    assert.deepEqual(calls, ['o', 'pen'])
    assert.equal(calls.join(''), 'open')
  }

  {
    assert.equal(
      getTerminalKeyInputOverride({
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        isComposing: true,
      }),
      null,
    )
    assert.equal(
      getTerminalKeyInputOverride({
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
      }, { imeComposing: true }),
      null,
    )
    assert.equal(
      getTerminalKeyInputOverride({
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
      }, { platform: 'darwin' }),
      '\x7f',
    )
    assert.equal(getExpectedPlainBackspaceInput('darwin'), '\x7f')
    assert.equal(getExpectedPlainBackspaceInput('win32'), null)
    assert.equal(shouldUseDirectTerminalKeyInput('darwin'), true)
    assert.equal(shouldUseDirectTerminalKeyInput('linux'), true)
    assert.equal(shouldUseDirectTerminalKeyInput('win32'), false)
    assert.equal(
      getTerminalKeyInputOverride({
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
      }, { platform: 'win32' }),
      null,
    )
    assert.equal(
      getTerminalKeyInputOverride({
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        ctrlKey: true,
      }, { platform: 'darwin' }),
      null,
    )
    assert.equal(
      getTerminalKeyInputOverride({
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
      }, { platform: 'darwin', imeComposing: true }),
      null,
    )
    assert.equal(
      shouldBlockForImeComposition({
        type: 'keydown',
        key: 'a',
        keyCode: 65,
        isComposing: true,
      }, false),
      false,
    )
    assert.equal(
      shouldBlockForImeComposition({
        type: 'keydown',
        key: 'a',
        keyCode: 65,
      }, true),
      true,
    )
    assert.equal(
      getTerminalKeyInputOverride({
        type: 'keydown',
        key: ' ',
        code: 'Space',
        keyCode: 32,
      }),
      null,
    )
    assert.equal(
      shouldTraceTerminalKeyEvent({
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
      }),
      true,
    )
    assert.equal(
      shouldTraceTerminalKeyEvent({
        type: 'keyup',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
      }),
      false,
    )
    assert.equal(
      shouldTraceTerminalKeyEvent({
        type: 'keydown',
        key: 'p',
        code: 'KeyP',
        keyCode: 80,
      }),
      true,
    )
    assert.equal(
      shouldTraceTerminalKeyEvent({
        type: 'keydown',
        key: 'p',
        code: 'KeyP',
        keyCode: 80,
        metaKey: true,
      }),
      false,
    )
    assert.equal(
      getPrintableKeyInput({
        type: 'keydown',
        key: 'p',
        code: 'KeyP',
        keyCode: 80,
      }),
      'p',
    )
    assert.equal(
      getPrintableKeyInput({
        type: 'keydown',
        key: 'P',
        code: 'KeyP',
        keyCode: 80,
        shiftKey: true,
      }),
      'P',
    )
    assert.equal(
      getPrintableKeyInput({
        type: 'keydown',
        key: 'p',
        code: 'KeyP',
        keyCode: 80,
        metaKey: true,
      }),
      null,
    )
    assert.equal(
      getPrintableKeyInput({
        type: 'keydown',
        key: 'p',
        code: 'KeyP',
        keyCode: 229,
      }),
      'p',
    )
    assert.equal(
      getPrintableKeyInput({
        type: 'keydown',
        key: 'p',
        code: 'KeyP',
        keyCode: 229,
        isComposing: true,
      }),
      null,
    )
    assert.equal(
      getPrintableKeyInput({
        type: 'keydown',
        key: 'p',
        code: 'KeyP',
        keyCode: 229,
      }, { imeComposing: true }),
      null,
    )
    assert.equal(
      getControlKeyInput({
        type: 'keydown',
        key: 'c',
        code: 'KeyC',
        keyCode: 67,
        ctrlKey: true,
      }),
      '\x03',
    )
    assert.equal(
      getControlKeyInput({
        type: 'keydown',
        key: 'C',
        code: 'KeyC',
        keyCode: 67,
        ctrlKey: true,
        shiftKey: true,
      }),
      '\x03',
    )
    assert.equal(
      getControlKeyInput({
        type: 'keydown',
        key: 'c',
        code: 'KeyC',
        keyCode: 67,
        ctrlKey: true,
        metaKey: true,
      }),
      null,
    )
    assert.equal(
      getNavigationKeyInput({
        type: 'keydown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
      }),
      '\x1b[D',
    )
    assert.equal(
      getNavigationKeyInput({
        type: 'keydown',
        key: 'Tab',
        code: 'Tab',
        shiftKey: true,
      }),
      '\x1b[Z',
    )
    assert.equal(
      getTerminalKeyInput({
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
      }, { platform: 'darwin' }),
      '\x7f',
    )
    assert.equal(
      getTerminalKeyInput({
        type: 'keydown',
        key: 'p',
        code: 'KeyP',
        keyCode: 229,
      }, { platform: 'darwin' }),
      'p',
    )
    assert.equal(isPrintableTerminalInputData('中文'), true)
    assert.equal(isPrintableTerminalInputData('abc'), true)
    assert.equal(isPrintableTerminalInputData('\r'), false)
    assert.equal(isPrintableTerminalInputData('\x1b[A'), false)
    assert.equal(shouldTraceTerminalInputData('\x7f'), true)
    assert.equal(shouldTraceTerminalInputData(' '), true)
    assert.equal(shouldTraceTerminalInputData('a'), true)
    assert.equal(shouldTraceTerminalInputData('ab'), true)
    assert.deepEqual(
      describeTerminalInputData('\x7f '),
      { length: 2, codes: [127, 32], labels: ['DEL', 'SPACE'] },
    )
    assert.deepEqual(
      describeTerminalKeyEvent({
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
      }),
      {
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        which: undefined,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        isBackspace: true,
        isSpace: false,
      },
    )
  }

  console.info('pty input writer tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
