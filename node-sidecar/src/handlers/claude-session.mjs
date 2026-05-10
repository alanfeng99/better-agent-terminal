// claude.* session lifecycle + setters + getters.
// startSession, resumeSession, resetSession, restSession, wakeSession,
// isResting, stopSession, abortSession, setAutoContinue, getAutoContinue,
// setPermissionMode, setModel, setEffort, getSessionState, getSessionMeta,
// getContextUsage.

import { existsSync } from 'node:fs'

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import { sessions, ensureSession, buildSessionMeta } from '../lib/state.mjs'
import { expectedContextWindowForModel } from '../lib/models.mjs'
import { closeLiveQuery } from './claude-send.mjs'
import { warn as logWarn } from '../lib/logger.mjs'
import { worktreeRehydrate } from './worktree.mjs'

function applyWorktreeOptions(sessionId, session) {
  const options = session?.options
  if (!options || typeof options !== 'object') return
  if (options.useWorktree !== true) return
  if (typeof options.cwd !== 'string' || !options.cwd) return
  if (typeof options.worktreePath !== 'string' || !options.worktreePath) return
  if (!existsSync(options.worktreePath)) return
  const branchName = typeof options.worktreeBranch === 'string' && options.worktreeBranch
    ? options.worktreeBranch
    : `bat/worktree-${sessionId.slice(0, 8)}`
  const info = worktreeRehydrate(sessionId, options.cwd, options.worktreePath, branchName)
  session.options = {
    ...options,
    originalCwd: options.cwd,
    cwd: options.worktreePath,
    worktreeBranch: info.branchName,
  }
  sendEvent('claude:worktree-info', {
    sessionId,
    payload: {
      branchName: info.branchName,
      worktreePath: info.worktreePath,
      sourceBranch: info.sourceBranch,
      gitRoot: info.gitRoot,
    },
  })
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
    if (typeof s.options.codexSandboxMode === 'string') s.codexSandboxMode = s.options.codexSandboxMode
    if (typeof s.options.codexApprovalPolicy === 'string') s.codexApprovalPolicy = s.options.codexApprovalPolicy
    // startSession can also pre-populate sdkSessionId for the resume
    // path. The renderer's reload-from-history flow goes through
    // claude.resumeSession (below), but the underlying mechanism is
    // identical: stash the SDK id so the next sendMessage uses
    // `resume: <id>` and the SDK reconstructs the conversation.
    if (typeof s.options.sdkSessionId === 'string') s.sdkSessionId = s.options.sdkSessionId
    applyWorktreeOptions(sessionId, s)
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
  // Tear down any persistent SDK subprocess before swapping the record.
  // The new session's first sendMessage will rebuild a LiveQuery with
  // the freshly stashed sdkSessionId so the SDK rehydrates context.
  closeLiveQuery(existing)
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
    if (typeof s.options.codexSandboxMode === 'string') s.codexSandboxMode = s.options.codexSandboxMode
    if (typeof s.options.codexApprovalPolicy === 'string') s.codexApprovalPolicy = s.options.codexApprovalPolicy
    applyWorktreeOptions(sessionId, s)
  }
  return { ok: true, sessionId, sdkSessionId: sdkSessionIdToResume }
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
  // Resting kills the persistent SDK subprocess so the user pays no
  // CPU/tokens while paused. wake / next sendMessage will rebuild.
  closeLiveQuery(session)
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

registerHandler('claude.stopSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.stopSession: missing sessionId')
  }
  const s = sessions.get(sessionId)
  if (s?.abortController) {
    try { s.abortController.abort() } catch { /* already aborted */ }
  }
  closeLiveQuery(s)
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
    // Abort fires error → drain loop closes liveQuery, but close
    // explicitly to wake any pending push() promise straight away
    // (otherwise renderer's spinner waits for the SDK throw to
    // propagate through the iterator).
    closeLiveQuery(session)
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

registerHandler('claude.setPermissionMode', async (params) => {
  const sessionId = params?.sessionId
  const mode = params?.mode
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof mode !== 'string') return false
  const s = ensureSession(sessionId)
  s.permissionMode = mode
  // Mid-session mode change: forward to the running CLI via the SDK
  // control method when the LiveQuery is open. SDK's permissionMode
  // enum doesn't include 'bypassPlan' — that's a sidecar-only mode
  // mapped to 'plan' inside buildQueryOptions. If the control method
  // fails (older CLI builds without the streaming-input control
  // protocol), close the live query so the next sendMessage rebuilds
  // with the new mode in queryOptions.
  if (s.liveQuery && !s.liveQuery.isClosed) {
    const sdkMode = mode === 'bypassPlan' ? 'plan' : mode
    try { await s.liveQuery.setPermissionMode(sdkMode) }
    catch (err) {
      logWarn(`setPermissionMode control failed for ${sessionId}: ${err?.message || err}`)
      closeLiveQuery(s)
    }
  }
  // Mirror Electron's claude:modeChange event so listeners refresh.
  sendEvent('claude:modeChange', { sessionId, mode })
  return true
})

const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const CODEX_APPROVAL_POLICIES = new Set(['untrusted', 'on-request', 'never'])

registerHandler('claude.setCodexSandboxMode', async (params) => {
  const sessionId = params?.sessionId
  const mode = params?.mode
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof mode !== 'string' || !CODEX_SANDBOX_MODES.has(mode)) return false
  const s = sessions.get(sessionId)
  if (!s) return false
  s.codexSandboxMode = mode
  return true
})

registerHandler('claude.setCodexApprovalPolicy', async (params) => {
  const sessionId = params?.sessionId
  const policy = params?.policy
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof policy !== 'string' || !CODEX_APPROVAL_POLICIES.has(policy)) return false
  const s = sessions.get(sessionId)
  if (!s) return false
  s.codexApprovalPolicy = policy
  return true
})

registerHandler('claude.setModel', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const s = ensureSession(sessionId)
  if (typeof params?.model === 'string') s.model = params.model
  if (typeof params?.autoCompactWindow === 'number') s.autoCompactWindow = params.autoCompactWindow
  // autoCompactWindow is read by the SDK-spawned CLI from env at boot,
  // so changing it requires a rebuild — close the live query.
  // Model swap goes through the control method first; only rebuild on
  // failure.
  if (s.liveQuery && !s.liveQuery.isClosed) {
    if (typeof params?.autoCompactWindow === 'number') {
      closeLiveQuery(s)
    } else if (typeof params?.model === 'string') {
      try { await s.liveQuery.setModel(s.model) }
      catch (err) {
        logWarn(`setModel control failed for ${sessionId}: ${err?.message || err}`)
        closeLiveQuery(s)
      }
    }
  }
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
  const prior = sessions.get(sessionId)
  if (prior?.abortController) {
    try { prior.abortController.abort() } catch { /* already aborted */ }
  }
  closeLiveQuery(prior)
  // Drop the session record entirely. Next startSession recreates it.
  const existed = sessions.delete(sessionId)
  // Mirror Electron's claude:session-reset notification so renderer
  // panels can clear messages / status without polling.
  if (existed) sendEvent('claude:session-reset', { sessionId })
  return existed
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
    codexSandboxMode: s.codexSandboxMode,
    codexApprovalPolicy: s.codexApprovalPolicy,
  }
})

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
