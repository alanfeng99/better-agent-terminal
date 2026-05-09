// Better Agent Terminal — Node sidecar.
//
// Speaks line-delimited JSON-RPC 2.0 over stdio. Tauri spawns one of these
// per app instance and forwards renderer invocations through it. This file
// is plain ESM JS — no build step — so the same file runs under `node` in
// dev and (eventually) under a bundled Node runtime in release.
//
// Wire format (one JSON object per stdin/stdout line, no Content-Length):
//   request:      {"jsonrpc":"2.0","id":N,"method":"foo.bar","params":...}
//   response ok:  {"jsonrpc":"2.0","id":N,"result":...}
//   response err: {"jsonrpc":"2.0","id":N,"error":{"code":N,"message":"..."}}
//   server event: {"jsonrpc":"2.0","method":"event:name","params":...}
//
// We deliberately ignore JSON-RPC batching for now — every callsite under
// host.* sends one request at a time, so the extra complexity buys nothing.
//
// Run with: node node-sidecar/src/server.mjs
//
// Tests live in node-sidecar/tests/server.test.mjs.

import { createInterface } from 'node:readline'
import { readdir, stat, readFile } from 'node:fs/promises'
import { createReadStream, accessSync, constants as fsConstants } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Handler registry. Each handler receives `params` (any JSON value) and
// returns either a value or a Promise resolving to one. Throw to signal an
// error — it lands in JSON-RPC error.message verbatim.
const handlers = new Map()

export function registerHandler(method, fn) {
  if (handlers.has(method)) {
    throw new Error(`sidecar: handler already registered for ${method}`)
  }
  handlers.set(method, fn)
}

// --- built-in handlers ------------------------------------------------------

registerHandler('ping', async (params) => {
  // Round-trip echo. Used by the Rust bridge as a startup probe.
  return { ok: true, echo: params ?? null, pid: process.pid }
})

// MVP stubs for the claude.* surface. They return shapes that match the
// Electron-side claudeAccount API so the renderer can render an empty
// "no accounts" state without throwing. Real implementations land
// later when we move @anthropic-ai/claude-agent-sdk into the sidecar.
// authStatus shells out to `claude auth status`, parses the JSON output,
// returns null on any failure (CLI missing, not logged in, parse error).
// This matches the Electron-side handler verbatim.
registerHandler('claude.authStatus', async () => fetchAuthStatus())
// accountList reads the unencrypted account index file written by
// the Electron-side AccountManager. The encrypted credentials live in
// a separate file; this handler never touches them. Until the Tauri
// side has a parallel writer, the list will be empty on a fresh
// install — and that's fine: the renderer's auth UI handles empty
// state correctly.
registerHandler('claude.accountList', async () => readAccountIndex())

// Session lifecycle stubs. Until the agent SDK actually moves into the
// sidecar, these just acknowledge the call and synthesise a minimal
// "turn-end" event so the renderer's lifecycle wiring can be exercised
// end-to-end without a real model. The session map also holds the
// configuration the renderer pushes via setAutoContinue / setModel /
// setPermissionMode / setEffort so getters return consistent values.
const sessions = new Map()

function ensureSession(sessionId) {
  let s = sessions.get(sessionId)
  if (!s) {
    s = {
      active: false,
      options: null,
      // Renderer-controlled config; defaults match Electron's session
      // defaults so getters before any setter calls don't surprise the UI.
      model: undefined,
      autoCompactWindow: null,
      effort: undefined,
      permissionMode: 'default',
      autoContinue: { enabled: false, max: 0, used: 0, prompt: '' },
      // SDK session id captured from the first SDKResultMessage; used as
      // `resume` on subsequent sendMessage calls so the SDK preserves
      // conversation context.
      sdkSessionId: null,
      // Per-session abort signal; set during sendMessage so abortSession
      // can cancel an in-flight query.
      abortController: null,
      // Guard against concurrent sendMessage calls — same contract as the
      // Electron isStreaming flag.
      streaming: false,
      // Cached usage stats updated from stream_event message_start /
      // message_delta + the final SDKResultSuccess.usage. Surfaced to
      // the renderer via claude.getContextUsage between turns; null
      // until the first turn completes.
      lastUsage: null,
      // Pending canUseTool / AskUserQuestion resolutions keyed by the
      // tool_use_id the SDK supplies. Populated when the canUseTool
      // callback emits a permission-request / ask-user event; the
      // renderer answers via claude.resolvePermission /
      // claude.resolveAskUser, which calls the stored resolve fn.
      pendingPermissions: new Map(),
      pendingAskUser: new Map(),
      // Renderer's "resting" UX: ClaudeAgentPanel toggles this when the
      // user sends the session to background so it doesn't keep
      // streaming. wakeSession and the next sendMessage both clear it.
      isResting: false,
    }
    sessions.set(sessionId, s)
  }
  return s
}

registerHandler('claude.startSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.startSession: missing sessionId')
  }
  const s = ensureSession(sessionId)
  s.active = true
  s.options = params?.options ?? null
  // Some options carry per-session config the renderer expects to read
  // back via getSessionMeta — capture them now.
  if (s.options && typeof s.options === 'object') {
    if (typeof s.options.model === 'string') s.model = s.options.model
    if (typeof s.options.permissionMode === 'string') s.permissionMode = s.options.permissionMode
    if (typeof s.options.effort === 'string') s.effort = s.options.effort
    if (typeof s.options.autoCompactWindow === 'number') s.autoCompactWindow = s.options.autoCompactWindow
    // startSession can also pre-populate sdkSessionId for the resume
    // path. The renderer's reload-from-history flow goes through
    // claude.resumeSession (below), but the underlying mechanism is
    // identical: stash the SDK id so the next sendMessage uses
    // `resume: <id>` and the SDK reconstructs the conversation.
    if (typeof s.options.sdkSessionId === 'string') s.sdkSessionId = s.options.sdkSessionId
  }
  return { ok: true, sessionId }
})

// claude.resumeSession: rewire a session to an existing SDK session id.
// Mirror of electron/claude-agent-manager.ts:2461. Aborts any in-flight
// query, swaps the session record, and pre-populates sdkSessionId so
// the next sendMessage passes `resume: <id>` — the SDK then rehydrates
// the conversation from its own session store. We default the
// permissionMode to 'bypassPermissions' to match Electron's resume
// contract (resumed sessions don't re-prompt for prior approvals).
registerHandler('claude.resumeSession', async (params) => {
  const sessionId = params?.sessionId
  const sdkSessionIdToResume = params?.sdkSessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.resumeSession: missing sessionId')
  }
  if (typeof sdkSessionIdToResume !== 'string' || !sdkSessionIdToResume) {
    throw new Error('claude.resumeSession: missing sdkSessionId')
  }
  const existing = sessions.get(sessionId)
  if (existing?.abortController) {
    try { existing.abortController.abort() } catch { /* already aborted */ }
  }
  // Drop the prior record (if any) and rebuild from the resume options.
  sessions.delete(sessionId)
  const s = ensureSession(sessionId)
  s.active = true
  s.options = params?.options ?? null
  s.sdkSessionId = sdkSessionIdToResume
  s.permissionMode = 'bypassPermissions'
  if (s.options && typeof s.options === 'object') {
    if (typeof s.options.cwd === 'string') {
      // Keep cwd in options so sendMessage's queryOptions picks it up.
    }
    if (typeof s.options.model === 'string') s.model = s.options.model
    if (typeof s.options.permissionMode === 'string') s.permissionMode = s.options.permissionMode
    if (typeof s.options.effort === 'string') s.effort = s.options.effort
    if (typeof s.options.autoCompactWindow === 'number') s.autoCompactWindow = s.options.autoCompactWindow
  }
  return { ok: true, sessionId, sdkSessionId: sdkSessionIdToResume }
})

// claude.rewindToPrompt: cut the SDK session's JSONL transcript at a
// given user-prompt index, write a fresh transcript under a new
// SDK session id, and rewire the in-memory session to the new id so
// the next sendMessage continues from the truncated history. Mirror
// of electron/claude-agent-manager.ts:2647. Pure file-system + JSON
// surgery — no SDK call, no network — so it stays fast and
// deterministic in tests. Cwd-name encoding matches the Claude CLI's
// scheme: replace anything not [a-zA-Z0-9] with '-'.
//
// Override hook for tests: __setProjectsDirOverrideForTests(path)
// swaps `~/.claude/projects` for a tmpdir.
let _projectsDirOverrideForTests = null
function __setProjectsDirOverrideForTests(p) { _projectsDirOverrideForTests = p }
function __resolveProjectsDir() {
  return _projectsDirOverrideForTests || join(homedir(), '.claude', 'projects')
}
registerHandler('claude.rewindToPrompt', async (params) => {
  const sessionId = params?.sessionId
  const promptIndex = params?.promptIndex
  if (typeof sessionId !== 'string' || !sessionId) {
    return { error: 'rewindToPrompt: missing sessionId' }
  }
  if (typeof promptIndex !== 'number' || promptIndex < 0) {
    return { error: 'rewindToPrompt: promptIndex must be a non-negative number' }
  }
  const session = sessions.get(sessionId)
  if (!session) return { error: 'Session not found' }
  if (session.streaming) {
    return { error: 'Cannot rewind while Claude is responding — stop the current turn first.' }
  }
  const currentSdkId = session.sdkSessionId
  if (!currentSdkId) return { error: 'No SDK session to rewind' }
  const cwd = (session.options && typeof session.options === 'object' && typeof session.options.cwd === 'string')
    ? session.options.cwd
    : null
  if (!cwd) return { error: 'rewindToPrompt: session has no cwd' }
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const projectDir = join(__resolveProjectsDir(), encoded)
  const filePath = join(projectDir, `${currentSdkId}.jsonl`)

  let raw
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return { error: `Session history file not found: ${filePath}` }
  }
  const lines = raw.split('\n').filter(l => l.trim())

  // Find cutoff: the (promptIndex)-th text-bearing user prompt.
  let userPromptCount = 0
  let cutoffIdx = -1
  for (let i = 0; i < lines.length; i++) {
    let obj
    try { obj = JSON.parse(lines[i]) } catch { continue }
    if (obj?.type !== 'user' || obj?.message?.role !== 'user') continue
    const msgContent = obj.message.content
    let hasText = false
    if (typeof msgContent === 'string' && msgContent.length > 0) {
      hasText = true
    } else if (Array.isArray(msgContent)) {
      hasText = msgContent.some(b => b && b.type === 'text')
    }
    if (!hasText) continue
    if (userPromptCount === promptIndex) { cutoffIdx = i; break }
    userPromptCount++
  }
  if (cutoffIdx === -1) {
    return { error: `Prompt index ${promptIndex} not found (only ${userPromptCount} user prompt(s) in history)` }
  }

  const keptLines = lines.slice(0, cutoffIdx)
  const { randomUUID } = await import('node:crypto')
  const { writeFile } = await import('node:fs/promises')
  const newSdkSessionId = randomUUID()

  // Rewrite each line so any embedded sessionId points to the new id.
  // The Claude CLI looks for sessionId fields keyed in the message
  // metadata; rewrite defensively (no-op when the key is absent).
  const rewritten = keptLines.map((line) => {
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj.sessionId === 'string') obj.sessionId = newSdkSessionId
      return JSON.stringify(obj)
    } catch {
      return line
    }
  })
  const newFilePath = join(projectDir, `${newSdkSessionId}.jsonl`)
  await writeFile(
    newFilePath,
    rewritten.join('\n') + (rewritten.length > 0 ? '\n' : ''),
    'utf-8',
  )

  // Wire the in-memory session to the new transcript so the next
  // sendMessage's `resume:` picks it up.
  if (session.abortController) {
    try { session.abortController.abort() } catch { /* already aborted */ }
  }
  session.abortController = null
  session.sdkSessionId = newSdkSessionId
  // Best-effort: notify renderers that the session metadata changed.
  // Use the full shape so ClaudeAgentPanel's status line doesn't crash
  // on .inputTokens.toLocaleString() etc.
  sendEvent('claude:status', { sessionId, meta: buildSessionMeta(session) })
  const removedPromptCount = lines.length - cutoffIdx
  return { newSdkSessionId, removedPromptCount }
})

// claude.forkSession: ask the SDK to fork the current SDK session id —
// produces a new sdkSessionId whose transcript starts identical to the
// original at the time of the fork. Mirror of
// electron/claude-agent-manager.ts:2733. Underlying contract is the
// SDK's `forkSession: true` query option: spawn a one-turn query with
// `resume: currentSdkId, forkSession: true, maxTurns: 1, prompt: ' '`,
// capture the new session_id off `system:init`, but **wait until the
// result message** before bailing — the CLI only persists the forked
// transcript file (`<newId>.jsonl`) after at least one turn completes.
// Aborting on init leaves an unresumable id.
//
// 60s safety timeout aborts a runaway fork so we don't hang the
// session forever.
const FORK_TIMEOUT_MS = 60_000
registerHandler('claude.forkSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return null
  const session = sessions.get(sessionId)
  const currentSdkId = session?.sdkSessionId
  if (!currentSdkId) return null
  const sdk = await loadAnthropicSdk()
  if (!sdk || typeof sdk.query !== 'function') return null
  const cwd = (session?.options && typeof session.options === 'object' && typeof session.options.cwd === 'string')
    ? session.options.cwd
    : process.cwd()
  const claudeCodePath = resolveClaudeCliBinary()
  const abortController = new AbortController()
  const timeoutHandle = setTimeout(() => {
    if (!abortController.signal.aborted) {
      try { abortController.abort() } catch { /* already aborted */ }
    }
  }, FORK_TIMEOUT_MS)
  let newSdkSessionId = null
  try {
    const generator = sdk.query({
      prompt: ' ',
      options: {
        abortController,
        cwd,
        resume: currentSdkId,
        forkSession: true,
        maxTurns: 1,
        ...(claudeCodePath ? { pathToClaudeCodeExecutable: claudeCodePath } : {}),
      },
    })
    for await (const msg of generator) {
      if (msg?.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
        newSdkSessionId = msg.session_id
      } else if (msg?.type === 'result') {
        // Wait for result before breaking — that's the signal the CLI
        // has finished writing the new transcript file.
        break
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const isAbort = abortController.signal.aborted || /aborted/i.test(errMsg)
    if (!isAbort) {
      process.stderr.write(`[sidecar] claude.forkSession: ${errMsg}\n`)
    }
  } finally {
    clearTimeout(timeoutHandle)
  }
  if (!newSdkSessionId) return null
  return { newSdkSessionId }
})

// claude.fetchSubagentMessages: load the messages a subagent (Agent/Task
// tool) produced during its turn so the renderer can expand the active-
// task panel into a per-message view. Mirror of
// electron/claude-agent-manager.ts:2558. The SDK exports
// `getSubagentMessages(sdkSessionId, agentToolUseId, {dir})` which reads
// the on-disk transcript shard the CLI wrote during the parent run; we
// then normalise raw user/assistant messages into the renderer's
// (ClaudeMessage | ClaudeToolCall)[] shape so it can render them with
// the same components as the parent thread.
//
// Tool-result content is folded back into the matching tool-use entry
// (status: 'completed' | 'error', result truncated to 2000 chars) so the
// UI keeps the "tool ran → result" pairing instead of showing a bare
// user-role message with embedded tool_result blocks.
//
// Returns [] for any failure (no SDK, no sdkSessionId, SDK throws,
// missing helper) — same contract as Electron.
registerHandler('claude.fetchSubagentMessages', async (params) => {
  const sessionId = params?.sessionId
  const agentToolUseId = params?.agentToolUseId
  if (typeof sessionId !== 'string' || !sessionId) return []
  if (typeof agentToolUseId !== 'string' || !agentToolUseId) return []
  const session = sessions.get(sessionId)
  const sdkSid = session?.sdkSessionId
  if (!sdkSid) return []
  const sdk = await loadAnthropicSdk()
  if (!sdk || typeof sdk.getSubagentMessages !== 'function') return []
  const cwd = (session?.options && typeof session.options === 'object' && typeof session.options.cwd === 'string')
    ? session.options.cwd
    : undefined
  let messages
  try {
    messages = await sdk.getSubagentMessages(sdkSid, agentToolUseId, cwd ? { dir: cwd } : undefined)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[sidecar] claude.fetchSubagentMessages: ${errMsg}\n`)
    return []
  }
  if (!Array.isArray(messages)) return []
  const items = []
  const toolIndexMap = new Map()
  for (const msg of messages) {
    const ts = msg?.timestamp ? new Date(msg.timestamp).getTime() : Date.now()
    if (msg?.type === 'user') {
      const content = msg?.message?.content
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        const textBlock = content.find(b => b && b.type === 'text')
        if (textBlock && typeof textBlock.text === 'string') text = textBlock.text
        for (const block of content) {
          if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const idx = toolIndexMap.get(block.tool_use_id)
            if (idx !== undefined) {
              const tool = items[idx]
              tool.status = block.is_error ? 'error' : 'completed'
              const resultText = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content)
              tool.result = (resultText || '').slice(0, 2000)
            }
          }
        }
      }
      const isNoise = !text
        || text === '[Request interrupted by user for tool use]'
        || text.startsWith('<local-command-caveat>')
      if (!isNoise) {
        items.push({
          id: `sa-user-${items.length}`,
          sessionId, role: 'user', content: text,
          parentToolUseId: agentToolUseId, timestamp: ts,
        })
      }
    } else if (msg?.type === 'assistant') {
      const content = msg?.message?.content
      if (Array.isArray(content)) {
        const thinkingText = content
          .filter(b => b && b.type === 'thinking')
          .map(b => (typeof b.thinking === 'string' ? b.thinking : ''))
          .join('\n').trim()
        const assistantText = content
          .filter(b => b && b.type === 'text')
          .map(b => (typeof b.text === 'string' ? b.text : ''))
          .join('\n').trim()
        if (assistantText || thinkingText) {
          items.push({
            id: `sa-asst-${items.length}`,
            sessionId, role: 'assistant',
            content: assistantText || '',
            ...(thinkingText ? { thinking: thinkingText } : {}),
            parentToolUseId: agentToolUseId, timestamp: ts,
          })
        }
        for (const block of content) {
          if (block && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            const toolItem = {
              id: block.id, sessionId, toolName: block.name,
              input: block.input || {}, status: 'completed',
              parentToolUseId: agentToolUseId, timestamp: ts,
            }
            toolIndexMap.set(block.id, items.length)
            items.push(toolItem)
          }
        }
      }
    }
  }
  return items
})

// claude.restSession / wakeSession / isResting: mirror the resting-UX
// flag from electron/claude-agent-manager.ts:2481+. The renderer flips
// a session into "resting" when the user wants to pause it without
// destroying the SDK session id — abort any in-flight query, clear the
// streaming guard, and emit a single system-message hint so the panel
// shows "tap to wake". Wake clears the flag; the next sendMessage also
// clears it (see claude.sendMessage below).
registerHandler('claude.restSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const session = sessions.get(sessionId)
  if (!session) return false
  if (session.abortController) {
    try { session.abortController.abort() } catch { /* already aborted */ }
  }
  session.abortController = null
  session.streaming = false
  session.isResting = true
  sendEvent('claude:message', {
    sessionId,
    message: {
      id: `sys-rest-${Date.now()}`,
      sessionId,
      role: 'system',
      content: 'Session is resting. Send a message to wake it up.',
      timestamp: Date.now(),
    },
  })
  return true
})
registerHandler('claude.wakeSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const session = sessions.get(sessionId)
  if (!session) return false
  session.isResting = false
  return true
})
registerHandler('claude.isResting', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const session = sessions.get(sessionId)
  return session?.isResting === true
})

// Real SDK-driven sendMessage. Each call kicks off a fresh single-shot
// query() with `resume: <previousSdkSessionId>` so the SDK preserves
// context across turns. Streaming-input mode + control methods
// (interrupt/setPermissionMode/setModel mid-stream) are deferred — the
// minimal flow here is "user types, model responds, repeat". Setters
// like setPermissionMode still mutate session state and the next
// sendMessage picks them up via queryOptions.
//
// SDKMessage→event mapping (best-effort, mirrors Electron's processMessage
// for the events the renderer listens to):
//   system/init      → claude:status (metadata refresh + sdkSessionId capture)
//   assistant        → claude:message (raw SDK assistant message; renderer
//                      already knows how to extract text + tool_use blocks
//                      from BetaMessage shape)
//   result/success   → claude:result (full SDKResultMessage)
//                      → claude:turn-end (legacy completion signal)
//   result/error     → claude:error (errMsg) + claude:turn-end (reason:'error')
//   any throw        → claude:error + claude:turn-end (reason:'error')
//
// SDK-unavailable fallback (e.g. release without bundled node_modules)
// preserves the original stub so the renderer doesn't hang on a never-
// resolving promise. We log to stderr so the dev/release distinction is
// visible.
registerHandler('claude.sendMessage', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.sendMessage: missing sessionId')
  }
  const prompt = typeof params?.prompt === 'string' ? params.prompt : ''
  const s = ensureSession(sessionId)
  if (s.streaming) {
    // Mirror Electron contract: queueing is renderer-side concern; we
    // just refuse the second concurrent send.
    return { ok: false, error: 'session already streaming' }
  }
  // Mirror Electron line 581-582: any incoming sendMessage wakes a
  // resting session — the user just typed, so they want a reply.
  if (s.isResting) s.isResting = false

  const sdk = await loadAnthropicSdk()
  if (!sdk || typeof sdk.query !== 'function') {
    // Same stub the pre-#21 handler emitted, kept for SDK-unavailable
    // dev shells and as a graceful fallback. Logged so it's obvious
    // this isn't a real reply.
    process.stderr.write(`[sidecar] claude.sendMessage: SDK unavailable, returning stub for session ${sessionId}\n`)
    sendEvent('claude:message', { sessionId, message: { role: 'assistant', content: '(stub reply — SDK unavailable)' } })
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'completed', result: '(stub)' } })
    return { ok: true, stub: true }
  }

  const cwd = (s.options && typeof s.options === 'object' && typeof s.options.cwd === 'string') ? s.options.cwd : process.cwd()
  // Mirror Electron's queryOptions construction (claude-agent-manager.ts).
  // Without these the sidecar session would run as a vanilla Anthropic
  // chat — no Bash/Read/Edit tools, no system prompt preset, no partial
  // streaming, no settings file pickup. Each option lines up with the
  // Electron equivalent so behaviour matches across hosts.
  const sdkMode = s.permissionMode === 'bypassPlan' ? 'plan' : s.permissionMode
  const sdkModel = sdkModelForClaudeSelection(s.model)
  const claudeCodePath = resolveClaudeCliBinary()
  const queryOptions = {
    cwd,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    includePartialMessages: true,
    promptSuggestions: true,
    settingSources: ['user', 'project', 'local'],
    agentProgressSummaries: true,
    toolConfig: { askUserQuestion: { previewFormat: 'html' } },
  }
  if (sdkMode && sdkMode !== 'default') queryOptions.permissionMode = sdkMode
  if (s.permissionMode === 'bypassPermissions') queryOptions.allowDangerouslySkipPermissions = true
  if (s.effort) queryOptions.effort = s.effort
  if (sdkModel) queryOptions.model = sdkModel
  if (claudeCodePath) queryOptions.pathToClaudeCodeExecutable = claudeCodePath
  // Load installed plugins from ~/.claude/plugins/installed_plugins.json.
  // Skips the option entirely when no plugins are installed, mirroring
  // Electron's `installedPlugins.length > 0 ? { plugins } : {}` spread.
  const installedPlugins = await loadInstalledPlugins()
  if (installedPlugins.length > 0) queryOptions.plugins = installedPlugins
  // canUseTool: SDK calls this before each tool_use; we either auto-
  // approve based on permissionMode + tool name, or surface a
  // permission-request / ask-user event to the renderer and wait for
  // the user's decision (resolved via claude.resolvePermission /
  // claude.resolveAskUser handlers below). Mirrors Electron's
  // claude-agent-manager.ts:745. ExitPlanMode in bypassPlan / plan
  // mode also auto-promotes to bypassPermissions / acceptEdits when
  // the user clicks "allow", emitting claude:modeChange.
  queryOptions.canUseTool = (toolName, input, opts) => buildCanUseTool(s, sessionId, toolName, input, opts)
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW gets read by the SDK-spawned claude
  // binary, so wire it via queryOptions.env (forwarded to the child).
  if (s.autoCompactWindow) {
    queryOptions.env = { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(s.autoCompactWindow) }
  }
  if (s.sdkSessionId) {
    queryOptions.resume = s.sdkSessionId
    // When resuming with an empty prompt, opt into continue mode so the
    // SDK keeps autonomous progress. Mirrors Electron behaviour.
    if (!prompt || prompt.trim() === '' || prompt.trim() === ' ') {
      queryOptions.continue = true
    }
  }

  // Build prompt arg. With image attachments we yield a single
  // SDKUserMessage via an async generator (the SDK accepts both `string`
  // and `AsyncIterable<SDKUserMessage>` for `prompt`).
  let promptArg = prompt || ' '
  const images = Array.isArray(params?.images) ? params.images : null
  if (images && images.length > 0) {
    const imageBlocks = images.map(dataUrlToContentBlock).filter(Boolean)
    if (imageBlocks.length > 0) {
      const contentBlocks = [
        ...imageBlocks,
        ...(prompt ? [{ type: 'text', text: prompt }] : []),
      ]
      const userMessage = { type: 'user', message: { role: 'user', content: contentBlocks } }
      promptArg = (async function* singleMessage() { yield userMessage })()
    }
  }

  s.streaming = true
  s.abortController = new AbortController()
  queryOptions.abortController = s.abortController

  try {
    const generator = sdk.query({ prompt: promptArg, options: queryOptions })
    s.currentQuery = generator
    for await (const msg of generator) {
      if (s.abortController.signal.aborted) break
      // Capture session_id from any message that carries one — the SDK
      // emits it on every message, but we specifically watch system/init
      // for the first canonical id.
      if (msg && typeof msg.session_id === 'string') {
        s.sdkSessionId = msg.session_id
      }
      const t = msg?.type
      if (t === 'system' && msg.subtype === 'init') {
        // Apply SDK-reported overrides (sdkSessionId/cwd/model/permissionMode)
        // before snapshotting so the renderer sees the canonical values.
        // The full meta shape avoids ClaudeAgentPanel crashing on
        // .inputTokens.toLocaleString() etc.
        if (typeof msg.session_id === 'string') s.sdkSessionId = msg.session_id
        if (typeof msg.model === 'string') s.model = msg.model
        if (typeof msg.permissionMode === 'string') s.permissionMode = msg.permissionMode
        const meta = buildSessionMeta(s)
        if (typeof msg.cwd === 'string' && meta) meta.cwd = msg.cwd
        sendEvent('claude:status', { sessionId, meta })
      } else if (t === 'stream_event') {
        // Real-time text/thinking deltas from the model stream. The
        // renderer's onStream listener uses payload.data to drive
        // per-character append before the full assistant message lands.
        // We mirror Electron's filter: only content_block_delta blocks
        // with text/thinking deltas get forwarded; other stream events
        // (message_start / message_delta usage updates / etc) are
        // ignored at this layer except for usage tracking below.
        const ev = msg.event
        // Usage tracking — pull from message_start / message_delta so
        // the in-progress turn's context usage is visible to
        // claude.getContextUsage even mid-stream.
        if (ev && (ev.type === 'message_start' || ev.type === 'message_delta')) {
          const u = ev.usage || ev.message?.usage
          if (u && !msg.parent_tool_use_id) {
            const inputTotal = (u.input_tokens || 0)
              + (u.cache_creation_input_tokens || 0)
              + (u.cache_read_input_tokens || 0)
            s.lastUsage = {
              input_tokens: u.input_tokens || 0,
              output_tokens: u.output_tokens || s.lastUsage?.output_tokens || 0,
              cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
              cache_read_input_tokens: u.cache_read_input_tokens || 0,
              totalTokens: inputTotal,
              model: s.model || s.lastUsage?.model || null,
            }
          }
        }
        if (ev && ev.type === 'content_block_delta') {
          const d = ev.delta
          if (d?.text) {
            sendEvent('claude:stream', { sessionId, data: { text: d.text, parentToolUseId: msg.parent_tool_use_id ?? null } })
          }
          if (d?.thinking) {
            sendEvent('claude:stream', { sessionId, data: { thinking: d.thinking, parentToolUseId: msg.parent_tool_use_id ?? null } })
          }
        }
      } else if (t === 'assistant') {
        sendEvent('claude:message', { sessionId, message: msg })
        // Mirror Electron's processMessage: also fire dedicated
        // claude:tool-use events for each tool_use content block so the
        // renderer's tool-call panel renders. The text payload comes
        // through claude:message; this is purely additive.
        const blocks = msg.message?.content
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block && block.type === 'tool_use' && typeof block.id === 'string') {
              sendEvent('claude:tool-use', {
                sessionId,
                toolCall: {
                  id: block.id,
                  sessionId,
                  toolName: block.name,
                  input: block.input || {},
                  status: 'running',
                  parentToolUseId: msg.parent_tool_use_id ?? null,
                  timestamp: Date.now(),
                },
              })
            }
          }
        }
      } else if (t === 'user') {
        // SDK emits a user message mid-stream when it runs a tool on
        // behalf of the model — content has tool_result blocks. Mirror
        // Electron and turn each into a claude:tool-result event keyed
        // by the originating tool_use_id so the renderer can mark the
        // call complete + show the result.
        const blocks = msg.message?.content
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              sendEvent('claude:tool-result', {
                sessionId,
                result: {
                  id: block.tool_use_id,
                  status: block.is_error ? 'error' : 'success',
                  result: block.content,
                },
              })
            }
          }
        }
      } else if (t === 'result') {
        // Capture authoritative usage from the result. This overrides
        // mid-stream estimates with the final number for the turn.
        if (msg.usage) {
          const u = msg.usage
          const inputTotal = (u.input_tokens || 0)
            + (u.cache_creation_input_tokens || 0)
            + (u.cache_read_input_tokens || 0)
          s.lastUsage = {
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
            cache_read_input_tokens: u.cache_read_input_tokens || 0,
            totalTokens: inputTotal,
            model: s.model || s.lastUsage?.model || null,
            totalCostUsd: msg.total_cost_usd ?? s.lastUsage?.totalCostUsd ?? 0,
            numTurns: msg.num_turns ?? s.lastUsage?.numTurns ?? 0,
          }
        }
        if (msg.subtype === 'success') {
          sendEvent('claude:result', { sessionId, result: msg })
          sendEvent('claude:turn-end', { sessionId, payload: { reason: 'completed', result: msg.result, sdkSessionId: msg.session_id } })
        } else {
          sendEvent('claude:error', { sessionId, error: msg.message || 'query error' })
          sendEvent('claude:turn-end', { sessionId, payload: { reason: 'error' } })
        }
      }
      // Other SDKMessage variants (partial_assistant, tool_progress, etc.)
      // are ignored for now. They're additive — adding handlers later
      // won't break the minimal flow.
    }
    return { ok: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const aborted = s.abortController?.signal.aborted
      || /aborted/i.test(errMsg)
    if (!aborted) {
      sendEvent('claude:error', { sessionId, error: errMsg })
    }
    sendEvent('claude:turn-end', { sessionId, payload: { reason: aborted ? 'aborted' : 'error' } })
    return { ok: !aborted, error: aborted ? undefined : errMsg }
  } finally {
    s.streaming = false
    s.currentQuery = null
    s.abortController = null
  }
})

registerHandler('claude.stopSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.stopSession: missing sessionId')
  }
  const s = sessions.get(sessionId)
  if (s?.abortController) {
    try { s.abortController.abort() } catch { /* already aborted */ }
  }
  const existed = sessions.delete(sessionId)
  return { ok: true, existed }
})

registerHandler('claude.abortSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.abortSession: missing sessionId')
  }
  const session = sessions.get(sessionId)
  if (session?.abortController) {
    try { session.abortController.abort() } catch { /* already aborted */ }
  }
  if (session) {
    session.active = false
    // claude:turn-end is also emitted by sendMessage's catch, but we
    // emit here too in case abort is called after streaming finished
    // (the renderer expects an explicit signal).
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'aborted' } })
  }
  return { ok: true }
})

// Per-session state setters. These persist values into the session map
// so getters return what the renderer last set. When the SDK lands,
// these hooks will additionally push the change into the live query
// instance (e.g. set the model on a streaming session). For now they
// just maintain the visible state contract.

registerHandler('claude.setAutoContinue', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const opts = params?.opts || params?.options || {}
  const s = ensureSession(sessionId)
  if (typeof opts.enabled === 'boolean') s.autoContinue.enabled = opts.enabled
  if (typeof opts.max === 'number') s.autoContinue.max = opts.max
  if (typeof opts.prompt === 'string') s.autoContinue.prompt = opts.prompt
  // Reset usage counter when toggling, matches Electron behaviour.
  s.autoContinue.used = 0
  return true
})

registerHandler('claude.getAutoContinue', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return null
  const s = sessions.get(sessionId)
  return s ? { ...s.autoContinue } : null
})

// Tools that acceptEdits mode auto-approves without surfacing a UI prompt.
// Mirror of electron/claude-agent-manager.ts:793.
const ACCEPT_EDITS_AUTO_APPROVED_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep'])

// canUseTool implementation. Returns either an immediate decision
// (`{behavior:'allow'|'deny', ...}`) or a Promise that resolves when the
// renderer answers the permission-request / ask-user event. The
// per-mode auto-approval logic mirrors Electron exactly so users see
// the same prompts/auto-approvals across hosts.
function buildCanUseTool(session, sessionId, toolName, input, opts) {
  const toolUseId = opts?.toolUseID
  // AskUserQuestion is a special pseudo-tool the SDK uses to ask the
  // user follow-up questions during a turn. Always surface UI for it.
  if (toolName === 'AskUserQuestion') {
    return new Promise((resolve) => {
      if (toolUseId) session.pendingAskUser.set(toolUseId, { resolve, input })
      sendEvent('claude:ask-user', {
        sessionId,
        data: { toolUseId, questions: input?.questions },
      })
    })
  }
  // bypassPlan: auto-approve everything except ExitPlanMode (which
  // requires explicit confirmation to switch to bypass execution).
  if (session.permissionMode === 'bypassPlan') {
    if (toolName === 'ExitPlanMode') {
      return new Promise((resolve) => {
        if (toolUseId) {
          session.pendingPermissions.set(toolUseId, {
            resolve: (result) => {
              if (result?.behavior === 'allow') {
                session.permissionMode = 'bypassPermissions'
                sendEvent('claude:modeChange', { sessionId, mode: 'bypassPermissions' })
              }
              resolve(result)
            },
          })
        }
        sendEvent('claude:permission-request', {
          sessionId,
          data: {
            toolUseId, toolName, input,
            suggestions: opts?.suggestions,
            decisionReason: 'Exit plan mode and switch to bypass execution?',
          },
        })
      })
    }
    return { behavior: 'allow', updatedInput: input || {} }
  }
  // bypassPermissions auto-allows everything. UI is bypassed entirely.
  if (session.permissionMode === 'bypassPermissions') {
    return { behavior: 'allow', updatedInput: input || {} }
  }
  // acceptEdits auto-allows safe file/read tools; everything else still
  // prompts.
  if (session.permissionMode === 'acceptEdits' && ACCEPT_EDITS_AUTO_APPROVED_TOOLS.has(toolName)) {
    return { behavior: 'allow', updatedInput: input || {} }
  }
  // default / acceptEdits-not-listed / plan: surface UI and await user.
  return new Promise((resolve) => {
    const wrappedResolve = toolName === 'ExitPlanMode'
      ? (result) => {
          if (result?.behavior === 'allow') {
            // dontAskAgain → acceptEdits, otherwise default. Matches
            // Electron's exit-plan UX.
            session.permissionMode = result.dontAskAgain ? 'acceptEdits' : 'default'
            sendEvent('claude:modeChange', { sessionId, mode: session.permissionMode })
          }
          resolve(result)
        }
      : resolve
    if (toolUseId) session.pendingPermissions.set(toolUseId, { resolve: wrappedResolve })
    sendEvent('claude:permission-request', {
      sessionId,
      data: {
        toolUseId, toolName, input,
        suggestions: opts?.suggestions,
        decisionReason: opts?.decisionReason,
      },
    })
  })
}

// Renderer-side resolution for an outstanding permission request. Looks
// up the pending entry by toolUseId, calls its resolve fn, and emits a
// `claude:permission-resolved` notification so panels can clear their UI.
registerHandler('claude.resolvePermission', async (params) => {
  const sessionId = params?.sessionId
  const toolUseId = params?.toolUseId
  const result = params?.result
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof toolUseId !== 'string' || !toolUseId) return false
  const session = sessions.get(sessionId)
  if (!session) return false
  const pending = session.pendingPermissions.get(toolUseId)
  if (!pending) return false
  session.pendingPermissions.delete(toolUseId)
  try { pending.resolve(result) } catch { /* swallow — caller already gave up */ }
  sendEvent('claude:permission-resolved', { sessionId, toolUseId })
  return true
})

registerHandler('claude.resolveAskUser', async (params) => {
  const sessionId = params?.sessionId
  const toolUseId = params?.toolUseId
  const answers = params?.answers
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof toolUseId !== 'string' || !toolUseId) return false
  const session = sessions.get(sessionId)
  if (!session) return false
  const pending = session.pendingAskUser.get(toolUseId)
  if (!pending) return false
  session.pendingAskUser.delete(toolUseId)
  try { pending.resolve(answers) } catch { /* swallow */ }
  sendEvent('claude:ask-user-resolved', { sessionId, toolUseId })
  return true
})

registerHandler('claude.setPermissionMode', async (params) => {
  const sessionId = params?.sessionId
  const mode = params?.mode
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof mode !== 'string') return false
  const s = ensureSession(sessionId)
  s.permissionMode = mode
  // Mirror Electron's claude:modeChange event so listeners refresh.
  sendEvent('claude:modeChange', { sessionId, mode })
  return true
})

registerHandler('claude.setModel', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const s = ensureSession(sessionId)
  if (typeof params?.model === 'string') s.model = params.model
  if (typeof params?.autoCompactWindow === 'number') s.autoCompactWindow = params.autoCompactWindow
  return true
})

registerHandler('claude.setEffort', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const s = ensureSession(sessionId)
  if (typeof params?.effort === 'string') s.effort = params.effort
  return true
})

registerHandler('claude.resetSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  // Drop the session record entirely. Next startSession recreates it.
  return sessions.delete(sessionId)
})

// Auth + account stubs. The renderer's auth UI calls these on every panel
// mount, so they need to return shapes that don't throw at the type level.
// Real impls will land when @anthropic-ai/claude-agent-sdk + the keychain
// integration move into the sidecar.
// Lazy SDK loader. Tries to import @anthropic-ai/claude-agent-sdk once;
// caches the resolved module or null if the import fails (e.g. release
// build without bundled node_modules). Subsequent calls return the
// cached value instantly. This lets feature handlers opportunistically
// use real SDK calls when available and fall back to stubs otherwise.
//
// We expose loadAnthropicSdk for tests so they can stub a fake module
// and verify augmentation paths without depending on the real SDK
// (which spawns the claude CLI on first call).
let _sdkLoadAttempted = false
let _sdkModule = null
let _sdkOverrideSet = false
let _sdkOverride = null

async function loadAnthropicSdk() {
  if (_sdkOverrideSet) return _sdkOverride
  if (_sdkLoadAttempted) return _sdkModule
  _sdkLoadAttempted = true
  // Escape hatch for tests + dev shells: BAT_SIDECAR_DISABLE_SDK=1
  // forces the SDK-unavailable path even if @anthropic-ai/claude-agent-sdk
  // is importable. The e2e test uses this so claude.sendMessage takes
  // the deterministic stub path instead of trying to call the real API.
  if (process.env.BAT_SIDECAR_DISABLE_SDK === '1') {
    _sdkModule = null
    return null
  }
  try {
    _sdkModule = await import('@anthropic-ai/claude-agent-sdk')
    return _sdkModule
  } catch {
    _sdkModule = null
    return null
  }
}

// Test-only setter — pass an object to swap in a fake SDK, null to
// force the "SDK unavailable" path, undefined to clear the override
// and let normal lazy loading resume.
function __setSdkOverrideForTests(value) {
  if (value === undefined) {
    _sdkOverrideSet = false
    _sdkOverride = null
  } else {
    _sdkOverrideSet = true
    _sdkOverride = value
  }
}
export { loadAnthropicSdk, __setSdkOverrideForTests }

const STUB_AUTH_ERR = 'claude account ops not yet wired through Tauri sidecar'

// authLogin shells out to `claude auth login` (interactive, browser-based
// OAuth). The CLI prints a URL, opens the user's browser, and exits when
// the OAuth callback fires; we just wait for the process to exit. The
// 180s ceiling is generous for a real-user flow but bounded so a stuck
// flow eventually fails. Uses the bundled CLI when available so a fresh
// release MSI install can authenticate without requiring system claude.
registerHandler('claude.authLogin', async () => {
  return new Promise((resolve) => {
    spawnClaudeCli(['auth', 'login'], { timeout: AUTH_LOGIN_TIMEOUT_MS }, (err) => {
      if (err) resolve({ success: false, error: err.message })
      else resolve({ success: true })
    })
  })
})
// authLogout shells out to `claude auth logout` and reports the result.
// 10s timeout — the CLI exits ~immediately on success. Failure usually
// means the CLI isn't installed or auth state is corrupt; surface the
// error message so the renderer can show it.
registerHandler('claude.authLogout', async () => {
  return new Promise((resolve) => {
    spawnClaudeCli(['auth', 'logout'], { timeout: AUTH_STATUS_TIMEOUT_MS }, (err) => {
      if (err) resolve({ success: false, error: err.message })
      else resolve({ success: true })
    })
  })
})
registerHandler('claude.accountImportCurrent', async () => null)
registerHandler('claude.accountLoginNew', async () => ({ success: false, error: STUB_AUTH_ERR }))
registerHandler('claude.accountSwitch', async (params) => {
  if (typeof params?.accountId !== 'string') {
    throw new Error('claude.accountSwitch: missing accountId')
  }
  return false
})
registerHandler('claude.accountRemove', async (params) => {
  if (typeof params?.accountId !== 'string') {
    throw new Error('claude.accountRemove: missing accountId')
  }
  return false
})
registerHandler('claude.accountMarkWarningShown', async () => true)

// Read-only metadata. Two of these are now real implementations:
//   - claude.getCliPath: locate the `claude` binary on PATH (no SDK dep).
//   - claude.listSessions: parse JSONL session files under
//     ~/.claude/projects/<encoded-cwd>/, mirroring the fallback path
//     of the Electron-side claude-agent-manager.listSessionsFallback().
// The rest return inert defaults until @anthropic-ai/claude-agent-sdk
// moves into the sidecar.
registerHandler('claude.getCliPath', async () => findClaudeCliPath() ?? '')
registerHandler('claude.listSessions', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) return []
  return listSessionsFallback(cwd)
})
// Returns the builtin claude model list, optionally augmented with
// SDK-discovered models when @anthropic-ai/claude-agent-sdk is
// importable. Builtin entries are always present and tagged source:
// 'builtin'; SDK entries are tagged source: 'sdk' and de-duped against
// the builtin values (including [1m] variants). Mirrors the Electron
// claudeAgentManager.getSupportedModels() behaviour, including the
// "SDK fails → builtins-only" fallback.
//
// In release builds without bundled node_modules, the SDK import will
// fail and we silently return builtins. Drift guard test still applies.
registerHandler('claude.getSupportedModels', async () => {
  const builtins = CLAUDE_BUILTIN_MODELS.map(m => ({ ...m, source: 'builtin' }))
  try {
    const sdk = await loadAnthropicSdk()
    if (!sdk) return builtins
    const dedupKeys = new Set(CLAUDE_BUILTIN_DEDUP_KEYS)
    const instance = sdk.query({ prompt: '', options: { cwd: '/' } })
    const sdkModels = await instance.supportedModels()
    const sdkFiltered = (Array.isArray(sdkModels) ? sdkModels : [])
      .filter(m => m && typeof m.value === 'string'
        && !dedupKeys.has(m.value)
        && !dedupKeys.has(`${m.value}[1m]`))
      .map(m => ({ ...m, source: 'sdk' }))
    return [...builtins, ...sdkFiltered]
  } catch {
    return builtins
  }
})
// getSupportedCommands / getSupportedAgents / getAccountInfo follow the
// same SDK-augmentation pattern as getSupportedModels: try the SDK
// first, fall back to the previous stub shape (empty list / null) if
// the SDK isn't reachable. The Query instance is short-lived — we
// instantiate it just to call the read method, no actual prompt sent,
// matching what getSupportedModels does.
registerHandler('claude.getSupportedCommands', async () => {
  try {
    const sdk = await loadAnthropicSdk()
    if (!sdk || typeof sdk.query !== 'function') return []
    const instance = sdk.query({ prompt: '', options: { cwd: '/' } })
    const cmds = await instance.supportedCommands()
    return Array.isArray(cmds) ? cmds : []
  } catch {
    return []
  }
})
registerHandler('claude.getSupportedAgents', async () => {
  try {
    const sdk = await loadAnthropicSdk()
    if (!sdk || typeof sdk.query !== 'function') return []
    const instance = sdk.query({ prompt: '', options: { cwd: '/' } })
    const agents = await instance.supportedAgents()
    return Array.isArray(agents) ? agents : []
  } catch {
    return []
  }
})
registerHandler('claude.getAccountInfo', async () => {
  try {
    const sdk = await loadAnthropicSdk()
    if (!sdk || typeof sdk.query !== 'function') return null
    const instance = sdk.query({ prompt: '', options: { cwd: '/' } })
    const info = await instance.accountInfo()
    return info ?? null
  } catch {
    return null
  }
})
// Session state lookups read from the per-session map populated by
// startSession + the various setters above. When no session exists for
// the given id we return null to match Electron's behaviour.
registerHandler('claude.getSessionState', async (params) => {
  const s = sessions.get(String(params?.sessionId ?? ''))
  if (!s) return null
  return {
    active: s.active,
    permissionMode: s.permissionMode,
    model: s.model,
    effort: s.effort,
    autoCompactWindow: s.autoCompactWindow,
  }
})
// buildSessionMeta(session): shared between the getSessionMeta RPC and
// every claude:status emit so the renderer's ClaudeAgentPanel always
// gets the full 19-field shape. The renderer reads
// `inputTokens.toLocaleString()` (no optional chaining), so a sparse
// meta payload from a status event would crash the status line — we
// must always emit the full shape with 0 / null defaults.
//
// lastUsage is captured snake_case from SDK message_start/message_delta
// /result events; translate to the camelCase shape the renderer expects.
function buildSessionMeta(s) {
  if (!s) return null
  const u = s.lastUsage
  const inputTokens = u?.input_tokens ?? 0
  const outputTokens = u?.output_tokens ?? 0
  const cacheReadTokens = u?.cache_read_input_tokens ?? 0
  const cacheCreationTokens = u?.cache_creation_input_tokens ?? 0
  const contextTokens = inputTokens + cacheReadTokens + cacheCreationTokens
  const contextWindow = expectedContextWindowForModel(u?.model || s.model) || 0
  return {
    permissionMode: s.permissionMode ?? 'default',
    model: s.model ?? null,
    effort: s.effort ?? null,
    autoCompactWindow: s.autoCompactWindow ?? null,
    sdkSessionId: s.sdkSessionId ?? null,
    cwd: (s.options && typeof s.options === 'object' && typeof s.options.cwd === 'string') ? s.options.cwd : null,
    totalCost: u?.totalCostUsd ?? 0,
    inputTokens,
    outputTokens,
    durationMs: 0,
    numTurns: u?.numTurns ?? 0,
    contextWindow,
    maxOutputTokens: 0,
    contextTokens,
    cacheReadTokens,
    cacheCreationTokens,
    callCacheRead: 0,
    callCacheWrite: 0,
    lastQueryCalls: 0,
  }
}

registerHandler('claude.getSessionMeta', async (params) => {
  const s = sessions.get(String(params?.sessionId ?? ''))
  return buildSessionMeta(s)
})
// claude.getContextUsage: surface the cached usage from the last
// stream_event / result for this session in a shape the renderer's
// ContextUsagePopup understands (subset of SDKControlGetContextUsageResponse:
// categories[], totalTokens, maxTokens, percentage, model, plus
// optional apiUsage). We return null if no turn has completed yet —
// renderer interprets that as "no data yet" and hides the popup.
//
// Live mid-turn data via the SDK control method (instance.getContextUsage())
// would require streaming-input mode, which we don't implement yet.
// Cached values cover the common case where the user opens the popup
// between turns.
registerHandler('claude.getContextUsage', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string') return null
  const s = sessions.get(sessionId)
  if (!s || !s.lastUsage) return null
  const u = s.lastUsage
  const model = u.model || s.model || null
  const maxTokens = expectedContextWindowForModel(model) || 200000
  const totalTokens = u.totalTokens || 0
  const percentage = maxTokens > 0 ? Math.round((totalTokens / maxTokens) * 100) : 0
  return {
    categories: [{ name: 'Context', tokens: totalTokens, color: '#8B5CF6' }],
    totalTokens,
    maxTokens,
    percentage,
    model: model || 'unknown',
    apiUsage: {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
    },
  }
})
registerHandler('claude.getWorktreeStatus', async (params) => {
  const sessionId = String(params?.sessionId ?? '')
  if (!sessionId) return null
  const info = activeWorktrees.get(sessionId)
  if (!info) return null
  return worktreeStatus(sessionId)
})
// claude.scanSkills walks <cwd>/.claude/skills + ~/.claude/skills and
// returns SkillMeta entries. No SDK dep — pure fs walk + YAML
// frontmatter parsing. Mirrors electron/openai-agent/skills-scanner.ts.
// claude.cleanupWorktree drops the worktree associated with a session.
// In the Electron flow it also resets the agent session's cwd back to
// originalCwd and emits claude:worktree-info — those happen in the
// session manager, which still lives in the renderer/Electron side
// for now. The sidecar just runs the disk-level cleanup.
registerHandler('claude.cleanupWorktree', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const deleteBranch = params?.deleteBranch !== false
  if (!sessionId) return false
  try {
    await worktreeRemove(sessionId, deleteBranch)
    sendEvent('claude:worktree-info', { sessionId, payload: null })
    return true
  } catch {
    return false
  }
})
registerHandler('claude.scanSkills', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) return []
  return scanSkills(cwd)
})

// --- openai.* stubs --------------------------------------------------------

registerHandler('openai.getApiKeyStatus', async () => ({ hasKey: false }))
registerHandler('openai.setApiKey', async (params) => {
  if (typeof params?.apiKey !== 'string') {
    throw new Error('openai.setApiKey: missing apiKey')
  }
  return false
})
registerHandler('openai.clearApiKey', async () => true)
// openai.listSessions reads ~/.better-agent-terminal/openai-sessions/
//   <yyyy>/<mm>/<dd>/<sdkSessionId>.jsonl. Mirrors persistence.listAllSessions
// from electron/openai-agent/persistence.ts. The cwd parameter is
// accepted but unused — the Electron impl ignores it too because
// OpenAI sessions aren't grouped by working directory.
registerHandler('openai.listSessions', async () => listOpenAISessions())
registerHandler('openai.compactNow', async (params) => {
  if (typeof params?.sessionId !== 'string' || !params.sessionId) {
    throw new Error('openai.compactNow: missing sessionId')
  }
  return false
})

// --- worktree.* stubs ------------------------------------------------------
//
// Until the agent worktree manager moves into the sidecar, these report
// success:false with a clear error so the renderer's worktree panel
// shows a "feature unavailable" hint rather than crashing.

// worktree.* — real port of electron/worktree-manager.ts. Pure git
// execFile + fs ops, no Anthropic SDK dependency. State lives in this
// sidecar process for its lifetime (matches the Electron singleton).
registerHandler('worktree.create', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!sessionId || !cwd) {
    return { success: false, error: 'worktree.create: missing sessionId or cwd' }
  }
  try {
    const info = await worktreeCreate(sessionId, cwd)
    return { success: true, ...info }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})
registerHandler('worktree.remove', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const deleteBranch = params?.deleteBranch !== false
  if (!sessionId) return { success: false, error: 'worktree.remove: missing sessionId' }
  try {
    await worktreeRemove(sessionId, deleteBranch)
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})
registerHandler('worktree.status', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  if (!sessionId) return null
  return worktreeStatus(sessionId)
})
// merge stays a stub — the Electron register-handlers calls a method
// (mergeWorktree) that doesn't exist on WorktreeManager, so the feature
// is broken on Electron too. We keep it stub-routed and surface a
// clear error rather than implementing something the Electron build
// can't validate against.
registerHandler('worktree.merge', async () => ({
  success: false,
  error: 'worktree.merge not implemented (electron parity)',
}))
registerHandler('worktree.rehydrate', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  const worktreePath = typeof params?.worktreePath === 'string' ? params.worktreePath : ''
  const branchName = typeof params?.branchName === 'string' ? params.branchName : ''
  if (!sessionId || !worktreePath) return { success: false }
  worktreeRehydrate(sessionId, cwd, worktreePath, branchName)
  return { success: true }
})

// --- agent.* ---------------------------------------------------------------
//
// Single read-only method today: which presets the host knows how to
// start. Mirrored from src/types/agent-presets.ts AGENT_PRESETS — the
// renderer's NewTerminalQuickPick uses this to gate which preset cards
// render. Returning [] would gray out the entire picker. Keep this
// list in sync with the renderer constant; if you add a preset there
// without updating this, the new card will not be listed under Tauri.
const AGENT_PRESET_IDS = [
  'claude-code',
  'claude-code-v2',
  'claude-code-worktree',
  'claude-cli',
  'claude-cli-worktree',
  'codex-agent',
  'codex-agent-worktree',
  'openai-agent',
  'codex-cli',
  'none',
]
registerHandler('agent.listPresets', async () => AGENT_PRESET_IDS)
export { AGENT_PRESET_IDS }

// Mirror of src/utils/claude-model-presets.ts CLAUDE_BUILTIN_MODELS.
// Drift guard: see node-sidecar/tests/server.test.mjs.
const CLAUDE_BUILTIN_MODELS = [
  { value: 'claude-opus-4-7:auto-compact-200k', displayName: 'Opus 4.7 · 200K Auto-Compact', description: 'claude-opus-4-7 · compact at 200K tokens' },
  { value: 'claude-opus-4-7:auto-compact-300k', displayName: 'Opus 4.7 · 300K Auto-Compact', description: 'claude-opus-4-7 · compact at 300K tokens' },
  { value: 'claude-opus-4-7:auto-compact-400k', displayName: 'Opus 4.7 · 400K Auto-Compact', description: 'claude-opus-4-7 · compact at 400K tokens' },
  { value: 'claude-opus-4-7:1m', displayName: 'Opus 4.7 · 1M', description: 'claude-opus-4-7 · no early auto-compact' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6 (1M)', description: 'claude-opus-4-6 · 1M context' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6 (1M)', description: 'claude-sonnet-4-6 · 1M context' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'claude-haiku-4-5 · fast & lightweight' },
]
// Mirror of src/utils/claude-model-presets.ts CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS
// keys. This is the dedup set for SDK-discovered models — note it
// includes [1m] variants of base IDs (which the builtin model list
// itself doesn't carry, but the SDK does emit), so SDK results that
// duplicate a builtin via either form get filtered. Drift guard test
// validates this stays in sync with the renderer-side TS source.
const CLAUDE_BUILTIN_DEDUP_KEYS = [
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6[1m]',
  'claude-haiku-4-5-20251001',
]

// Mirror of src/utils/claude-model-presets.ts CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS,
// plus the auto-compact preset entries. Drift guard (test suite) re-reads
// the TS file and sorted-equals the keys against this map. Used by
// claude.getContextUsage to compute the maxTokens budget.
const CLAUDE_MODEL_CONTEXT_WINDOWS = new Map([
  ['claude-opus-4-7', 1000000],
  ['claude-opus-4-7[1m]', 1000000],
  ['claude-opus-4-6', 1000000],
  ['claude-opus-4-6[1m]', 1000000],
  ['claude-sonnet-4-6', 1000000],
  ['claude-sonnet-4-6[1m]', 1000000],
  ['claude-haiku-4-5-20251001', 200000],
  // Preset variants — auto-compact wraps the underlying claude-opus-4-7,
  // so context window budget is the auto-compact target.
  ['claude-opus-4-7:auto-compact-200k', 200000],
  ['claude-opus-4-7:auto-compact-300k', 300000],
  ['claude-opus-4-7:auto-compact-400k', 400000],
  ['claude-opus-4-7:1m', 1000000],
])

function expectedContextWindowForModel(model) {
  if (!model) return null
  if (CLAUDE_MODEL_CONTEXT_WINDOWS.has(model)) return CLAUDE_MODEL_CONTEXT_WINDOWS.get(model)
  // Fallback: strip any [1m] suffix and try base id.
  const base = model.replace(/\[1m\]$/, '')
  if (CLAUDE_MODEL_CONTEXT_WINDOWS.has(base)) return CLAUDE_MODEL_CONTEXT_WINDOWS.get(base)
  return null
}

// Mirror of src/utils/claude-model-presets.ts sdkModelForClaudeSelection:
// auto-compact presets all wrap the underlying claude-opus-4-7 base id,
// so the SDK call uses the base id and the auto-compact window is
// configured separately via CLAUDE_CODE_AUTO_COMPACT_WINDOW env.
const CLAUDE_OPUS_47_PRESETS = new Set([
  'claude-opus-4-7:auto-compact-200k',
  'claude-opus-4-7:auto-compact-300k',
  'claude-opus-4-7:auto-compact-400k',
  'claude-opus-4-7:1m',
])
function sdkModelForClaudeSelection(model) {
  if (!model) return undefined
  if (CLAUDE_OPUS_47_PRESETS.has(model)) return 'claude-opus-4-7'
  return model
}

// Mirror of electron/claude-agent-manager.ts installed-plugin loader.
// Reads `~/.claude/plugins/installed_plugins.json`, walks the
// pluginsData.plugins object whose values are arrays of entries with
// `installPath`, and returns the queryOptions.plugins shape the SDK
// expects: `[{ type: 'local', path }]`. Returns [] on any read/parse
// failure — plugins are optional, no install file is the common case
// for a fresh user, and the renderer surfaces nothing missing.
//
// Override hook for tests. When set, replaces the on-disk read so tests
// can drive the loader without touching the user's real ~/.claude.
let _pluginsPathOverrideForTests = null
function __setPluginsPathOverrideForTests(p) { _pluginsPathOverrideForTests = p }
async function loadInstalledPlugins() {
  const installedPlugins = []
  try {
    const path = _pluginsPathOverrideForTests
      || join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
    const raw = await readFile(path, 'utf-8')
    const data = JSON.parse(raw)
    if (data && data.plugins && typeof data.plugins === 'object') {
      for (const entries of Object.values(data.plugins)) {
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          if (entry && typeof entry.installPath === 'string') {
            installedPlugins.push({ type: 'local', path: entry.installPath })
          }
        }
      }
    }
  } catch {
    // Missing file / parse error — fine, no plugins installed.
  }
  return installedPlugins
}

// Mirror of electron/claude-agent-manager.ts dataUrlToContentBlock — parse
// "data:image/<mime>;base64,<...>" into the SDK's expected block. Skip
// >20MB base64 to dodge API rejection (raw image is ~15MB at base64 1.33x).
function dataUrlToContentBlock(dataUrl) {
  if (typeof dataUrl !== 'string') return null
  const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i)
  if (!m) return null
  const base64 = m[2]
  if (base64.length > 20 * 1024 * 1024) return null
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: base64 } }
}

export { CLAUDE_BUILTIN_MODELS, CLAUDE_BUILTIN_DEDUP_KEYS, CLAUDE_MODEL_CONTEXT_WINDOWS, expectedContextWindowForModel, sdkModelForClaudeSelection, dataUrlToContentBlock, loadInstalledPlugins, __setPluginsPathOverrideForTests, __setProjectsDirOverrideForTests }

// --- remote.* / tunnel.* stubs --------------------------------------------
//
// remote/tunnel run the cross-machine server and the LAN/Tailscale
// presence advertiser. Real implementations will land in Phase 3 (or as
// a sibling sidecar). For now we return shapes that match the renderer's
// destructuring contract so polling clientStatus / serverStatus doesn't
// crash when it reads `.connected` / `.running`.

const REMOTE_STUB_ERR = 'remote ops not yet wired through Tauri sidecar'
registerHandler('remote.startServer', async () => ({ error: REMOTE_STUB_ERR }))
registerHandler('remote.stopServer', async () => false)
registerHandler('remote.serverStatus', async () => ({
  running: false, port: null, fingerprint: null, bindInterface: null, boundHost: null, clients: [],
}))
registerHandler('remote.connect', async () => ({ error: REMOTE_STUB_ERR }))
registerHandler('remote.disconnect', async () => false)
registerHandler('remote.clientStatus', async () => ({ connected: false, info: null }))
registerHandler('remote.testConnection', async () => ({ ok: false, error: REMOTE_STUB_ERR }))
registerHandler('remote.listProfiles', async () => ({ error: REMOTE_STUB_ERR }))

registerHandler('tunnel.getConnection', async () => ({ error: 'tunnel not yet wired through Tauri sidecar' }))

// --- update.check ----------------------------------------------------------
//
// Pings the GitHub Releases API and compares the latest tag against the
// version Tauri passed in. We let the Rust side own the "what's my
// version" string (it reads PackageInfo and forwards it as `currentVersion`
// in the params), so the sidecar stays runtime-agnostic.

const GITHUB_REPO = 'tony1223/better-agent-terminal'

function compareVersions(current, latest) {
  const a = current.replace(/^v/, '').split('.').map(Number)
  const b = latest.replace(/^v/, '').split('.').map(Number)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ai = a[i] || 0
    const bi = b[i] || 0
    if (bi > ai) return true
    if (bi < ai) return false
  }
  return false
}

registerHandler('update.check', async (params) => {
  const currentVersion = String(params?.currentVersion ?? '0.0.0')
  const fallback = { hasUpdate: false, currentVersion, latestRelease: null }
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        'User-Agent': 'Better-Agent-Terminal',
        'Accept': 'application/vnd.github.v3+json',
      },
    })
    if (!res.ok) return fallback
    const release = await res.json()
    if (!release || typeof release.tag_name !== 'string') return fallback
    const latestVersion = release.tag_name.replace(/^v/, '')
    let downloadUrl = null
    if (Array.isArray(release.assets)) {
      const winAsset = release.assets.find(a =>
        typeof a?.name === 'string' && (a.name.endsWith('-win.zip') || a.name.includes('win'))
      )
      if (winAsset?.browser_download_url) downloadUrl = winAsset.browser_download_url
    }
    return {
      hasUpdate: compareVersions(currentVersion, latestVersion),
      currentVersion,
      latestRelease: {
        version: latestVersion,
        tagName: release.tag_name,
        htmlUrl: release.html_url,
        downloadUrl,
        body: release.body || '',
        publishedAt: release.published_at,
      },
    }
  } catch {
    return fallback
  }
})

// Exported for unit tests.
export { compareVersions }

// --- claude.getCliPath / claude.listSessions helpers ----------------------
//
// Both helpers run with no Anthropic SDK dependency. They mirror the
// Electron implementations under electron/claude-agent-manager.ts so the
// renderer sees the same shapes regardless of host.

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const PREVIEW_LINE_LIMIT = 20
const PREVIEW_CHARS = 120
const SESSION_LIST_LIMIT = 50

function findClaudeCliPath() {
  // Walk PATH and look for "claude" (or claude.cmd / claude.exe / claude.bat
  // on Windows). Returns the first match or null. We deliberately do not
  // shell out to `which` / `where` — readdir-by-PATHEXT is cheaper and
  // doesn't depend on platform tooling being present.
  const PATH = process.env.PATH ?? ''
  const sep = platform() === 'win32' ? ';' : ':'
  const dirs = PATH.split(sep).filter(Boolean)
  const exts = platform() === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase())
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext}`)
      try {
        accessSync(candidate, fsConstants.F_OK)
        return candidate
      } catch { /* not here, try next */ }
    }
  }
  return null
}

async function listSessionsFallback(cwd) {
  // Sessions live under ~/.claude/projects/<encoded>/, where <encoded> is
  // the cwd with all non-alphanumeric chars replaced by "-". Windows
  // sometimes case-folds the first letter, so we probe a couple of
  // alt-cased variants to be safe.
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const candidates = [join(CLAUDE_PROJECTS_DIR, encoded)]
  if (platform() === 'win32' && encoded.length > 0) {
    const lower = encoded[0].toLowerCase() + encoded.slice(1)
    const upper = encoded[0].toUpperCase() + encoded.slice(1)
    if (lower !== encoded) candidates.push(join(CLAUDE_PROJECTS_DIR, lower))
    if (upper !== encoded) candidates.push(join(CLAUDE_PROJECTS_DIR, upper))
  }

  const results = []
  for (const dir of candidates) {
    let entries
    try {
      entries = (await readdir(dir)).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of entries) {
      const filePath = join(dir, file)
      const sdkSessionId = basename(file, '.jsonl')
      try {
        const st = await stat(filePath)
        const { preview, messageCount } = await readSessionPreview(filePath)
        results.push({
          sdkSessionId,
          timestamp: st.mtimeMs,
          preview: preview || '(no preview)',
          messageCount,
        })
      } catch { /* skip unreadable */ }
    }
  }

  const seen = new Set()
  const deduped = results.filter(r => {
    if (seen.has(r.sdkSessionId)) return false
    seen.add(r.sdkSessionId)
    return true
  })
  deduped.sort((a, b) => b.timestamp - a.timestamp)
  return deduped.slice(0, SESSION_LIST_LIMIT)
}

async function readSessionPreview(filePath) {
  // Stream up to PREVIEW_LINE_LIMIT lines and stop. We only need the
  // first user message for the preview; any further reading is wasted I/O
  // on JSONL files that can be hundreds of MB.
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let preview = ''
  let messageCount = 0
  let lineCount = 0
  try {
    for await (const line of rl) {
      lineCount++
      if (lineCount > PREVIEW_LINE_LIMIT) break
      try {
        const obj = JSON.parse(line)
        messageCount++
        if (!preview && obj?.type === 'user') {
          const content = obj?.message?.content
          if (typeof content === 'string') {
            preview = content.slice(0, PREVIEW_CHARS)
          } else if (Array.isArray(content)) {
            const textBlock = content.find(b => b?.type === 'text')
            if (textBlock?.text) preview = String(textBlock.text).slice(0, PREVIEW_CHARS)
          }
        }
      } catch { /* skip malformed */ }
    }
  } finally {
    stream.destroy()
  }
  return { preview, messageCount }
}

// Exported for tests.
export { findClaudeCliPath, listSessionsFallback }

// --- claude.authStatus / claude.accountList helpers ----------------------
//
// authStatus shells out to `claude auth status`. The CLI prints JSON on
// stdout when logged in, exits non-zero with a stderr message otherwise.
// Treat both error paths as null so the renderer's auth UI can render
// the "not logged in" state without throwing.
//
// accountList reads the on-disk account index written by the
// Electron-side AccountManager. The path is taken from
// BAT_SIDECAR_DATA_DIR (set by Tauri at spawn) and falls back to a
// platform-default user-data dir. The index file contains only public
// account metadata — never credentials, which live in a separate
// safeStorage-encrypted file the sidecar deliberately does not touch.

const AUTH_STATUS_TIMEOUT_MS = 10_000
// auth login is interactive (browser-based OAuth, ~30-60s typical), so
// we give it a generous ceiling. The CLI exits as soon as the OAuth
// callback fires; if the user never completes the flow, we time out.
const AUTH_LOGIN_TIMEOUT_MS = 180_000

// Resolve the path to a `claude` CLI binary. The bundled SDK ships one
// per platform (e.g. node-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe);
// prefer that so a fresh release MSI install can authenticate without
// requiring a system claude. Falls back to whatever's on PATH.
//
// Test/fixture override: BAT_SIDECAR_CLAUDE_BIN points at any executable
// (typically a printf-and-exit shim) so tests can verify the spawn path
// without invoking the real CLI's network flow.
let _claudeCliPathCache
function resolveClaudeCliBinary() {
  if (process.env.BAT_SIDECAR_CLAUDE_BIN) return process.env.BAT_SIDECAR_CLAUDE_BIN
  if (_claudeCliPathCache !== undefined) return _claudeCliPathCache
  // Probe the SDK-bundled binding directory siblings — there's at most
  // one per install (the package matches host platform/arch via npm
  // optionalDependencies), so the first match wins.
  const tripleDirs = [
    'claude-agent-sdk-win32-x64',
    'claude-agent-sdk-win32-arm64',
    'claude-agent-sdk-darwin-x64',
    'claude-agent-sdk-darwin-arm64',
    'claude-agent-sdk-linux-x64',
    'claude-agent-sdk-linux-arm64',
  ]
  const exeName = platform() === 'win32' ? 'claude.exe' : 'claude'
  // Walk up from this server.mjs to find node_modules/@anthropic-ai/.
  // import.meta.url is a file URL; ../../node_modules/@anthropic-ai/<pkg>/
  let here
  try {
    here = fileURLToPath(import.meta.url)
  } catch {
    here = null
  }
  if (here) {
    const sidecarRoot = join(here, '..', '..')
    for (const triple of tripleDirs) {
      const candidate = join(sidecarRoot, 'node_modules', '@anthropic-ai', triple, exeName)
      try {
        accessSync(candidate, fsConstants.X_OK)
        _claudeCliPathCache = candidate
        return candidate
      } catch { /* not present, try next */ }
    }
  }
  _claudeCliPathCache = null
  return null
}

// Spawn the resolved claude CLI with the given args. Falls back to
// invoking 'claude' from PATH when no bundled binary is available.
function spawnClaudeCli(args, opts, callback) {
  const bundled = resolveClaudeCliBinary()
  const bin = bundled || 'claude'
  return execFile(bin, args, opts, callback)
}

function fetchAuthStatus() {
  return new Promise((resolve) => {
    spawnClaudeCli(['auth', 'status'], { timeout: AUTH_STATUS_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}

function resolveDataDir() {
  // 1) Honour the env var Tauri sets at spawn.
  const fromEnv = process.env.BAT_SIDECAR_DATA_DIR
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  // 2) Platform defaults — match what Electron's app.getPath('userData')
  //    resolves to so a returning user keeps their accounts.
  const home = homedir()
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return join(appData, 'BetterAgentTerminal')
  }
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'better-agent-terminal')
  }
  return join(home, '.config', 'better-agent-terminal')
}

// Return shape mirrors Electron's claude:account-list handler:
// `{accounts, activeAccountId, switchWarningShown}`. The renderer's
// SettingsPanel reads `result.accounts.length` directly, so a bare
// array would crash the panel — keep the wrapper even when empty.
async function readAccountIndex() {
  const dir = resolveDataDir()
  const path = join(dir, 'claude-accounts.json')
  let raw
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return { accounts: [], activeAccountId: null, switchWarningShown: false }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { accounts: [], activeAccountId: null, switchWarningShown: false }
  }
  const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
  // Strip to documented public shape — AccountManager may have written
  // legacy/credential fields and we never surface those.
  const sanitized = accounts.map(a => ({
    id: String(a?.id ?? ''),
    email: String(a?.email ?? ''),
    subscriptionType: a?.subscriptionType,
    isDefault: Boolean(a?.isDefault),
    createdAt: typeof a?.createdAt === 'number' ? a.createdAt : 0,
  })).filter(a => a.id && a.email)
  return {
    accounts: sanitized,
    activeAccountId: typeof parsed?.activeAccountId === 'string' ? parsed.activeAccountId : null,
    switchWarningShown: Boolean(parsed?.switchWarningShown),
  }
}

// Exported for tests.
function __resetClaudeCliCacheForTests() { _claudeCliPathCache = undefined }
export { fetchAuthStatus, resolveDataDir, readAccountIndex, resolveClaudeCliBinary, __resetClaudeCliCacheForTests }

// --- openai.listSessions helper ------------------------------------------
//
// Walks ~/.better-agent-terminal/openai-sessions/<yyyy>/<mm>/<dd>/*.jsonl
// and returns SessionSummary entries. Mirrors
// electron/openai-agent/persistence.ts's listAllSessions().

const OPENAI_SESSIONS_ROOT = join(homedir(), '.better-agent-terminal', 'openai-sessions')

async function listOpenAISessions() {
  const results = []
  let years
  try {
    years = (await readdir(OPENAI_SESSIONS_ROOT, { withFileTypes: true })).filter(e => e.isDirectory())
  } catch {
    return [] // root doesn't exist — fresh install
  }
  for (const y of years) {
    const yp = join(OPENAI_SESSIONS_ROOT, y.name)
    let months
    try { months = (await readdir(yp, { withFileTypes: true })).filter(e => e.isDirectory()) } catch { continue }
    for (const m of months) {
      const mp = join(yp, m.name)
      let days
      try { days = (await readdir(mp, { withFileTypes: true })).filter(e => e.isDirectory()) } catch { continue }
      for (const dd of days) {
        const dp = join(mp, dd.name)
        let files
        try {
          files = (await readdir(dp, { withFileTypes: true }))
            .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
        } catch { continue }
        for (const f of files) {
          const full = join(dp, f.name)
          const id = f.name.replace(/\.jsonl$/, '')
          try {
            const st = await stat(full)
            const content = await readFile(full, 'utf-8').catch(() => '')
            let preview = ''
            let count = 0
            for (const line of content.split('\n')) {
              if (!line.trim()) continue
              count++
              if (!preview) {
                try {
                  const entry = JSON.parse(line)
                  if (entry?.type === 'user' && typeof entry?.payload?.content === 'string') {
                    preview = entry.payload.content.split('\n')[0].slice(0, 120)
                  }
                } catch { /* skip */ }
              }
            }
            results.push({
              sdkSessionId: id,
              timestamp: st.mtimeMs,
              preview: preview || `(${id.slice(0, 8)}...)`,
              messageCount: count,
            })
          } catch { /* skip */ }
        }
      }
    }
  }
  results.sort((a, b) => b.timestamp - a.timestamp)
  return results
}

export { listOpenAISessions, OPENAI_SESSIONS_ROOT }

// --- claude.scanSkills helper --------------------------------------------
//
// Walks <cwd>/.claude/skills and ~/.claude/skills, picks up
// SKILL.md inside subdirs and *.md files at the top level, parses YAML
// frontmatter (name, description) and falls back to the first heading.
// Mirrors electron/openai-agent/skills-scanner.ts.

function parseSkillFrontmatter(content) {
  const out = {}
  if (!content.startsWith('---')) return out
  const end = content.indexOf('\n---', 3)
  if (end < 0) return out
  const block = content.slice(3, end).trim()
  for (const line of block.split('\n')) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.+?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

function firstHeading(content) {
  const body = content.replace(/^---[\s\S]*?\n---\n/, '')
  const line = body.split('\n').find(l => l.trim().length > 0) || ''
  return line.replace(/^#+\s*/, '').trim().slice(0, 200)
}

async function scanSkillsDir(dir, scope) {
  const out = []
  let entries
  try { entries = await readdir(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try { st = await stat(full) } catch { continue }
    if (st.isDirectory()) {
      const skillMd = join(full, 'SKILL.md')
      try {
        const content = await readFile(skillMd, 'utf-8')
        const fm = parseSkillFrontmatter(content)
        out.push({
          name: fm.name || name,
          description: fm.description || firstHeading(content),
          path: skillMd,
          scope,
        })
      } catch { /* no SKILL.md, skip */ }
    } else if (st.isFile() && name.endsWith('.md')) {
      const skillName = name.replace(/\.md$/, '')
      try {
        const content = await readFile(full, 'utf-8')
        const fm = parseSkillFrontmatter(content)
        out.push({
          name: fm.name || skillName,
          description: fm.description || firstHeading(content),
          path: full,
          scope,
        })
      } catch { /* skip */ }
    }
  }
  return out
}

async function scanSkills(cwd) {
  const projectSkills = join(cwd, '.claude', 'skills')
  const globalSkills = join(homedir(), '.claude', 'skills')
  const [a, b] = await Promise.all([
    scanSkillsDir(projectSkills, 'project'),
    scanSkillsDir(globalSkills, 'global'),
  ])
  const seen = new Set()
  const out = []
  for (const s of [...a, ...b]) {
    if (seen.has(s.name)) continue
    seen.add(s.name)
    out.push(s)
  }
  return out
}

export { scanSkills, parseSkillFrontmatter }

// --- worktree.* helpers --------------------------------------------------
//
// Port of electron/worktree-manager.ts. State is module-scoped because
// the sidecar process is one-per-app-instance and the Electron version
// uses a singleton. createWorktree / removeWorktree mutate this Map;
// rehydrate registers a worktree without creating it on disk (used to
// reattach to existing worktrees after app restart).

const WORKTREE_DIR = '.bat-worktrees'
const activeWorktrees = new Map()

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function worktreeGetGitRoot(cwd) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd })
    return stdout.trim()
  } catch { return null }
}

async function worktreeGetBranch(cwd) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    return stdout.trim()
  } catch { return 'HEAD' }
}

async function worktreeAddToGitExclude(gitRoot) {
  const excludeFile = join(gitRoot, '.git', 'info', 'exclude')
  const pattern = `/${WORKTREE_DIR}/`
  try {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(excludeFile), { recursive: true })
    let content = ''
    try { content = await readFile(excludeFile, 'utf-8') } catch { /* file missing */ }
    if (!content.includes(pattern)) {
      const sep = content.endsWith('\n') || content === '' ? '' : '\n'
      await writeFile(excludeFile, content + sep + pattern + '\n', 'utf-8')
    }
  } catch { /* best effort */ }
}

async function worktreeLinkClaudeUntracked(gitRoot, worktreePath) {
  const { mkdir, stat: statP, symlink, copyFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const claudeDir = join(gitRoot, '.claude')
  if (!existsSync(claudeDir)) return
  let untracked = []
  try {
    const { stdout } = await execFileP(
      'git', ['ls-files', '--others', '--exclude-standard', '.claude/'],
      { cwd: gitRoot, maxBuffer: 5 * 1024 * 1024 },
    )
    const items = stdout.trim().split('\n').filter(Boolean)
    const top = new Set()
    for (const item of items) {
      const rel = item.replace(/^\.claude\//, '')
      const first = rel.split('/')[0]
      if (first) top.add(first)
    }
    untracked = [...top]
  } catch { return }
  if (untracked.length === 0) return
  const wcd = join(worktreePath, '.claude')
  await mkdir(wcd, { recursive: true })
  const isWin = platform() === 'win32'
  for (const item of untracked) {
    const src = join(claudeDir, item)
    const dst = join(wcd, item)
    if (existsSync(dst)) continue
    try {
      const st = await statP(src)
      if (st.isDirectory()) {
        if (isWin) await symlink(src, dst, 'junction')
        else await symlink(src, dst)
      } else {
        if (isWin) await copyFile(src, dst)
        else await symlink(src, dst)
      }
    } catch { /* skip individual failures */ }
  }
}

async function worktreeCreate(sessionId, cwd) {
  const gitRoot = await worktreeGetGitRoot(cwd)
  if (!gitRoot) throw new Error('Not a git repository')
  const { mkdir } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')

  const shortId = sessionId.slice(0, 8)
  const worktreeBase = join(gitRoot, WORKTREE_DIR)
  const worktreePath = join(worktreeBase, shortId)
  const sourceBranch = await worktreeGetBranch(gitRoot)
  let branch = `bat/worktree-${shortId}`

  await mkdir(worktreeBase, { recursive: true })
  await worktreeAddToGitExclude(gitRoot)

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree already exists at ${worktreePath}. Use rehydrate() to reuse it.`)
  }

  // If the branch already exists, append a timestamp suffix.
  try {
    await execFileP('git', ['rev-parse', '--verify', branch], { cwd: gitRoot })
    branch = `${branch}-${Date.now().toString(36)}`
  } catch { /* branch missing — keep as-is */ }

  await execFileP('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: gitRoot })
  await worktreeLinkClaudeUntracked(gitRoot, worktreePath)

  const info = {
    sessionId,
    worktreePath,
    branchName: branch,
    gitRoot,
    originalCwd: cwd,
    sourceBranch,
    createdAt: Date.now(),
  }
  activeWorktrees.set(sessionId, info)
  return info
}

async function worktreeForceRemove(gitRoot, worktreePath, branchToDelete) {
  const { rm } = await import('node:fs/promises')
  try {
    await execFileP('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: gitRoot })
  } catch {
    try {
      await rm(worktreePath, { recursive: true, force: true })
      await execFileP('git', ['worktree', 'prune'], { cwd: gitRoot })
    } catch { /* manual cleanup may fail; continue */ }
  }
  if (branchToDelete) {
    try {
      await execFileP('git', ['branch', '-D', branchToDelete], { cwd: gitRoot })
    } catch { /* branch may not exist */ }
  }
}

async function worktreeRemove(sessionId, deleteBranch = true) {
  const info = activeWorktrees.get(sessionId)
  if (!info) return
  await worktreeForceRemove(info.gitRoot, info.worktreePath, deleteBranch ? info.branchName : undefined)
  activeWorktrees.delete(sessionId)
}

function worktreeRehydrate(sessionId, originalCwd, worktreePath, branchName) {
  const existing = activeWorktrees.get(sessionId)
  if (existing?.worktreePath === worktreePath) {
    existing.originalCwd = originalCwd
    if (branchName) existing.branchName = branchName
    return existing
  }
  // Two levels up from <gitRoot>/.bat-worktrees/<shortId> is the gitRoot.
  const gitRoot = join(worktreePath, '..', '..')
  const info = {
    sessionId,
    worktreePath,
    branchName,
    gitRoot,
    originalCwd,
    sourceBranch: '', // resolved on demand by status()
    createdAt: 0,
  }
  activeWorktrees.set(sessionId, info)
  // Async source branch lookup; non-blocking.
  worktreeGetBranch(gitRoot).then(b => { info.sourceBranch = b }).catch(() => {})
  return info
}

async function worktreeResolveSourceBranch(sessionId) {
  const info = activeWorktrees.get(sessionId)
  if (!info) return ''
  if (info.sourceBranch) return info.sourceBranch
  info.sourceBranch = await worktreeGetBranch(info.gitRoot)
  return info.sourceBranch
}

async function worktreeGetDiff(sessionId) {
  const info = activeWorktrees.get(sessionId)
  if (!info) return null
  try {
    const sourceBranch = info.sourceBranch || await worktreeResolveSourceBranch(sessionId)
    if (!sourceBranch) return null
    const { stdout } = await execFileP(
      'git', ['diff', `${sourceBranch}...${info.branchName}`],
      { cwd: info.gitRoot, maxBuffer: 10 * 1024 * 1024 },
    )
    return stdout
  } catch { return null }
}

async function worktreeStatus(sessionId) {
  const info = activeWorktrees.get(sessionId)
  if (!info) return null
  const sourceBranch = info.sourceBranch || await worktreeResolveSourceBranch(sessionId)
  const diff = await worktreeGetDiff(sessionId) || ''
  return {
    diff,
    branchName: info.branchName,
    worktreePath: info.worktreePath,
    sourceBranch,
  }
}

// Exported for tests + potential reuse.
export {
  worktreeCreate, worktreeRemove, worktreeStatus, worktreeRehydrate,
  worktreeGetGitRoot, worktreeGetBranch, activeWorktrees,
}

// --- protocol ---------------------------------------------------------------

function writeMessage(obj) {
  // Single write to keep the line atomic. Node guarantees a single
  // synchronous write to a pipe doesn't interleave with another writer in
  // this process.
  process.stdout.write(JSON.stringify(obj) + '\n')
}

// Tests can swap _emitImpl to capture events without touching stdout.
// Production callers use sendEvent which trampolines through _emitImpl.
let _emitImpl = (name, params) => {
  writeMessage({ jsonrpc: '2.0', method: `event:${name}`, params: params ?? null })
}
export function sendEvent(name, params) {
  _emitImpl(name, params ?? null)
}
// Returns a restore() function that resets to the production impl.
export function __setSendEventForTests(fn) {
  const prev = _emitImpl
  _emitImpl = fn
  return () => { _emitImpl = prev }
}
// Test-only access to the session map for fixture mutation.
export { sessions }

async function dispatch(message) {
  if (!message || typeof message !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }
  }
  const { id, method, params } = message
  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'missing method' } }
  }
  const handler = handlers.get(method)
  if (!handler) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `method not found: ${method}` } }
  }
  try {
    const result = await handler(params)
    // Notifications (no id) get no response.
    if (id === undefined || id === null) return null
    return { jsonrpc: '2.0', id, result: result ?? null }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

// --- main ------------------------------------------------------------------

function main() {
  // readline handles CR/LF differences, partial chunks, and large lines
  // without us needing to buffer-and-split manually.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    const reply = await dispatch(parsed)
    if (reply) writeMessage(reply)
  })
  rl.on('close', () => {
    // Stdin closed — Tauri parent went away. Exit cleanly so we don't
    // become a zombie if the process tree teardown is unusual on Windows.
    process.exit(0)
  })
}

// import.meta.url comparison handles both `node server.mjs` and being
// imported by tests. When imported, main() is not run and the test can
// drive `dispatch` directly via the exported handlers.
//
// Windows quirk: Tauri's resource_dir() returns paths with the `\\?\`
// (verbatim / extended-length) prefix, which breaks naive
// `file://<argv[1]>` URL construction. Compare resolved fs paths
// instead, with the verbatim prefix stripped on both sides and a
// case-insensitive match (Windows fs is case-insensitive).
function __normalizeMainPath(p) {
  if (typeof p !== 'string' || !p) return ''
  let out = p
  if (process.platform === 'win32') {
    out = out.replace(/^\\\\\?\\/, '')
    out = out.toLowerCase()
  }
  return out.replace(/\\/g, '/')
}
const isMain = (() => {
  try {
    const meta = __normalizeMainPath(fileURLToPath(import.meta.url))
    const argv = __normalizeMainPath(process.argv[1] || '')
    return Boolean(meta) && meta === argv
  } catch {
    return false
  }
})()

if (isMain) main()

// Test hook so the regression test can assert the normalization handles
// the Windows verbatim prefix without spawning a real child process.
export { __normalizeMainPath }

// Exported for tests. Keep the surface tiny: handlers map, plus the
// dispatcher used by in-process tests. Adding a new handler just means
// calling registerHandler('ns.method', fn) above.
export { handlers, dispatch }
