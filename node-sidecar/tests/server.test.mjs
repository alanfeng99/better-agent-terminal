// Tests for the Node sidecar JSON-RPC server.
//
// Two layers:
//   - dispatch() is exercised in-process (no spawn) so we can assert on
//     handler logic without paying for a child Node startup per test.
//   - One end-to-end test spawns the server as a real child to verify
//     the line-delimited stdio protocol survives the round trip.
//
// Run with: pnpm exec node node-sidecar/tests/server.test.mjs

import * as assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = resolve(here, '..', 'src', 'server.mjs')

async function inProcess() {
  const mod = await import('../src/server.mjs')
  const { dispatch, handlers, registerHandler } = mod

  // ping echoes params and returns pid + ok flag.
  const pingReply = await dispatch({ jsonrpc: '2.0', id: 1, method: 'ping', params: { hi: 'there' } })
  assert.equal(pingReply.jsonrpc, '2.0')
  assert.equal(pingReply.id, 1)
  assert.equal(pingReply.result.ok, true)
  assert.deepEqual(pingReply.result.echo, { hi: 'there' })
  assert.equal(typeof pingReply.result.pid, 'number')

  // claude.authStatus and claude.accountList return MVP stubs.
  const auth = await dispatch({ jsonrpc: '2.0', id: 2, method: 'claude.authStatus' })
  assert.equal(auth.result, null)
  const accounts = await dispatch({ jsonrpc: '2.0', id: 3, method: 'claude.accountList' })
  assert.deepEqual(accounts.result, [])

  // Unknown methods produce a -32601 error and preserve the request id.
  const unknown = await dispatch({ jsonrpc: '2.0', id: 7, method: 'no.such.method' })
  assert.equal(unknown.error.code, -32601)
  assert.equal(unknown.id, 7)

  // Notifications (no id) get no response object back.
  const notif = await dispatch({ jsonrpc: '2.0', method: 'ping' })
  assert.equal(notif, null)

  // Handler that throws produces -32000 with the message verbatim.
  registerHandler('test.boom', async () => { throw new Error('kapow') })
  const boom = await dispatch({ jsonrpc: '2.0', id: 9, method: 'test.boom' })
  assert.equal(boom.error.code, -32000)
  assert.equal(boom.error.message, 'kapow')

  // Duplicate registration throws — protects us against accidental override.
  assert.throws(() => registerHandler('ping', () => 1), /already registered/)
  assert.ok(handlers.has('ping'))

  // Session lifecycle stubs validate sessionId and return ok.
  const start = await dispatch({ jsonrpc: '2.0', id: 100, method: 'claude.startSession', params: { sessionId: 's-1', options: { cwd: '/x' } } })
  assert.equal(start.result.ok, true)
  assert.equal(start.result.sessionId, 's-1')
  const stop = await dispatch({ jsonrpc: '2.0', id: 101, method: 'claude.stopSession', params: { sessionId: 's-1' } })
  assert.equal(stop.result.ok, true)
  assert.equal(stop.result.existed, true)
  // Stopping an unknown session returns existed=false rather than erroring.
  const stop2 = await dispatch({ jsonrpc: '2.0', id: 102, method: 'claude.stopSession', params: { sessionId: 'unknown' } })
  assert.equal(stop2.result.existed, false)
  // Missing sessionId rejects.
  const bad = await dispatch({ jsonrpc: '2.0', id: 103, method: 'claude.sendMessage', params: {} })
  assert.equal(bad.error.code, -32000)
  assert.match(bad.error.message, /missing sessionId/)

  // compareVersions semantics — pure helper, doesn't hit network.
  const { compareVersions } = mod
  assert.equal(compareVersions('1.2.3', '1.2.4'), true)
  assert.equal(compareVersions('1.2.3', '1.2.3'), false)
  assert.equal(compareVersions('1.2.3', '1.2.2'), false)
  assert.equal(compareVersions('v1.2.3', 'v1.2.4'), true)
  assert.equal(compareVersions('1.0', '1.0.1'), true)
  assert.equal(compareVersions('2.0.0', '1.99.99'), false)
}

// End-to-end: spawn `node server.mjs`, send a few requests, assert replies.
async function endToEnd() {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  // Capture stderr so a hidden crash surfaces if the test fails.
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })

  const replies = []
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    const trimmed = line.trim()
    if (!trimmed) return
    replies.push(JSON.parse(trimmed))
  })

  function send(req) {
    child.stdin.write(JSON.stringify(req) + '\n')
  }

  send({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 1 } })
  send({ jsonrpc: '2.0', id: 2, method: 'claude.authStatus' })
  send({ jsonrpc: '2.0', id: 3, method: 'no.such' })
  // Lifecycle pair: startSession then sendMessage. sendMessage triggers
  // two event notifications (claude:message + claude:turn-end), so the
  // total emission count from the server is 4 + 2 = 6 lines.
  send({ jsonrpc: '2.0', id: 4, method: 'claude.startSession', params: { sessionId: 'e2e-1', options: { cwd: '/' } } })
  send({ jsonrpc: '2.0', id: 5, method: 'claude.sendMessage', params: { sessionId: 'e2e-1', prompt: 'hi' } })

  // Poll until we see all 5 replies. Events go to a separate accumulator.
  const events = replies // alias for readability — we filter below
  const deadline = Date.now() + 5000
  while (replies.filter(r => r.id !== undefined).length < 5 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25))
  }
  // Give events a moment to flush, since the server emits them before the
  // sendMessage reply but they may interleave on Windows pipes.
  await new Promise(r => setTimeout(r, 100))

  child.stdin.end()
  await new Promise(r => child.once('close', r))

  const idReplies = events.filter(r => r.id !== undefined && r.id !== null)
  const eventNotifs = events.filter(r => typeof r.method === 'string' && r.method.startsWith('event:'))
  if (idReplies.length !== 5) {
    throw new Error(`sidecar e2e: expected 5 id-replies, got ${idReplies.length}; stderr=${stderr}`)
  }
  // The server dispatches handlers concurrently (rl.on('line', async ...)),
  // so responses are not guaranteed to arrive in request order. Index
  // by id, which is what a real client (the Rust bridge) does anyway.
  const byId = new Map(idReplies.map(r => [r.id, r]))
  assert.equal(byId.get(1).result.ok, true)
  assert.deepEqual(byId.get(1).result.echo, { x: 1 })
  assert.equal(byId.get(2).result, null)
  assert.equal(byId.get(3).error.code, -32601)
  assert.equal(byId.get(4).result.ok, true)
  assert.equal(byId.get(4).result.sessionId, 'e2e-1')
  assert.equal(byId.get(5).result.ok, true)

  // sendMessage must have produced both events.
  const eventNames = new Set(eventNotifs.map(e => e.method))
  assert.ok(eventNames.has('event:claude:message'), `expected event:claude:message, got ${[...eventNames]}`)
  assert.ok(eventNames.has('event:claude:turn-end'), `expected event:claude:turn-end, got ${[...eventNames]}`)
}

async function run() {
  await inProcess()
  await endToEnd()
  console.log('node-sidecar: passed')
}

run().catch(err => {
  console.error(err)
  process.exitCode = 1
})
