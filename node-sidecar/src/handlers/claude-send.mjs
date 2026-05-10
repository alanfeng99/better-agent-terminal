// claude.sendMessage — the big SDK-driven turn handler. Streams SDK
// messages and re-emits them as renderer-shaped events
// (claude:status, claude:message, claude:stream, claude:tool-use,
// claude:tool-result, claude:result, claude:error, claude:turn-end,
// claude:rate-limit).

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import { sessions, ensureSession, buildSessionMeta } from '../lib/state.mjs'
import { loadAnthropicSdk } from '../lib/sdk-loader.mjs'
import { warn as logWarn } from '../lib/logger.mjs'
import { sdkModelForClaudeSelection } from '../lib/models.mjs'
import { loadInstalledPlugins, dataUrlToContentBlock } from '../lib/plugins.mjs'
import { resolveClaudeCliBinary } from './claude-auth.mjs'
import { buildCanUseTool } from './claude-permission.mjs'

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
    logWarn(`claude.sendMessage: SDK unavailable, returning stub for session ${sessionId}`)
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
      } else if (t === 'rate_limit_event') {
        // SDK reports rate-limit state via a dedicated message type.
        // Mirror electron/claude-agent-manager.ts:1030 — only emit when
        // both rateLimitType and resetsAt are present (the SDK can
        // produce partial events during transient slowdowns we don't
        // want to surface as a banner). resetsAt arrives in seconds;
        // multiply to ms so the renderer's Date math just works.
        const info = msg.rate_limit_info
        if (info && typeof info.rateLimitType === 'string' && typeof info.resetsAt === 'number') {
          sendEvent('claude:rate-limit', {
            sessionId,
            info: {
              rateLimitType: info.rateLimitType,
              resetsAt: info.resetsAt * 1000,
              utilization: typeof info.utilization === 'number' ? info.utilization : null,
              isUsingOverage: info.isUsingOverage ?? false,
            },
          })
        }
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
