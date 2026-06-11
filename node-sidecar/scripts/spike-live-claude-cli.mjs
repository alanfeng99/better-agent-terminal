// LIVE spike for the Claude CLI (subscription) agent path.
//
// Verifies the two remaining unknowns from plans/claude-cli-transcript-agent-plan.md §11:
//   #2 transcript liveness — are lines appended DURING the turn (incremental)
//      or only flushed at turn end?
//   #4 PreToolUse http hook — can the bridge respond `deny` in interactive
//      mode and block the tool without any keystroke injection?
//
// Method: spawn a real interactive `claude` (PTY) in a throwaway temp dir,
// with a cheap model, --session-id, and --settings hooks pointing at a local
// bridge. Send ONE short prompt that triggers a Read tool call. The bridge
// denies the FIRST PreToolUse and answers {} afterwards. Our transcript tailer
// runs concurrently and timestamps every frame.
//
// Logs are structure-only (kinds, tool names, text lengths — no content).
//
// Usage: node node-sidecar/scripts/spike-live-claude-cli.mjs [model]
//   model default: haiku

import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'

import { createTranscriptTailer, locateTranscriptBySessionId } from '../src/runtimes/claude-cli-transcript.mjs'

const MODEL = process.argv[2] || 'haiku'
const OVERALL_TIMEOUT_MS = 180_000
const QUIET_BEFORE_PROMPT_MS = 2_500
const POST_STOP_GRACE_MS = 4_000

const t0 = Date.now()
const timeline = []
function note(src, info) {
  const t = Date.now() - t0
  timeline.push({ t, src, info })
  console.log(`[${String(t).padStart(6)}ms] ${src}: ${info}`)
}

function findClaude() {
  try {
    const out = execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { encoding: 'utf8' })
    return out.split(/\r?\n/).find(l => l.trim())?.trim() || null
  } catch { return null }
}

const cliPath = findClaude()
if (!cliPath) { console.error('claude not found on PATH'); process.exit(2) }

const pty = await import('@lydell/node-pty').then(m => (m.spawn ? m : m.default))
const sessionId = randomUUID()
const sandbox = mkdtempSync(join(tmpdir(), 'bat-cli-spike-'))
writeFileSync(join(sandbox, 'note.txt'), 'BAT_SPIKE_MAGIC_LINE_42\nsecond line\n')

// ---- bridge ----
let preToolUseCount = 0
let denySent = false
let stopAt = null
let postToolUseFailureSeen = false
let postToolUseOkSeen = false
const hookHits = []

const bridge = createServer((req, res) => {
  let body = ''
  req.setEncoding('utf8')
  req.on('data', c => { body += c })
  req.on('end', () => {
    const eventName = (req.url || '').replace(/^\/hook\//, '')
    let payload = {}
    try { payload = body.trim() ? JSON.parse(body) : {} } catch {}
    const toolName = payload.tool_name || ''
    hookHits.push({ t: Date.now() - t0, eventName, toolName })
    note('hook', `${eventName}${toolName ? ` tool=${toolName}` : ''}`)

    if (eventName === 'PreToolUse') {
      preToolUseCount++
      if (preToolUseCount === 1) {
        denySent = true
        note('bridge', `responding DENY to PreToolUse #1 (tool=${toolName})`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          decision: 'block',
          reason: 'BAT spike: first tool call is denied on purpose. Retry the same call once.',
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'BAT spike: first tool call is denied on purpose. Retry the same call once.',
          },
        }))
        return
      }
    }
    if (eventName === 'PostToolUseFailure') postToolUseFailureSeen = true
    if (eventName === 'PostToolUse') postToolUseOkSeen = true
    if (eventName === 'Stop' && stopAt === null) stopAt = Date.now() - t0
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise(r => bridge.listen(0, '127.0.0.1', r))
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`

// ---- per-session settings with http hooks ----
const hookEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure']
const settings = { hooks: {} }
for (const ev of hookEvents) {
  settings.hooks[ev] = [{ matcher: '*', hooks: [{ type: 'http', url: `${bridgeUrl}/hook/${ev}` }] }]
}
const settingsPath = join(sandbox, 'bat-spike-settings.json')
writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

// ---- transcript tailer (concurrent) ----
const frameLog = []
let firstContentFrameAt = null
let tailer = null
let transcriptPath = null
const locatePoll = setInterval(() => {
  if (transcriptPath) return
  transcriptPath = locateTranscriptBySessionId(sessionId)
  if (!transcriptPath) return
  note('tailer', `transcript located: ${transcriptPath}`)
  tailer = createTranscriptTailer({
    filePath: transcriptPath,
    pollMs: 120,
    onFrames: frames => {
      for (const f of frames) {
        const t = Date.now() - t0
        const desc = f.kind === 'tool_use' ? `tool_use(${f.payload.name})`
          : f.kind === 'tool_result' ? `tool_result(err=${f.payload.is_error})`
          : f.kind === 'usage' ? `usage(out=${f.payload.output_tokens})`
          : `${f.kind}(len=${(f.payload.text || '').length})`
        frameLog.push({ t, kind: f.kind, desc })
        if (firstContentFrameAt === null && f.kind !== 'usage') firstContentFrameAt = t
        note('frame', desc)
      }
    },
    onError: err => note('tailer', `ERROR ${err.message}`),
  })
}, 400)

// ---- spawn interactive claude ----
const args = ['--session-id', sessionId, '--model', MODEL, '--settings', settingsPath]
note('spawn', `${cliPath} ${args.join(' ')} (cwd=${sandbox})`)
const child = pty.spawn(cliPath, args, {
  cwd: sandbox,
  env: { ...process.env, NO_COLOR: '1' },
  name: 'xterm-256color',
  cols: 100,
  rows: 32,
})

let output = ''
let trustConfirmed = false
let trustSeen = false
let promptTyped = false
let promptSubmitted = false
let lastDataAt = Date.now()

function stripAnsi(v) {
  return String(v || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
}

// IMPORTANT: the TUI positions glyphs with cursor moves, so after stripping
// ANSI the spaces are gone ("Isthisaprojectyoucreated..."). All matching must
// be whitespace-insensitive: collapse whitespace on BOTH sides.
function collapsed() {
  return stripAnsi(output).replace(/\s+/g, '').toLowerCase()
}

child.onData(chunk => {
  lastDataAt = Date.now()
  output = (output + chunk).slice(-12000)
  if (!trustSeen && collapsed().includes('trustthisfolder')) {
    trustSeen = true
    note('pty', 'trust prompt detected → confirming (Enter, option 1 preselected)')
    child.write('\r')
    setTimeout(() => child.write('\r'), 400)
    setTimeout(() => { trustConfirmed = true }, 800)
  }
})
child.onExit(e => note('pty', `claude exited code=${e.exitCode}`))

// Type the prompt only after trust is confirmed and the TUI has settled, then
// verify the input box ECHOED it before submitting Enter (keystrokes typed
// into a dialog are silently lost).
const PROMPT = 'Use the Read tool to read note.txt and reply with exactly its first line. If the tool call is blocked or denied, retry the exact same Read call once.'
const ECHO_NEEDLE = 'note.txtandreplywithexactly'
let typeAttempts = 0
const promptTimer = setInterval(() => {
  if (promptSubmitted) return
  const quietFor = Date.now() - lastDataAt
  const elapsed = Date.now() - t0
  const ready = trustConfirmed || (elapsed >= 15_000 && !trustSeen) // no trust dialog case
  if (!promptTyped) {
    if (ready && output.length > 0 && quietFor >= QUIET_BEFORE_PROMPT_MS) {
      promptTyped = true
      typeAttempts++
      note('pty', `typing prompt (attempt ${typeAttempts})`)
      child.write(PROMPT)
    }
    return
  }
  // typed but not submitted: wait for echo
  if (collapsed().includes(ECHO_NEEDLE)) {
    promptSubmitted = true
    note('pty', 'input echo confirmed → submitting (Enter)')
    child.write('\r')
  } else if (quietFor >= 2000 && typeAttempts < 4) {
    note('pty', `echo not seen yet → retyping (attempt ${typeAttempts + 1})`)
    typeAttempts++
    child.write(PROMPT)
  }
}, 300)

// ---- finish conditions ----
function finish(reason) {
  note('spike', `finishing: ${reason}`)
  clearInterval(promptTimer)
  clearInterval(locatePoll)
  tailer?.stop()
  try { child.write('\x03') } catch {}
  setTimeout(() => {
    try { child.kill() } catch {}
    bridge.close()
    try { rmSync(sandbox, { recursive: true, force: true }) } catch {}

    // ---- report ----
    const denyBlocked = postToolUseFailureSeen || frameLog.some(f => f.desc === 'tool_result(err=true)') || preToolUseCount >= 2
    console.log('\n================ SPIKE REPORT ================')
    console.log(`model=${MODEL} session=${sessionId}`)
    console.log(`transcript: ${transcriptPath || 'NEVER LOCATED'}`)
    console.log(`hooks seen: ${[...new Set(hookHits.map(h => h.eventName))].join(', ') || 'NONE'}`)
    console.log(`PreToolUse count: ${preToolUseCount} (deny sent on #1: ${denySent})`)
    console.log(`PostToolUse ok seen: ${postToolUseOkSeen}, failure seen: ${postToolUseFailureSeen}`)
    console.log(`frames: ${frameLog.length} (${[...new Set(frameLog.map(f => f.kind))].join(', ')})`)
    console.log(`first content frame at: ${firstContentFrameAt}ms, Stop hook at: ${stopAt}ms`)
    console.log('\n--- VERDICTS ---')
    if (firstContentFrameAt !== null && stopAt !== null) {
      const incremental = firstContentFrameAt < stopAt - 500
      console.log(`#2 liveness: ${incremental ? 'INCREMENTAL ✓ (frames during turn)' : 'END-FLUSH ✗ (frames only at turn end)'} — first frame ${firstContentFrameAt}ms vs stop ${stopAt}ms`)
    } else if (firstContentFrameAt !== null) {
      console.log(`#2 liveness: frames seen (${firstContentFrameAt}ms) but no Stop hook — inspect timeline`)
    } else {
      console.log('#2 liveness: NO FRAMES — transcript tail failed, inspect timeline')
    }
    if (denySent) {
      console.log(`#4 deny: ${denyBlocked ? 'DENY EFFECTIVE ✓' : 'UNCONFIRMED ✗'} — evidence: PreToolUse retries=${preToolUseCount - 1}, PostToolUseFailure=${postToolUseFailureSeen}, error tool_result=${frameLog.some(f => f.desc === 'tool_result(err=true)')}`)
    } else {
      console.log('#4 deny: PreToolUse never fired — hooks not working, inspect timeline')
    }
    console.log('==============================================')
    process.exit(0)
  }, 1500)
}

// Done when: Stop seen AND grace elapsed; or overall timeout.
const doneTimer = setInterval(() => {
  if (stopAt !== null && Date.now() - t0 > stopAt + POST_STOP_GRACE_MS) {
    clearInterval(doneTimer)
    finish('Stop hook + grace period')
  } else if (Date.now() - t0 > OVERALL_TIMEOUT_MS) {
    clearInterval(doneTimer)
    finish('overall timeout')
  }
}, 500)
