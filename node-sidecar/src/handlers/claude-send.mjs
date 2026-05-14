// claude.sendMessage — persistent streaming-input SDK Query when supported.
//
// Keep one LiveQuery open per session so later turns do not pay the SDK
// CLI subprocess startup cost. Some SDK/CLI builds close the generator
// after a result even in streaming-input mode; when that happens, the
// next sendMessage rebuilds with resume=<sdkSessionId>.
//
// SDKMessage→event mapping (mirror of Electron's processMessage):
//   system/init      → claude:status (full meta + sdkSessionId capture)
//   rate_limit_event → claude:rate-limit
//   stream_event     → claude:stream (text/thinking deltas) + usage tracking
//   assistant        → claude:message + claude:tool-use per block
//   user             → claude:tool-result per tool_result block
//   result/success   → claude:result + claude:turn-end
//   result/!success  → claude:error + claude:turn-end
//   stream throw     → handled by sendMessage's catch → claude:error /
//                      claude:turn-end
//
// SDK-unavailable fallback (releases without bundled node_modules)
// preserves the old stub so the renderer doesn't hang on a never-
// resolving promise.

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import { sessions, ensureSession, buildSessionMeta, saveSessionConfig } from '../lib/state.mjs'
import { loadAnthropicSdk } from '../lib/sdk-loader.mjs'
import { info as logInfo, warn as logWarn } from '../lib/logger.mjs'
import { sdkModelForClaudeSelection } from '../lib/models.mjs'
import { loadInstalledPlugins, dataUrlToContentBlock } from '../lib/plugins.mjs'
import { resolveClaudeCliBinary } from './claude-auth.mjs'
import { buildCanUseTool } from './claude-permission.mjs'
import { LiveQuery } from '../lib/live-query.mjs'
import { isCodexSession, sendCodexMessage, isCodexAgentPreset } from './codex.mjs'

let userEchoSeq = 0

function batDebugEnabled() {
  return process.env.BAT_DEBUG === '1' || process.env.BAT_DEBUG === 'true'
}

function shortSessionId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.slice(0, 8) : 'unknown'
}

function preview(value, max = 160) {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized
}

function contentLength(content) {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (typeof block?.text === 'string') return sum + block.text.length
      if (typeof block?.content === 'string') return sum + block.content.length
      if (Array.isArray(block?.content)) return sum + contentLength(block.content)
      return sum
    }, 0)
  }
  return 0
}

function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return { inputType: typeof input }
  const summary = { inputKeys: Object.keys(input) }
  if (typeof input.command === 'string') {
    summary.commandLen = input.command.length
    summary.commandPreview = preview(input.command)
  }
  if (typeof input.file_path === 'string') summary.filePath = input.file_path
  if (typeof input.path === 'string') summary.path = input.path
  return summary
}

function debugLog(label, sessionId, details = {}) {
  if (!batDebugEnabled()) return
  logInfo(`claude.debug(${shortSessionId(sessionId)}): ${label} ${JSON.stringify(details)}`)
}

function debugSdkFrame(sessionId, msg) {
  if (!batDebugEnabled()) return
  const t = msg?.type || 'unknown'
  const details = { type: t }
  if (typeof msg?.session_id === 'string') details.sdkSessionId = shortSessionId(msg.session_id)
  if (typeof msg?.parent_tool_use_id === 'string') details.parentToolUseId = msg.parent_tool_use_id
  if (t === 'system') {
    details.subtype = msg?.subtype
    details.model = msg?.model
    details.cwd = msg?.cwd
  } else if (t === 'stream_event') {
    details.eventType = msg?.event?.type
    details.textLen = typeof msg?.event?.delta?.text === 'string' ? msg.event.delta.text.length : 0
    details.thinkingLen = typeof msg?.event?.delta?.thinking === 'string' ? msg.event.delta.thinking.length : 0
  } else if (t === 'assistant') {
    const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : []
    details.blockTypes = blocks.map(b => b?.type).filter(Boolean)
    details.toolUses = blocks
      .filter(b => b?.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, ...summarizeToolInput(b.input) }))
    details.textLen = contentLength(blocks)
  } else if (t === 'user') {
    const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : []
    details.toolResults = blocks
      .filter(b => b?.type === 'tool_result')
      .map(b => ({
        id: b.tool_use_id,
        isError: b.is_error === true,
        contentLen: contentLength(b.content),
      }))
  } else if (t === 'result') {
    details.subtype = msg?.subtype
    details.stopReason = msg?.stop_reason
    details.resultLen = typeof msg?.result === 'string' ? msg.result.length : 0
  }
  logInfo(`claude.debug(${shortSessionId(sessionId)}): sdk-frame ${JSON.stringify(details)}`)
}

function userDisplayContent(params, prompt, images) {
  if (typeof params?.displayPrompt === 'string') return params.displayPrompt
  const imageCount = Array.isArray(images) ? images.length : 0
  const imageNote = imageCount > 0
    ? `\n[${imageCount} image${imageCount > 1 ? 's' : ''} attached]`
    : ''
  return `${prompt || ''}${imageNote}`.replace(/^\n/, '')
}

function emitUserEcho(params, sessionId, prompt, images) {
  if (params?.suppressUserEcho === true) return
  const content = userDisplayContent(params, prompt, images)
  const now = Date.now()
  debugLog('emit-user-echo', sessionId, {
    clientMessageId: params?.clientMessageId || null,
    contentLen: content.length,
  })
  sendEvent('claude:message', {
    sessionId,
    message: {
      id: typeof params?.clientMessageId === 'string' && params.clientMessageId
        ? params.clientMessageId
        : `user-${now}-${++userEchoSeq}`,
      sessionId,
      role: 'user',
      content: content || ' ',
      timestamp: now,
    },
  })
}

function setRuntimeStatus(s, sessionId, status, message) {
  s.runtimeStatus = status
  s.runtimeMessage = message
  s.runtimeStatusStartedAt = Date.now()
  sendEvent('claude:status', { sessionId, meta: buildSessionMeta(s) })
}

function clearRuntimeStatus(s) {
  if (!s) return
  s.runtimeStatus = null
  s.runtimeMessage = null
  s.runtimeStatusStartedAt = null
}

function currentContextTokens(s) {
  const u = s?.lastUsage
  if (!u) return 0
  return (u.input_tokens || 0)
    + (u.output_tokens || 0)
    + (u.cache_creation_input_tokens || 0)
    + (u.cache_read_input_tokens || 0)
}

function pendingApiStatusForSession(s) {
  const compactWindow = typeof s?.autoCompactWindow === 'number' ? s.autoCompactWindow : 0
  if (compactWindow > 0 && currentContextTokens(s) >= compactWindow * 0.9) {
    return {
      status: 'compacting',
      message: 'Compacting context; still waiting for Claude API response.',
    }
  }
  return {
    status: 'waiting_for_api',
    message: 'Still waiting for Claude API response.',
  }
}

function resultErrorMessage(msg) {
  for (const value of [msg?.message, msg?.error, msg?.result]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object') {
      for (const key of ['message', 'error', 'detail', 'reason']) {
        if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
      }
    }
  }
  if (Array.isArray(msg?.errors)) {
    const parts = msg.errors
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim()
        if (entry && typeof entry === 'object') {
          for (const key of ['message', 'error', 'detail', 'reason']) {
            if (typeof entry[key] === 'string' && entry[key].trim()) return entry[key].trim()
          }
        }
        return ''
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('; ')
  }
  const subtype = typeof msg?.subtype === 'string' && msg.subtype ? msg.subtype : 'unknown'
  const stopReason = typeof msg?.stop_reason === 'string' && msg.stop_reason ? ` stop_reason=${msg.stop_reason}` : ''
  return `Claude query ended without success: subtype=${subtype}${stopReason}`
}

// processMessage: dispatch a single SDKMessage to the renderer-shaped
// event(s). Pure-ish — only mutates session state (sdkSessionId, model,
// permissionMode, lastUsage) and emits via sendEvent.
function processMessage(s, sessionId, msg) {
  if (msg && typeof msg.session_id === 'string') {
    s.sdkSessionId = msg.session_id
  }
  const t = msg?.type
  if (t === 'system' && msg.subtype === 'init') {
    if (typeof msg.session_id === 'string') s.sdkSessionId = msg.session_id
    if (typeof msg.model === 'string') s.model = msg.model
    if (typeof msg.permissionMode === 'string') s.permissionMode = msg.permissionMode
    // Persist the freshly-issued sdkSessionId so ensureSession can rebuild
    // a resumable session even after stopSession / resetSession.
    saveSessionConfig(sessionId, s)
    const meta = buildSessionMeta(s)
    if (typeof msg.cwd === 'string' && meta) meta.cwd = msg.cwd
    debugLog('emit-status', sessionId, {
      sdkSessionId: shortSessionId(s.sdkSessionId),
      model: meta?.model || null,
      cwd: meta?.cwd || null,
    })
    sendEvent('claude:status', { sessionId, meta })
    return
  }
  if (t === 'rate_limit_event') {
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
      debugLog('emit-rate-limit', sessionId, {
        rateLimitType: info.rateLimitType,
        resetsAt: info.resetsAt,
      })
    }
    return
  }
  if (t === 'stream_event') {
    const ev = msg.event
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
        debugLog('emit-stream', sessionId, {
          kind: 'text',
          len: d.text.length,
          parentToolUseId: msg.parent_tool_use_id ?? null,
        })
        sendEvent('claude:stream', { sessionId, data: { text: d.text, parentToolUseId: msg.parent_tool_use_id ?? null } })
      }
      if (d?.thinking) {
        debugLog('emit-stream', sessionId, {
          kind: 'thinking',
          len: d.thinking.length,
          parentToolUseId: msg.parent_tool_use_id ?? null,
        })
        sendEvent('claude:stream', { sessionId, data: { thinking: d.thinking, parentToolUseId: msg.parent_tool_use_id ?? null } })
      }
    }
    return
  }
  if (t === 'assistant') {
    // Flatten SDK content blocks so the renderer's ClaudeMessage shape
    // (flat `thinking` field) is populated even when streaming partials
    // were not observed (e.g. SDK builds without includePartialMessages,
    // models without adaptive thinking, history reload paths). Mirrors
    // claude-history.mjs' textFromContent / thinking extraction.
    const blocks = msg.message?.content
    let flatThinking = ''
    if (Array.isArray(blocks)) {
      flatThinking = blocks
        .filter(b => b && b.type === 'thinking' && typeof b.thinking === 'string')
        .map(b => b.thinking)
        .join('\n')
        .trim()
    }
    const outboundMessage = flatThinking ? { ...msg, thinking: flatThinking } : msg
    debugLog('emit-assistant-message', sessionId, {
      blockTypes: Array.isArray(blocks) ? blocks.map(b => b?.type).filter(Boolean) : [],
      textLen: contentLength(blocks),
    })
    sendEvent('claude:message', { sessionId, message: outboundMessage })
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && block.type === 'tool_use' && typeof block.id === 'string') {
          debugLog('emit-tool-use', sessionId, {
            id: block.id,
            toolName: block.name,
            ...summarizeToolInput(block.input),
          })
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
    return
  }
  if (t === 'user') {
    const blocks = msg.message?.content
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          debugLog('emit-tool-result', sessionId, {
            id: block.tool_use_id,
            status: block.is_error ? 'error' : 'completed',
            contentLen: contentLength(block.content),
          })
          sendEvent('claude:tool-result', {
            sessionId,
            result: {
              id: block.tool_use_id,
              status: block.is_error ? 'error' : 'completed',
              result: block.content,
            },
          })
        }
      }
    }
    return
  }
  if (t === 'result') {
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
      debugLog('emit-result', sessionId, {
        subtype: msg.subtype,
        stopReason: msg.stop_reason || null,
        resultLen: typeof msg.result === 'string' ? msg.result.length : 0,
      })
      sendEvent('claude:result', { sessionId, result: msg })
      debugLog('emit-turn-end', sessionId, { reason: 'completed' })
      sendEvent('claude:turn-end', { sessionId, payload: { reason: 'completed', result: msg.result, sdkSessionId: msg.session_id } })
    } else {
      const errMsg = resultErrorMessage(msg)
      if (batDebugEnabled()) {
        logWarn(`claude.result(${shortSessionId(sessionId)}): non-success subtype=${msg?.subtype || 'unknown'} keys=${Object.keys(msg || {}).join(',')}`)
      }
      debugLog('emit-error', sessionId, {
        subtype: msg?.subtype || 'unknown',
        stopReason: msg?.stop_reason || null,
        error: errMsg,
      })
      sendEvent('claude:error', { sessionId, error: errMsg })
      debugLog('emit-turn-end', sessionId, { reason: 'error' })
      sendEvent('claude:turn-end', { sessionId, payload: { reason: 'error' } })
    }
  }
}

async function buildQueryOptions(s, sessionId, prompt) {
  const cwd = (s.options && typeof s.options === 'object' && typeof s.options.cwd === 'string') ? s.options.cwd : ''
  if (!cwd) {
    throw new Error(`claude.sendMessage(${shortSessionId(sessionId)}): session has no cwd; startSession must be called with options.cwd`)
  }
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
    // Adaptive thinking: let supported models surface reasoning blocks.
    // SDK's default already enables this for Opus 4.6+, but stating it
    // explicitly makes the contract clear and covers builds where the
    // default is off.
    thinking: { type: 'adaptive' },
  }
  if (sdkMode && sdkMode !== 'default') queryOptions.permissionMode = sdkMode
  if (s.permissionMode === 'bypassPermissions') queryOptions.allowDangerouslySkipPermissions = true
  if (s.effort) queryOptions.effort = s.effort
  if (sdkModel) queryOptions.model = sdkModel
  if (claudeCodePath) queryOptions.pathToClaudeCodeExecutable = claudeCodePath
  const installedPlugins = await loadInstalledPlugins()
  if (installedPlugins.length > 0) queryOptions.plugins = installedPlugins
  queryOptions.canUseTool = (toolName, input, opts) => buildCanUseTool(s, sessionId, toolName, input, opts)
  if (s.autoCompactWindow) {
    queryOptions.env = { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(s.autoCompactWindow) }
  }
  if (s.sdkSessionId) {
    queryOptions.resume = s.sdkSessionId
    if (typeof prompt === 'string' && (!prompt || prompt.trim() === '' || prompt.trim() === ' ')) {
      queryOptions.continue = true
    }
  }
  return queryOptions
}

// buildUserMessage: shape an SDKUserMessage from the prompt + optional
// image attachments (data URLs). Mirrors the pre-LiveQuery promptArg
// generator: a single content block array carrying images then text.
function buildUserMessage(prompt, images) {
  const text = prompt || ' '
  const imageList = Array.isArray(images) ? images : null
  if (imageList && imageList.length > 0) {
    const imageBlocks = imageList.map(dataUrlToContentBlock).filter(Boolean)
    if (imageBlocks.length > 0) {
      const contentBlocks = [
        ...imageBlocks,
        ...(prompt ? [{ type: 'text', text: prompt }] : []),
      ]
      return { type: 'user', message: { role: 'user', content: contentBlocks } }
    }
  }
  return { type: 'user', message: { role: 'user', content: text } }
}

async function ensureLiveQuery(s, sessionId, sdk, prompt) {
  if (s.liveQuery && !s.liveQuery.isClosed) return s.liveQuery
  const queryOptions = await buildQueryOptions(s, sessionId, prompt)
  s.abortController = new AbortController()
  queryOptions.abortController = s.abortController
  debugLog('live-query-create', sessionId, {
    cwd: queryOptions.cwd || null,
    resume: typeof queryOptions.resume === 'string' ? shortSessionId(queryOptions.resume) : null,
    continue: queryOptions.continue === true,
    model: queryOptions.model || null,
    permissionMode: queryOptions.permissionMode || 'default',
    hasClaudePath: typeof queryOptions.pathToClaudeCodeExecutable === 'string',
    pluginCount: Array.isArray(queryOptions.plugins) ? queryOptions.plugins.length : 0,
  })
  const live = new LiveQuery({
    sdk,
    queryOptions,
    onMessage: (msg) => {
      try {
        debugSdkFrame(sessionId, msg)
        processMessage(s, sessionId, msg)
      }
      catch (err) {
        logWarn(`processMessage threw for ${sessionId}: ${err?.message || err}`)
      }
    },
    onError: (err) => {
      logWarn(`LiveQuery stream error for ${sessionId}: ${err?.message || err}`)
    },
  })
  s.liveQuery = live
  s.currentQuery = live.generator
  debugLog('live-query-ready', sessionId, {})
  return live
}

// closeLiveQuery: shared cleanup used by the lifecycle handlers in
// claude-session.mjs (abort / reset / stop / rest / resume) and also
// invoked locally when a control method fails. Idempotent.
//
// abortController is intentionally NOT cleared — sendMessage's catch
// reads s.abortController?.signal.aborted to distinguish 'aborted' vs
// 'error' turn-end reasons after a push() rejects. ensureLiveQuery
// installs a fresh AbortController on the next rebuild.
export function closeLiveQuery(s) {
  if (!s) return
  if (s.liveQuery) {
    try { s.liveQuery.close() } catch { /* ignore */ }
  }
  s.liveQuery = null
  s.currentQuery = null
}

async function performSendMessage(params) {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.sendMessage: missing sessionId')
  }
  if (isCodexSession(sessionId)) {
    return sendCodexMessage(params)
  }
  const prompt = typeof params?.prompt === 'string' ? params.prompt : ''
  const images = Array.isArray(params?.images) ? params.images : null
  const s = ensureSession(sessionId)
  if (isCodexAgentPreset(s.agentPreset)) {
    throw new Error(`claude.sendMessage(${shortSessionId(sessionId)}): codex session not initialized; restart the Codex agent`)
  }
  const sid = shortSessionId(sessionId)
  if (s.isResting) s.isResting = false
  setRuntimeStatus(s, sessionId, 'starting', 'Preparing Claude request.')

  const sdk = await loadAnthropicSdk()
  if (!sdk || typeof sdk.query !== 'function') {
    logWarn(`claude.sendMessage: SDK unavailable, returning stub for session ${sessionId}`)
    clearRuntimeStatus(s)
    sendEvent('claude:message', { sessionId, message: { role: 'assistant', content: '(stub reply — SDK unavailable)' } })
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'completed', result: '(stub)' } })
    return { ok: true, stub: true }
  }

  const userMessage = buildUserMessage(prompt, images)
  let live
  try {
    live = await ensureLiveQuery(s, sessionId, sdk, prompt)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logWarn(`claude.sendMessage(${sid}): ensureLiveQuery failed: ${errMsg}`)
    clearRuntimeStatus(s)
    sendEvent('claude:error', { sessionId, error: errMsg })
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'error' } })
    return { ok: false, error: errMsg }
  }

  const startedAt = Date.now()
  s.streaming = true
  const pendingStatus = pendingApiStatusForSession(s)
  setRuntimeStatus(s, sessionId, pendingStatus.status, pendingStatus.message)
  logInfo(`claude.sendMessage(${sid}): start promptLen=${prompt.length} images=${Array.isArray(params?.images) ? params.images.length : 0} liveClosed=${live.isClosed}`)
  debugLog('push-user-message', sessionId, {
    promptLen: prompt.length,
    promptPreview: preview(prompt),
    images: Array.isArray(params?.images) ? params.images.length : 0,
    liveClosed: live.isClosed,
  })
  try {
    const result = await live.push(userMessage)
    // Give SDK builds that end the generator immediately after a result a
    // chance to flip LiveQuery.isClosed before the next queued send starts.
    await new Promise(resolve => setImmediate(resolve))
    const elapsedMs = Date.now() - startedAt
    if (live.isClosed && s.liveQuery === live) {
      s.liveQuery = null
      s.currentQuery = null
    }
    if (result?.subtype === 'success') {
      debugLog('push-resolved', sessionId, {
        elapsedMs,
        subtype: result.subtype,
        stopReason: result.stop_reason || null,
      })
      logInfo(`claude.sendMessage(${sid}): completed ok elapsedMs=${elapsedMs}`)
      clearRuntimeStatus(s)
      return { ok: true }
    }
    const errMsg = resultErrorMessage(result)
    logWarn(`claude.sendMessage(${sid}): completed error elapsedMs=${elapsedMs} error=${errMsg}`)
    clearRuntimeStatus(s)
    return { ok: false, error: errMsg }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const aborted = s.abortController?.signal.aborted
      || /aborted/i.test(errMsg)
    if (!aborted) {
      logWarn(`claude.sendMessage(${sid}): push failed: ${errMsg}`)
      sendEvent('claude:error', { sessionId, error: errMsg })
    } else {
      logInfo(`claude.sendMessage(${sid}): aborted`)
    }
    sendEvent('claude:turn-end', { sessionId, payload: { reason: aborted ? 'aborted' : 'error' } })
    if (live.isClosed) {
      s.liveQuery = null
      s.currentQuery = null
    }
    clearRuntimeStatus(s)
    return { ok: !aborted, error: aborted ? undefined : errMsg }
  } finally {
    s.streaming = false
  }
}

registerHandler('claude.sendMessage', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.sendMessage: missing sessionId')
  }
  const s = ensureSession(sessionId)
  const sid = shortSessionId(sessionId)
  const prompt = typeof params?.prompt === 'string' ? params.prompt : ''
  const images = Array.isArray(params?.images) ? params.images : null
  debugLog('receive-send-message', sessionId, {
    promptLen: prompt.length,
    promptPreview: preview(prompt),
    images: images ? images.length : 0,
    hasClientMessageId: typeof params?.clientMessageId === 'string' && params.clientMessageId.length > 0,
    suppressUserEcho: params?.suppressUserEcho === true,
    hasExistingQueue: Boolean(s.sendQueue),
  })
  if (!isCodexSession(sessionId)) {
    emitUserEcho(params, sessionId, prompt, images)
  }
  const wasQueued = Boolean(s.sendQueue)
  if (wasQueued) {
    logInfo(`claude.sendMessage(${sid}): queued behind active turn`)
  }
  const previous = s.sendQueue || Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    if (sessions.get(sessionId) !== s) {
      return { ok: false, error: 'session stopped' }
    }
    return performSendMessage(params)
  })
  const queued = run.finally(() => {
    if (s.sendQueue === queued) s.sendQueue = null
  })
  s.sendQueue = queued
  return queued
})

// claude.stopTask: cancel a running sub-agent / Agent tool by its
// task_id (or tool_use_id as fallback when no task mapping exists).
registerHandler('claude.stopTask', async (params) => {
  const sessionId = params?.sessionId
  const taskId = params?.taskId ?? params?.toolUseId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.stopTask: missing sessionId')
  }
  if (typeof taskId !== 'string' || !taskId) {
    throw new Error('claude.stopTask: missing taskId / toolUseId')
  }
  const s = sessions.get(sessionId)
  const query = s?.currentQuery
  if (!s || !s.streaming || !query || typeof query.stopTask !== 'function') {
    return { ok: false, error: 'no active query for session' }
  }
  try {
    await query.stopTask(taskId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})
