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
  const frameBodies = []
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
    if (req.url === '/frame' && req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        frameBodies.push(JSON.parse(body))
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
    const toolNames = (tools.result?.tools || []).map(t => t.name)
    assert.deepEqual(
      toolNames.sort(),
      ['bat_assistant', 'bat_emit_frame', 'bat_reply', 'bat_tool_result', 'bat_tool_use'],
    )

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

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'bat_assistant',
        arguments: {
          bat_session_id: 'stdio-test',
          bat_message_id: 'msg-2',
          text: 'partial chunk',
          status: 'partial',
        },
      },
    }))
    const assistantAck = await readFrame(child)
    assert.equal(assistantAck.id, 4)

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'bat_tool_use',
        arguments: {
          bat_session_id: 'stdio-test',
          bat_message_id: 'msg-2',
          id: 'tool-1',
          name: 'Read',
          input: { path: '/etc/hosts' },
        },
      },
    }))
    const toolUseAck = await readFrame(child)
    assert.equal(toolUseAck.id, 5)

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'bat_tool_result',
        arguments: {
          bat_session_id: 'stdio-test',
          bat_message_id: 'msg-2',
          tool_use_id: 'tool-1',
          content: 'localhost',
        },
      },
    }))
    const toolResultAck = await readFrame(child)
    assert.equal(toolResultAck.id, 6)

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'bat_emit_frame',
        arguments: {
          bat_session_id: 'stdio-test',
          bat_message_id: 'msg-2',
          kind: 'result',
          payload: { status: 'success', stop_reason: 'end_turn' },
        },
      },
    }))
    const resultAck = await readFrame(child)
    assert.equal(resultAck.id, 7)

    for (let i = 0; i < 50 && frameBodies.length < 4; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(frameBodies.length, 4)
    assert.equal(frameBodies[0].kind, 'assistant')
    assert.equal(frameBodies[0].payload.text, 'partial chunk')
    assert.equal(frameBodies[0].payload.status, 'partial')
    assert.equal(frameBodies[0].meta?.bat_message_id, 'msg-2')
    assert.equal(frameBodies[1].kind, 'tool_use')
    assert.equal(frameBodies[1].payload.name, 'Read')
    assert.equal(frameBodies[1].payload.id, 'tool-1')
    assert.deepEqual(frameBodies[1].payload.input, { path: '/etc/hosts' })
    assert.equal(frameBodies[2].kind, 'tool_result')
    assert.equal(frameBodies[2].payload.tool_use_id, 'tool-1')
    assert.equal(frameBodies[2].payload.content, 'localhost')
    assert.equal(frameBodies[3].kind, 'result')
    assert.equal(frameBodies[3].payload.status, 'success')
    assert.equal(frameBodies[3].payload.stop_reason, 'end_turn')

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'bat_emit_frame',
        arguments: {
          bat_session_id: 'stdio-test',
          bat_message_id: 'msg-2',
          kind: 'bogus',
          payload: {},
        },
      },
    }))
    const bogusAck = await readFrame(child)
    assert.equal(bogusAck.id, 8)
    assert.ok(bogusAck.error, 'expected error for unknown kind')
    assert.match(bogusAck.error.message || '', /Unknown BAT frame kind/)
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
  const argsOut = join(fakeBinDir, 'claude-args.json')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (process.env.FAKE_CLAUDE_ARGS_OUT) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS_OUT, JSON.stringify(args))
}
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

      process.env.FAKE_CLAUDE_ARGS_OUT = argsOut
      const started = await startClaudeChannelSession({
        sessionId: 'channel-life-1',
        cliPath: fakeClaude,
        cwd: fakeBinDir,
        workspaceId: 'workspace-1',
        model: 'claude-sonnet-4-6',
        permissionMode: 'default',
        effort: 'xhigh',
        ultracode: true,
      })
      assert.equal(started.ok, true)
      assert.equal(started.status, 'ready')
      assert.equal(started.channelStatus, 'connected')
      const startedArgs = JSON.parse(readFileSync(argsOut, 'utf8'))
      assert.equal(startedArgs[startedArgs.indexOf('--effort') + 1], 'xhigh')
      const settingsPath = startedArgs[startedArgs.indexOf('--settings') + 1]
      assert.ok(settingsPath && settingsPath.endsWith('settings.json'), `expected --settings to be a path, got ${settingsPath}`)
      const settingsJson = JSON.parse(readFileSync(settingsPath, 'utf8'))
      assert.equal(settingsJson.ultracode, true)
      assert.equal(settingsJson.enableWorkflows, true)
      assert.ok(settingsJson.hooks && typeof settingsJson.hooks === 'object', 'expected hooks object in settings')
      assert.ok(Array.isArray(settingsJson.hooks.PreToolUse), 'expected PreToolUse hook entry')
      const preToolUseHookConfig = settingsJson.hooks.PreToolUse?.[0]?.hooks?.[0]
      assert.equal(preToolUseHookConfig?.type, 'http')
      assert.match(preToolUseHookConfig?.url || '', /^http:\/\/127\.0\.0\.1:\d+\/hook\/PreToolUse$/)
      for (const ev of ['PostToolUse', 'PostToolUseFailure', 'MessageDisplay', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionStart']) {
        assert.ok(Array.isArray(settingsJson.hooks[ev]), `expected ${ev} hook entry`)
      }
      delete process.env.FAKE_CLAUDE_ARGS_OUT

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

      // Frame round-trip: assistant partial → tool_use → tool_result → result.
      captured.length = 0
      const partialFrame = await fetch(`${bridgeUrl}/frame`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'channel-life-1',
          kind: 'assistant',
          payload: { text: 'thinking out loud', status: 'partial' },
          meta: { bat_message_id: 'channel-msg-2' },
        }),
      })
      assert.equal(partialFrame.status, 200)
      const toolUseFrame = await fetch(`${bridgeUrl}/frame`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'channel-life-1',
          kind: 'tool_use',
          payload: { id: 'tu-1', name: 'Read', input: { path: '/x' } },
          meta: { bat_message_id: 'channel-msg-2' },
        }),
      })
      assert.equal(toolUseFrame.status, 200)
      const toolResultFrame = await fetch(`${bridgeUrl}/frame`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'channel-life-1',
          kind: 'tool_result',
          payload: { tool_use_id: 'tu-1', content: 'hello world' },
          meta: { bat_message_id: 'channel-msg-2' },
        }),
      })
      assert.equal(toolResultFrame.status, 200)
      const usageFrame = await fetch(`${bridgeUrl}/frame`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'channel-life-1',
          kind: 'usage',
          payload: { input_tokens: 12, output_tokens: 34, model: 'claude-sonnet-4-6' },
          meta: { bat_message_id: 'channel-msg-2' },
        }),
      })
      assert.equal(usageFrame.status, 200)
      const resultFrame = await fetch(`${bridgeUrl}/frame`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'channel-life-1',
          kind: 'result',
          payload: { status: 'success', stop_reason: 'end_turn' },
          meta: { bat_message_id: 'channel-msg-2' },
        }),
      })
      assert.equal(resultFrame.status, 200)

      const frameEventNames = captured.map(event => event.name)
      assert.ok(frameEventNames.includes('claude-channel:assistant'))
      assert.ok(frameEventNames.includes('claude-channel:tool-use'))
      assert.ok(frameEventNames.includes('claude-channel:tool-result'))
      assert.ok(frameEventNames.includes('claude-channel:usage'))
      assert.ok(frameEventNames.includes('claude-channel:result'))
      assert.ok(frameEventNames.includes('claude-channel:turn-end'))
      const partialEvent = captured.find(e => e.name === 'claude-channel:assistant' && e.payload?.status === 'partial')
      assert.equal(partialEvent?.payload?.text, 'thinking out loud')
      assert.equal(partialEvent?.payload?.inReplyTo, 'channel-msg-2')
      const toolUseEvent = captured.find(e => e.name === 'claude-channel:tool-use')
      assert.equal(toolUseEvent?.payload?.payload?.name, 'Read')
      assert.equal(toolUseEvent?.payload?.payload?.id, 'tu-1')
      const toolResultEvent = captured.find(e => e.name === 'claude-channel:tool-result')
      assert.equal(toolResultEvent?.payload?.payload?.tool_use_id, 'tu-1')
      assert.equal(toolResultEvent?.payload?.payload?.content, 'hello world')
      const usageEvent = captured.find(e => e.name === 'claude-channel:usage')
      assert.equal(usageEvent?.payload?.payload?.input_tokens, 12)
      assert.equal(usageEvent?.payload?.payload?.output_tokens, 34)
      const turnEndEvent = captured.find(e => e.name === 'claude-channel:turn-end')
      assert.equal(turnEndEvent?.payload?.messageId, 'channel-msg-2')
      assert.equal(turnEndEvent?.payload?.stopReason, 'end_turn')

      const invalidFrame = await fetch(`${bridgeUrl}/frame`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'channel-life-1',
          kind: 'tool_use',
          payload: { name: 'Read' },
        }),
      })
      assert.equal(invalidFrame.status, 400)

      // Hook round-trip: PreToolUse → tool_use, PostToolUse → tool_result,
      // PostToolUseFailure → tool_result(error), MessageDisplay → assistant,
      // Stop → result + turn-end.
      captured.length = 0
      const preToolUseHook = await fetch(`${bridgeUrl}/hook/PreToolUse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/etc/hosts' },
          tool_use_id: 'toolu_hook_1',
        }),
      })
      assert.equal(preToolUseHook.status, 200)
      const messageDisplayHook = await fetch(`${bridgeUrl}/hook/MessageDisplay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'MessageDisplay',
          turn_id: 't-1',
          message_id: 'm-1',
          index: 0,
          final: false,
          delta: 'Hi from ',
        }),
      })
      assert.equal(messageDisplayHook.status, 200)
      const messageDisplayFinal = await fetch(`${bridgeUrl}/hook/MessageDisplay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'MessageDisplay',
          turn_id: 't-1',
          message_id: 'm-1',
          index: 1,
          final: true,
          delta: 'BAT',
        }),
      })
      assert.equal(messageDisplayFinal.status, 200)
      const postToolUseHook = await fetch(`${bridgeUrl}/hook/PostToolUse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/etc/hosts' },
          tool_response: 'localhost',
          tool_use_id: 'toolu_hook_1',
          duration_ms: 7,
        }),
      })
      assert.equal(postToolUseHook.status, 200)
      const postToolUseFailureHook = await fetch(`${bridgeUrl}/hook/PostToolUseFailure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'PostToolUseFailure',
          tool_name: 'Bash',
          tool_input: { command: 'false' },
          tool_use_id: 'toolu_hook_2',
          error: 'exit code 1',
          is_interrupt: false,
          duration_ms: 4,
        }),
      })
      assert.equal(postToolUseFailureHook.status, 200)
      const stopHook = await fetch(`${bridgeUrl}/hook/Stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'Stop' }),
      })
      assert.equal(stopHook.status, 200)
      const hookEventNames = captured.map(event => event.name)
      assert.ok(hookEventNames.includes('claude-channel:tool-use'), `missing tool-use, got ${hookEventNames.join(',')}`)
      assert.ok(hookEventNames.includes('claude-channel:tool-result'), `missing tool-result, got ${hookEventNames.join(',')}`)
      assert.ok(hookEventNames.includes('claude-channel:assistant'), `missing assistant, got ${hookEventNames.join(',')}`)
      assert.ok(hookEventNames.includes('claude-channel:result'), `missing result, got ${hookEventNames.join(',')}`)
      assert.ok(hookEventNames.includes('claude-channel:turn-end'), `missing turn-end, got ${hookEventNames.join(',')}`)
      const toolUseHookEvent = captured.find(e => e.name === 'claude-channel:tool-use')
      assert.equal(toolUseHookEvent?.payload?.payload?.id, 'toolu_hook_1')
      assert.equal(toolUseHookEvent?.payload?.payload?.name, 'Read')
      const toolResultsHookEvents = captured.filter(e => e.name === 'claude-channel:tool-result')
      const successResult = toolResultsHookEvents.find(e => e.payload?.payload?.tool_use_id === 'toolu_hook_1')
      const errorResult = toolResultsHookEvents.find(e => e.payload?.payload?.tool_use_id === 'toolu_hook_2')
      assert.equal(successResult?.payload?.payload?.is_error, false)
      assert.equal(successResult?.payload?.payload?.content, 'localhost')
      assert.equal(errorResult?.payload?.payload?.is_error, true)
      assert.equal(errorResult?.payload?.payload?.content, 'exit code 1')
      const partialAssistant = captured.find(e => e.name === 'claude-channel:assistant' && e.payload?.status === 'partial')
      const finalAssistant = captured.find(e => e.name === 'claude-channel:assistant' && e.payload?.status === 'final')
      assert.equal(partialAssistant?.payload?.text, 'Hi from ')
      assert.equal(finalAssistant?.payload?.text, 'BAT')

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
