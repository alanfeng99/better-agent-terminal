import assert from 'node:assert/strict'
import { createPtyInputWriter } from '../renderer/src/utils/pty-input-writer'
import {
  getTerminalKeyInputOverride,
  shouldBlockForImeComposition,
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

async function main() {
  const calls: string[] = []
  const first = deferred()
  const writer = createPtyInputWriter((chunk) => {
    calls.push(chunk)
    return first.promise
  })

  writer.write('a')
  await drainMicrotasks()
  assert.deepEqual(calls, ['a'])

  writer.write('b')
  writer.write('c')
  await drainMicrotasks()
  assert.deepEqual(calls, ['a'])

  first.resolve()
  await drainMicrotasks()
  assert.deepEqual(calls, ['a', 'bc'])

  {
    const calls: string[] = []
    const writer = createPtyInputWriter((chunk) => {
      calls.push(chunk)
    })

    writer.write('a')
    writer.write('b')
    await drainMicrotasks()
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
    await drainMicrotasks()
    writer.write('b')
    writer.dispose()
    first.resolve()
    await drainMicrotasks()

    assert.deepEqual(calls, ['a'])
  }

  {
    const calls: string[] = []
    const first = deferred()
    const writer = createPtyInputWriter((chunk) => {
      calls.push(chunk)
      if (calls.length === 1) return first.promise
    })

    for (const ch of 'open') {
      writer.write(ch)
      await drainMicrotasks()
    }

    assert.deepEqual(calls, ['o'])
    first.resolve()
    await drainMicrotasks()

    assert.equal(calls.join(''), 'open')
    assert.deepEqual(calls, ['o', 'pen'])
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
  }

  console.info('pty input writer tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
