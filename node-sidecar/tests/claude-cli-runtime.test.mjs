// Tests for the Claude CLI transcript runtime.
//
// Offline: uses a fake `claude` executable plus synthetic transcript lines.

import * as assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __setSendEventForTests } from '../src/lib/protocol.mjs'
import {
  __resetClaudeCliSessionsForTests,
  getClaudeCliCapabilities,
  getClaudeCliStatus,
  startClaudeCliSession,
  stopClaudeCliSession,
} from '../src/runtimes/claude-cli-runtime.mjs'

function makeFakeClaude(root) {
  const js = join(root, 'claude.js')
  const exe = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('2.1.156 (Claude Code)')
  process.exit(0)
}
if (args[0] === '--help') {
  console.log('--model --permission-mode --effort --session-id --resume --fork-session --settings --append-system-prompt')
  process.exit(0)
}
process.exit(0)
`
  if (process.platform === 'win32') {
    writeFileSync(js, script)
    writeFileSync(exe, '@echo off\r\nnode "%~dp0claude.js" %*\r\n')
  } else {
    writeFileSync(exe, script, { mode: 0o755 })
    chmodSync(exe, 0o755)
  }
  return exe
}

function transcriptLine(kind) {
  if (kind === 'seed') {
    return JSON.stringify({
      type: 'assistant',
      uuid: 'seed-a',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'seed' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
  }
  if (kind === 'user') {
    return JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    })
  }
  if (kind === 'assistant') {
    return JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: new Date().toISOString(),
      message: {
        // Real transcripts reuse one message.id across all blocks/lines of an
        // API message — entry ids must still come out distinct per block.
        id: 'msg-shared-1',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'thinking', thinking: 'think' },
          { type: 'text', text: 'reply' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
        ],
        usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
      },
    })
  }
  if (kind === 'tool-result') {
    return JSON.stringify({
      type: 'user',
      uuid: 'u2',
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'body', is_error: false }],
      },
    })
  }
  throw new Error(`unknown transcript kind: ${kind}`)
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function main() {
  const savedDebug = process.env.BAT_DEBUG
  const savedDataDir = process.env.BAT_SIDECAR_DATA_DIR
  const root = mkdtempSync(join(tmpdir(), 'bat-cli-runtime-'))
  const fakeDataDir = join(root, 'data')
  const projectsDir = join(root, 'projects')
  const seedDir = join(projectsDir, 'seed')
  const sessionDir = join(projectsDir, 'C--repo')
  mkdirSync(seedDir, { recursive: true })
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(seedDir, 'seed.jsonl'), transcriptLine('seed') + '\n')
  const fakeClaude = makeFakeClaude(root)
  const captured = []
  const restoreSend = __setSendEventForTests((name, payload) => captured.push({ name, payload }))

  try {
    delete process.env.BAT_DEBUG
    await assert.rejects(
      getClaudeCliCapabilities({ cliPath: fakeClaude, projectsDir }),
      /BAT_DEBUG/,
    )

    process.env.BAT_DEBUG = '1'
    process.env.BAT_SIDECAR_DATA_DIR = fakeDataDir
    const caps = await getClaudeCliCapabilities({ cliPath: fakeClaude, projectsDir })
    assert.equal(caps.supported, true)
    assert.equal(caps.supportsTranscript, true)
    assert.equal(caps.supportsSessionId, true)
    assert.equal(caps.supportsResume, true)

    const sessionId = 'cli-runtime-1'
    const cliSessionId = '11111111-1111-4111-8111-111111111111'
    const started = await startClaudeCliSession({
      sessionId,
      cliSessionId,
      cliPath: fakeClaude,
      cwd: root,
      projectsDir,
    })
    assert.equal(started.ok, true)
    assert.equal(started.cliSessionId, cliSessionId)
    assert.ok(started.settingsPath)
    const settings = JSON.parse(readFileSync(started.settingsPath, 'utf8'))
    assert.ok(Array.isArray(settings.hooks.PreToolUse))
    assert.match(settings.hooks.PreToolUse[0].hooks[0].url, /^http:\/\/127\.0\.0\.1:\d+\/hook\/PreToolUse$/)

    const transcriptPath = join(sessionDir, `${cliSessionId}.jsonl`)
    writeFileSync(transcriptPath, '')
    appendFileSync(transcriptPath, [
      transcriptLine('user'),
      transcriptLine('assistant'),
      transcriptLine('tool-result'),
    ].join('\n') + '\n')

    await waitFor(() => captured.find(e => e.name === 'claude-cli:assistant'), 'assistant event')
    assert.ok(captured.some(e => e.name === 'claude-cli:message' && e.payload?.role === 'user'))
    assert.ok(captured.some(e => e.name === 'claude-cli:thinking'))
    // Regression: thinking + text blocks share message.id in real transcripts;
    // the emitted entry ids must NOT collide or the panel dedupe drops the
    // assistant text.
    const assistantEvt = captured.find(e => e.name === 'claude-cli:assistant')
    const thinkingEvt = captured.find(e => e.name === 'claude-cli:thinking')
    assert.ok(assistantEvt.payload.id, 'assistant event carries an id')
    assert.ok(thinkingEvt.payload.payload.id, 'thinking payload carries an id')
    assert.notEqual(assistantEvt.payload.id, thinkingEvt.payload.payload.id)
    assert.ok(captured.some(e => e.name === 'claude-cli:tool-use' && e.payload?.payload?.name === 'Read'))
    assert.ok(captured.some(e => e.name === 'claude-cli:tool-result' && e.payload?.payload?.tool_use_id === 'tool-1'))
    assert.ok(captured.some(e => e.name === 'claude-cli:usage' && e.payload?.payload?.output_tokens === 34))

    const status = await getClaudeCliStatus({ sessionId })
    assert.equal(status.status, 'starting')
    assert.equal(status.transcriptPath, transcriptPath)

    const preToolUrl = settings.hooks.PreToolUse[0].hooks[0].url
    const hookResponse = await fetch(preToolUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        tool_use_id: 'hook-tool-1',
      }),
    })
    assert.equal(hookResponse.status, 200)
    assert.deepEqual(await hookResponse.json(), {})
    assert.ok(captured.some(e => e.name === 'claude-cli:tool-use' && e.payload?.payload?.id === 'hook-tool-1'))

    const stopped = await stopClaudeCliSession({ sessionId })
    assert.equal(stopped.ok, true)
    assert.equal(stopped.existed, true)
    const stoppedStatus = await getClaudeCliStatus({ sessionId })
    assert.equal(stoppedStatus.status, 'stopped')
  } finally {
    restoreSend()
    await __resetClaudeCliSessionsForTests()
    if (savedDebug === undefined) delete process.env.BAT_DEBUG
    else process.env.BAT_DEBUG = savedDebug
    if (savedDataDir === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
    else process.env.BAT_SIDECAR_DATA_DIR = savedDataDir
    rmSync(root, { recursive: true, force: true })
  }

  console.log('claude-cli-runtime: passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
