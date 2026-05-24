// Tests for the experimental Claude Channel Agent runtime.
//
// Run with: node node-sidecar/tests/claude-channel-runtime.test.mjs

import * as assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __setSendEventForTests } from '../src/lib/protocol.mjs'
import { buildClaudeChannelServerSource } from '../src/runtimes/claude-channel-server.mjs'
import {
  __resetClaudeChannelSessionsForTests,
  getClaudeChannelCapabilities,
  getClaudeChannelStatus,
  sendClaudeChannelMessage,
  startClaudeChannelSession,
  stopClaudeChannelSession,
} from '../src/runtimes/claude-channel-runtime.mjs'

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ])
}

function readFrame(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for MCP frame'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`MCP server exited before frame code=${code} signal=${signal}`))
    }
    const onData = chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)])
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = buffer.slice(0, headerEnd).toString('utf8')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        cleanup()
        reject(new Error(`missing Content-Length in ${header}`))
        return
      }
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + Number(match[1])
      if (buffer.length < bodyEnd) return
      cleanup()
      resolve(JSON.parse(buffer.slice(bodyStart, bodyEnd).toString('utf8')))
    }
    child.stdout.on('data', onData)
    child.on('exit', onExit)
  })
}

async function testGeneratedChannelServer(tmpRoot) {
  const source = buildClaudeChannelServerSource()
  assert.equal(source.includes('@modelcontextprotocol/sdk'), false)
  assert.equal(source.includes('import '), false)

  let replyBody = null
  let readyBody = null
  const bridge = createServer((req, res) => {
    if (req.url?.startsWith('/events')) {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url === '/ready' && req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        readyBody = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    if (req.url === '/reply' && req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        replyBody = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve, reject) => {
    bridge.once('error', reject)
    bridge.listen(0, '127.0.0.1', resolve)
  })
  const address = bridge.address()
  const bridgeUrl = `http://127.0.0.1:${address.port}`
  const serverPath = join(tmpRoot, 'generated-channel-server.mjs')
  writeFileSync(serverPath, source, { mode: 0o755 })
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BAT_CHANNEL_BRIDGE_URL: bridgeUrl,
      BAT_CHANNEL_SESSION_ID: 'stdio-test',
    },
  })
  try {
    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    }))
    const initialized = await readFrame(child)
    assert.equal(initialized.id, 1)
    assert.equal(initialized.result?.serverInfo?.name, 'bat')
    assert.deepEqual(initialized.result?.capabilities?.experimental, { 'claude/channel': {} })

    child.stdin.write(frame({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }))
    for (let i = 0; i < 50; i += 1) {
      if (readyBody) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(readyBody?.sessionId, 'stdio-test')

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    }))
    const tools = await readFrame(child)
    assert.equal(tools.id, 2)
    assert.equal(tools.result?.tools?.[0]?.name, 'bat_reply')

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'bat_reply',
        arguments: {
          bat_session_id: 'stdio-test',
          bat_message_id: 'msg-1',
          text: 'hello stdio',
          status: 'final',
        },
      },
    }))
    const toolResult = await readFrame(child)
    assert.equal(toolResult.id, 3)
    assert.equal(toolResult.result?.content?.[0]?.text, 'Delivered to Better Agent Terminal.')
    assert.equal(replyBody?.text, 'hello stdio')
    assert.equal(replyBody?.sessionId, 'stdio-test')
  } finally {
    child.kill()
    await new Promise(resolve => bridge.close(resolve))
  }
}

async function main() {
  const savedDebug = process.env.BAT_DEBUG
  const savedDataDir = process.env.BAT_SIDECAR_DATA_DIR
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'sidecar-channel-cli-'))
  const fakeClaude = join(fakeBinDir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const fakeClaudeJs = join(fakeBinDir, 'claude.js')
  const fakeDataDir = mkdtempSync(join(tmpdir(), 'sidecar-channel-data-'))
  const bridgeOut = join(fakeBinDir, 'bridge-url.txt')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('2.1.119 (Claude Code)')
  process.exit(0)
}
if (args[0] === '--help') {
  console.log('--model --permission-mode --effort')
  process.exit(0)
}
const configIndex = args.indexOf('--mcp-config')
if (configIndex >= 0 && args[configIndex + 1]) {
  const config = JSON.parse(fs.readFileSync(args[configIndex + 1], 'utf8'))
  const bridgeUrl = config.mcpServers?.bat?.env?.BAT_CHANNEL_BRIDGE_URL || ''
  const bridgeSessionId = config.mcpServers?.bat?.env?.BAT_CHANNEL_SESSION_ID || ''
  fs.writeFileSync(process.env.FAKE_CLAUDE_BRIDGE_OUT, bridgeUrl)
  fetch(new URL('/ready', bridgeUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: bridgeSessionId }),
  }).catch(err => {
    console.error('ready failed', err instanceof Error ? err.message : String(err))
  })
}
if (process.env.FAKE_CLAUDE_EXIT_ON_START === '1') {
  console.error(process.env.FAKE_CLAUDE_EXIT_MESSAGE || 'channel startup failed')
  process.exit(2)
}
if (process.env.FAKE_CLAUDE_EXIT_AFTER_START === '1') {
  setTimeout(() => {
    console.error(process.env.FAKE_CLAUDE_EXIT_MESSAGE || 'channel dropped')
    process.exit(3)
  }, 600)
}
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

  if (process.platform === 'win32') {
    writeFileSync(fakeClaudeJs, script)
    writeFileSync(fakeClaude, '@echo off\r\nnode "%~dp0claude.js" %*\r\n')
  } else {
    writeFileSync(fakeClaude, script, { mode: 0o755 })
    chmodSync(fakeClaude, 0o755)
  }

  try {
    delete process.env.BAT_DEBUG
    await assert.rejects(
      getClaudeChannelCapabilities({ cliPath: fakeClaude }),
      /BAT_DEBUG/,
    )

    process.env.BAT_DEBUG = '1'
    const caps = await getClaudeChannelCapabilities({ cliPath: fakeClaude })
    assert.equal(caps.supported, true)
    assert.equal(caps.cliVersion, '2.1.119')
    assert.equal(caps.supportsChannels, true)
    assert.equal(caps.supportsModel, true)
    assert.equal(caps.supportsPermissionMode, true)
    assert.equal(caps.supportsThinkingEffort, true)

    await testGeneratedChannelServer(fakeDataDir)

    process.env.BAT_SIDECAR_DATA_DIR = fakeDataDir
    process.env.FAKE_CLAUDE_BRIDGE_OUT = bridgeOut
    const captured = []
    const restoreSend = __setSendEventForTests((name, payload) => captured.push({ name, payload }))
    try {
      process.env.FAKE_CLAUDE_EXIT_ON_START = '1'
      process.env.FAKE_CLAUDE_EXIT_MESSAGE = 'channel policy disabled'
      const failedStart = await startClaudeChannelSession({
        sessionId: 'channel-fail-1',
        cliPath: fakeClaude,
        cwd: fakeBinDir,
      })
      assert.equal(failedStart.ok, false)
      assert.equal(failedStart.status, 'error')
      assert.match(failedStart.error, /channel policy disabled/)
      const failedStatus = await getClaudeChannelStatus({ sessionId: 'channel-fail-1' })
      assert.equal(failedStatus.status, 'error')
      assert.match(failedStatus.error, /channel policy disabled/)
      delete process.env.FAKE_CLAUDE_EXIT_ON_START
      delete process.env.FAKE_CLAUDE_EXIT_MESSAGE
      rmSync(bridgeOut, { force: true })

      process.env.FAKE_CLAUDE_EXIT_AFTER_START = '1'
      process.env.FAKE_CLAUDE_EXIT_MESSAGE = 'channel dropped after ready'
      const droppedStart = await startClaudeChannelSession({
        sessionId: 'channel-drop-1',
        cliPath: fakeClaude,
        cwd: fakeBinDir,
      })
      assert.equal(droppedStart.ok, true)
      let droppedStatus = null
      for (let i = 0; i < 60; i += 1) {
        droppedStatus = captured.find(event => event.name === 'claude-channel:status'
          && event.payload?.sessionId === 'channel-drop-1'
          && event.payload?.status === 'error')
        if (droppedStatus) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(droppedStatus?.payload?.exitCode, 3)
      assert.match(droppedStatus?.payload?.error || '', /channel dropped after ready/)
      const droppedStatusReply = await getClaudeChannelStatus({ sessionId: 'channel-drop-1' })
      assert.equal(droppedStatusReply.status, 'error')
      assert.equal(droppedStatusReply.exitCode, 3)
      assert.match(droppedStatusReply.error || '', /channel dropped after ready/)
      delete process.env.FAKE_CLAUDE_EXIT_AFTER_START
      delete process.env.FAKE_CLAUDE_EXIT_MESSAGE
      await stopClaudeChannelSession({ sessionId: 'channel-drop-1' }).catch(() => {})
      rmSync(bridgeOut, { force: true })

      const started = await startClaudeChannelSession({
        sessionId: 'channel-life-1',
        cliPath: fakeClaude,
        cwd: fakeBinDir,
        workspaceId: 'workspace-1',
        model: 'claude-sonnet-4-6',
        permissionMode: 'default',
        effort: 'high',
      })
      assert.equal(started.ok, true)
      assert.equal(started.status, 'ready')
      assert.equal(started.channelStatus, 'connected')

      let bridgeUrl = ''
      for (let i = 0; i < 50; i += 1) {
        if (existsSync(bridgeOut)) {
          bridgeUrl = readFileSync(bridgeOut, 'utf8')
          if (bridgeUrl) break
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.match(bridgeUrl, /^http:\/\/127\.0\.0\.1:\d+$/)

      const sent = await sendClaudeChannelMessage({
        sessionId: 'channel-life-1',
        prompt: 'hello channel',
        messageId: 'channel-msg-1',
      })
      assert.equal(sent.ok, true)
      assert.equal(sent.messageId, 'channel-msg-1')

      const eventResponse = await fetch(`${bridgeUrl}/events?sessionId=channel-life-1`)
      assert.equal(eventResponse.status, 200)
      const channelEvent = await eventResponse.json()
      assert.equal(channelEvent.content, 'hello channel')
      assert.equal(channelEvent.meta.bat_session_id, 'channel-life-1')
      assert.equal(channelEvent.meta.bat_message_id, 'channel-msg-1')
      assert.equal(channelEvent.meta.workspace_id, 'workspace-1')

      const replyResponse = await fetch(`${bridgeUrl}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'channel-life-1',
          bat_message_id: 'channel-msg-1',
          text: 'hello BAT',
          status: 'final',
        }),
      })
      assert.equal(replyResponse.status, 200)

      const eventNames = captured.map(event => event.name)
      assert.ok(eventNames.includes('claude-channel:status'))
      assert.ok(eventNames.includes('claude-channel:message'))
      assert.ok(eventNames.includes('claude-channel:turn-end'))
      const assistantMessage = captured.find(event => event.name === 'claude-channel:message' && event.payload?.role === 'assistant')
      assert.equal(assistantMessage?.payload?.text, 'hello BAT')

      const stopped = await stopClaudeChannelSession({ sessionId: 'channel-life-1' })
      assert.equal(stopped.ok, true)
      assert.equal(stopped.existed, true)
    } finally {
      restoreSend()
      await stopClaudeChannelSession({ sessionId: 'channel-life-1' }).catch(() => {})
      await __resetClaudeChannelSessionsForTests()
    }
  } finally {
    if (savedDebug === undefined) delete process.env.BAT_DEBUG
    else process.env.BAT_DEBUG = savedDebug
    if (savedDataDir === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
    else process.env.BAT_SIDECAR_DATA_DIR = savedDataDir
    delete process.env.FAKE_CLAUDE_BRIDGE_OUT
    delete process.env.FAKE_CLAUDE_EXIT_ON_START
    delete process.env.FAKE_CLAUDE_EXIT_AFTER_START
    delete process.env.FAKE_CLAUDE_EXIT_MESSAGE
    rmSync(fakeBinDir, { recursive: true, force: true })
    rmSync(fakeDataDir, { recursive: true, force: true })
  }

  console.log('claude-channel-runtime: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
