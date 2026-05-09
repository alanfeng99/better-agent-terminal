import type { BrowserWindow } from 'electron'
import { existsSync, promises as fs } from 'fs'
import path from 'path'
import type { ClaudeMessage, ClaudeToolCall, ClaudeSessionState } from '../src/types/claude-agent'
import type { SessionSummary } from './claude-agent-manager'
import { logger } from './logger'
import { broadcastHub } from './remote/broadcast-hub'
import { notificationCenter } from './notification-center'
import { wrapInterruptedPrompt } from './agent-prompt-utils'
import { worktreeManager } from './worktree-manager'
import type { WorktreeInfo } from './worktree-manager'
import { findCodexBinary, getCodexInstallHint } from './codex-agent/binary'
import { stringifyCodexError } from './codex-agent/errors'
import { dataUrlToTempFile } from './codex-agent/image-attachments'
import { CODEX_MODELS, DEFAULT_CODEX_MODEL, normalizeCodexEffort } from './codex-agent/models'
import { buildToolCallFromResponseItem, resultFromResponseItemOutput } from './codex-agent/response-items'
import { getCodexClass } from './codex-agent/sdk'
import { findSessionLogForThread, iterateJsonlLines, listCodexSessionSummaries, loadSessionHistoryItems, readModelFromSessionLog } from './codex-agent/session-log'
import { appendThinkingFromItem, handleItemCompleted, handleItemStarted, handleItemUpdated, type CodexStreamItemSink, type CodexStreamItemState } from './codex-agent/stream-items'
import { applyCxEnvironment } from './semantic-navigation'
import type { CodexApprovalPolicy, CodexSandboxMode, CodexSessionInstance, HistoryItem, SessionMetadata } from './codex-agent/types'

const sdkThreadIds = new Map<string, string>()
const WORKTREE_DIR_NAME = '.bat-worktrees'
type CodexClassLoader = () => Promise<unknown>
type CodexBinaryResolver = () => string | undefined
type CodexThread = { runStreamed: (input: unknown, opts?: { signal?: AbortSignal }) => Promise<{ events: AsyncIterable<Record<string, unknown>> }> }

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

export class CodexAgentManager {
  private sessions: Map<string, CodexSessionInstance> = new Map()
  private getWindows: () => BrowserWindow[]
  private getWindowsForProfile?: (profileId: string | null) => BrowserWindow[]
  private loadCodexClass: CodexClassLoader
  private resolveCodexBinary: CodexBinaryResolver

  constructor(
    getWindows: () => BrowserWindow[],
    deps: { getCodexClass?: CodexClassLoader; findCodexBinary?: CodexBinaryResolver } = {},
    getWindowsForProfile?: (profileId: string | null) => BrowserWindow[]
  ) {
    this.getWindows = getWindows
    this.getWindowsForProfile = getWindowsForProfile
    this.loadCodexClass = deps.getCodexClass || getCodexClass
    this.resolveCodexBinary = deps.findCodexBinary || findCodexBinary
  }

  private getTargetWindows(sessionId: string): BrowserWindow[] {
    const ownerProfileId = this.sessions.get(sessionId)?.ownerProfileId ?? null
    if (ownerProfileId && this.getWindowsForProfile) {
      return this.getWindowsForProfile(ownerProfileId)
    }
    return this.getWindows()
  }

  private send(channel: string, sessionId: string, ...args: unknown[]) {
    for (const win of this.getTargetWindows(sessionId)) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, sessionId, ...args)
      }
    }
    broadcastHub.broadcast(channel, sessionId, ...args)
  }

  private static readonly MSG_BUFFER_CAP = 300

  private static isStaleResumeError(err: unknown): boolean {
    const message = stringifyCodexError(err).toLowerCase()
    return message.includes('thread/resume') && message.includes('no rollout found')
  }

  private threadOptions(session: CodexSessionInstance, cwd = session.cwd): Record<string, unknown> {
    const threadOpts: Record<string, unknown> = {
      workingDirectory: cwd,
      sandboxMode: session.sandboxMode,
      approvalPolicy: session.approvalPolicy,
      modelReasoningEffort: session.effort,
      skipGitRepoCheck: true,
    }
    if (session.model) threadOpts.model = session.model
    return threadOpts
  }

  private startFreshThread(sessionId: string, session: CodexSessionInstance): boolean {
    if (!session.codexInstance) return false
    const codex = session.codexInstance as Record<string, (opts: Record<string, unknown>) => unknown>
    const thread = codex.startThread(this.threadOptions(session))
    session.thread = thread
    const threadId = (thread as Record<string, unknown>)?.id as string | undefined
    if (threadId) {
      session.threadId = threadId
      session.metadata.sdkSessionId = threadId
      sdkThreadIds.set(sessionId, threadId)
    } else {
      session.threadId = undefined
      session.metadata.sdkSessionId = undefined
      sdkThreadIds.delete(sessionId)
    }
    this.send('claude:status', sessionId, { ...session.metadata })
    return true
  }

  private rebuildThread(session: CodexSessionInstance): void {
    if (!session.codexInstance || !session.threadId) return
    const codex = session.codexInstance as Record<string, (id: string, opts: Record<string, unknown>) => unknown>
    session.thread = codex.resumeThread(session.threadId, this.threadOptions(session))
  }

  private abortRunningTurn(session: CodexSessionInstance): boolean {
    if (!session.isRunning) return false
    session.abortController.abort()
    session.abortController = new AbortController()
    session.isRunning = false
    session.state.isStreaming = false
    session.state.streamingText = ''
    session.state.streamingThinking = ''
    session.currentPrompt = undefined
    session.messageQueue = []
    return true
  }

  private async syncModelFromSessionLog(sessionId: string) {
    const session = this.sessions.get(sessionId)
    const threadId = session?.threadId
    if (!session || !threadId) return

    const model = await readModelFromSessionLog(threadId).catch(() => undefined)
    if (!model || session.metadata.model === model) return

    logger.log(`[codex:${sessionId.slice(0, 8)}] Resolved session model from log: ${model}`)
    session.model = model
    session.metadata.model = model
    this.send('claude:status', sessionId, { ...session.metadata })
  }

  private addMessage(sessionId: string, msg: ClaudeMessage) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(msg)
      if (session.state.messages.length > CodexAgentManager.MSG_BUFFER_CAP) {
        session.state.messages = session.state.messages.slice(-CodexAgentManager.MSG_BUFFER_CAP)
      }
    }
    this.send('claude:message', sessionId, msg)
  }

  private addToolCall(sessionId: string, tool: ClaudeToolCall) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(tool)
      if (session.state.messages.length > CodexAgentManager.MSG_BUFFER_CAP) {
        session.state.messages = session.state.messages.slice(-CodexAgentManager.MSG_BUFFER_CAP)
      }
    }
    this.send('claude:tool-use', sessionId, tool)
  }

  private updateToolCall(sessionId: string, toolId: string, updates: Partial<ClaudeToolCall>) {
    const session = this.sessions.get(sessionId)
    if (session) {
      const idx = session.state.messages.findIndex(
        m => 'toolName' in m && m.id === toolId
      )
      if (idx !== -1) {
        Object.assign(session.state.messages[idx], updates)
      }
    }
    this.send('claude:tool-result', sessionId, { id: toolId, ...updates })
  }

  private hasToolCall(sessionId: string, toolId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    return session.state.messages.some(m => 'toolName' in m && m.id === toolId)
  }

  /**
   * Sweep the rollout JSONL for `image_generation_call` response_items that the
   * Codex SDK doesn't surface as item.* events during streaming. Called on
   * turn.completed so generated images appear in the timeline live.
   */
  private async flushImageGenFromSessionLog(sessionId: string, turnStartedAt: number): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.threadId) return
    try {
      const sessionLogPath = await findSessionLogForThread(session.threadId)
      if (!sessionLogPath) return
      for await (const line of iterateJsonlLines(sessionLogPath)) {
        let entry: { timestamp?: string; type?: string; payload?: Record<string, unknown> }
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry.type !== 'response_item' || !entry.payload) continue
        if (entry.payload.type !== 'image_generation_call') continue
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : Date.now()
        if (Number.isFinite(ts) && ts < turnStartedAt) continue
        this.handleResponseItemToolEvent(sessionId, entry.payload, Number.isFinite(ts) ? ts : Date.now())
      }
    } catch (err) {
      logger.error(`[codex:${sessionId.slice(0, 8)}] flushImageGenFromSessionLog failed:`, err)
    }
  }

  private handleResponseItemToolEvent(sessionId: string, payload: Record<string, unknown>, timestamp: number): void {
    const payloadType = payload.type
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call' || payloadType === 'image_generation_call') {
      const toolCall = buildToolCallFromResponseItem(sessionId, payload, timestamp)
      if (!toolCall) return
      if (this.hasToolCall(sessionId, toolCall.id)) {
        this.updateToolCall(sessionId, toolCall.id, {
          input: toolCall.input,
          status: toolCall.status,
          ...(toolCall.result ? { result: toolCall.result } : {}),
        })
      } else {
        this.addToolCall(sessionId, toolCall)
      }
      return
    }

    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const callId = String(payload.call_id || payload.id || '')
      if (!callId) return
      if (!this.hasToolCall(sessionId, callId)) {
        this.addToolCall(sessionId, {
          id: callId,
          sessionId,
          toolName: 'Tool',
          input: {},
          status: 'running',
          timestamp,
        })
      }
      this.updateToolCall(sessionId, callId, resultFromResponseItemOutput(payload))
    }
  }

  private replaceHistory(sessionId: string, items: HistoryItem[]) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages = items.slice(-CodexAgentManager.MSG_BUFFER_CAP)
    }
    this.send('claude:history', sessionId, items)
  }

  private async loadSessionHistory(sessionId: string, threadId: string): Promise<void> {
    this.send('claude:resume-loading', sessionId, true)
    try {
      const { items, sessionLogPath, durationMs } = await loadSessionHistoryItems(sessionId, threadId)
      if (!sessionLogPath) {
        logger.log(`[codex:${sessionId.slice(0, 8)}] No session log found for thread ${threadId.slice(0, 8)}`)
        this.replaceHistory(sessionId, [])
        return
      }
      logger.log(`[codex:${sessionId.slice(0, 8)}] Loaded ${items.length} history items from ${sessionLogPath.split(/[\\/]/).pop()} in ${durationMs}ms`)
      this.replaceHistory(sessionId, items)
    } finally {
      this.send('claude:resume-loading', sessionId, false)
    }
  }

  private makeMetadata(): SessionMetadata {
    return {
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      numTurns: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
      contextTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      callCacheRead: 0,
      callCacheWrite: 0,
      lastQueryCalls: 0,
    }
  }

  private isManagedWorktreePath(candidate: string | undefined): candidate is string {
    if (!candidate) return false
    return path.basename(path.dirname(candidate)) === WORKTREE_DIR_NAME
  }

  private hostRootFromWorktreePath(candidate: string | undefined): string | undefined {
    if (!this.isManagedWorktreePath(candidate)) return undefined
    const hostRoot = path.resolve(candidate, '..', '..')
    return existsSync(hostRoot) ? hostRoot : undefined
  }

  async startSession(sessionId: string, options: {
    cwd: string
    prompt?: string
    permissionMode?: string
    model?: string
    effort?: string
    apiVersion?: string
    codexSandboxMode?: CodexSandboxMode
    codexApprovalPolicy?: CodexApprovalPolicy
    agentPreset?: string
    useWorktree?: boolean
    worktreePath?: string
    worktreeBranch?: string
    ownerProfileId?: string | null
    [key: string]: unknown
  }): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true

    const codexPath = this.resolveCodexBinary()
    if (!codexPath) {
      this.send('claude:error', sessionId, `Codex CLI not found. Install with: ${getCodexInstallHint()}`)
      return false
    }

    const stag = `[codex:${sessionId.slice(0, 8)}]`
    const effectiveModel = options.model || DEFAULT_CODEX_MODEL
    logger.log(`${stag} Starting session cwd=${options.cwd} model=${effectiveModel} codex=${codexPath}`)

    const sandboxMode = options.codexSandboxMode || 'workspace-write'
    const approvalPolicy = options.codexApprovalPolicy || 'on-request'
    let effectiveCwd = options.cwd
    let worktreeInfo: WorktreeInfo | undefined
    let worktreeWarning: string | undefined

    if (options.useWorktree) {
      try {
        const sourceCwd = this.isManagedWorktreePath(options.cwd)
          ? this.hostRootFromWorktreePath(options.cwd) || this.hostRootFromWorktreePath(options.worktreePath) || options.cwd
          : options.cwd
        const cwdAsWorktreePath = this.isManagedWorktreePath(options.cwd) ? options.cwd : undefined
        const preferredWorktreePath = options.worktreePath || cwdAsWorktreePath
        const expectedWorktreePath = !preferredWorktreePath && sourceCwd && existsSync(sourceCwd)
          ? path.join(sourceCwd, WORKTREE_DIR_NAME, sessionId.slice(0, 8))
          : undefined
        const existingWorktreePath = [preferredWorktreePath, cwdAsWorktreePath, expectedWorktreePath]
          .find(candidate => !!candidate && existsSync(candidate))

        if (existingWorktreePath) {
          const branchName = options.worktreeBranch
            || await worktreeManager.getBranchName(existingWorktreePath)
            || `bat/worktree-${sessionId.slice(0, 8)}`
          worktreeInfo = worktreeManager.rehydrate(
            sessionId,
            sourceCwd,
            existingWorktreePath,
            branchName
          )
          await worktreeManager.resolveSourceBranch(sessionId)
          effectiveCwd = existingWorktreePath
          logger.log(`${stag} Reusing Codex worktree at ${effectiveCwd}`)
        } else {
          const createCwd = this.hostRootFromWorktreePath(preferredWorktreePath) || sourceCwd
          worktreeInfo = await worktreeManager.createWorktree(sessionId, createCwd)
          effectiveCwd = worktreeInfo.worktreePath
          logger.log(`${stag} Created Codex worktree at ${effectiveCwd}`)
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn(`${stag} Failed to create Codex worktree, falling back to normal cwd: ${errMsg}`)
        worktreeWarning = `Failed to create worktree. Running in normal mode.\n${errMsg}`
      }
    }

    const session: CodexSessionInstance = {
      abortController: new AbortController(),
      state: { sessionId, messages: [], isStreaming: false },
      ownerProfileId: options.ownerProfileId ?? null,
      cwd: effectiveCwd,
      metadata: {
        ...this.makeMetadata(),
        model: effectiveModel,
        cwd: effectiveCwd,
      },
      ...(worktreeInfo ? { worktreeInfo, originalCwd: options.cwd } : {}),
      sandboxMode,
      approvalPolicy,
      model: effectiveModel,
      effort: normalizeCodexEffort(options.effort),
      messageQueue: [],
      startTime: Date.now(),
    }

    this.sessions.set(sessionId, session)

    // Send init message
    this.addMessage(sessionId, {
      id: `sys-init-${sessionId}`,
      sessionId,
      role: 'system',
      content: `Codex session started (sandbox: ${sandboxMode}, approval: ${approvalPolicy})${worktreeInfo ? ` [worktree: ${worktreeInfo.branchName}]` : ''}`,
      timestamp: Date.now(),
    })

    if (worktreeInfo) {
      this.addMessage(sessionId, {
        id: `sys-worktree-${sessionId}`,
        sessionId,
        role: 'system',
        content: `Running in worktree isolation: ${worktreeInfo.branchName}\nPath: ${worktreeInfo.worktreePath}`,
        timestamp: Date.now(),
      })
      this.send('claude:worktree-info', sessionId, {
        branchName: worktreeInfo.branchName,
        worktreePath: worktreeInfo.worktreePath,
        sourceBranch: worktreeInfo.sourceBranch,
        gitRoot: worktreeInfo.gitRoot,
      })
    }
    if (worktreeWarning) {
      this.addMessage(sessionId, {
        id: `sys-worktree-warn-${sessionId}`,
        sessionId,
        role: 'system',
        content: worktreeWarning,
        timestamp: Date.now(),
      })
    }

    // Create Codex instance and thread
    try {
      const Codex = await this.loadCodexClass() as new (opts: Record<string, unknown>) => unknown
      const codex = new Codex({
        codexPathOverride: codexPath,
        env: toStringEnv(applyCxEnvironment({ ...process.env })),
        config: {
          show_raw_agent_reasoning: true,
        },
      })
      session.codexInstance = codex

      const threadOpts = this.threadOptions(session, effectiveCwd)

      const savedThreadId = sdkThreadIds.get(sessionId)
      let thread: unknown
      if (savedThreadId) {
        logger.log(`${stag} Resuming thread ${savedThreadId.slice(0, 8)}`)
        thread = (codex as Record<string, (id: string, opts?: Record<string, unknown>) => unknown>).resumeThread(savedThreadId, threadOpts)
      } else {
        thread = (codex as Record<string, (opts: Record<string, unknown>) => unknown>).startThread(threadOpts)
      }
      session.thread = thread

      // Extract thread ID if available
      const threadId = (thread as Record<string, unknown>)?.id as string | undefined
      if (threadId) {
        session.threadId = threadId
        session.metadata.sdkSessionId = threadId
        sdkThreadIds.set(sessionId, threadId)
      }

      this.send('claude:status', sessionId, { ...session.metadata })

      // If a prompt was provided, send it immediately
      if (options.prompt) {
        await this.sendMessage(sessionId, options.prompt)
      }

      return true
    } catch (err) {
      logger.error(`${stag} Failed to create Codex session:`, err)
      this.send('claude:error', sessionId, `Failed to start Codex: ${err instanceof Error ? err.message : String(err)}`)
      this.sessions.delete(sessionId)
      return false
    }
  }

  async sendMessage(sessionId: string, prompt: string, images?: string[]): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.thread) return false

    const stag = `[codex:${sessionId.slice(0, 8)}]`
    const hasImages = !!images?.length
    prompt = prompt.trim()
    if (!prompt && hasImages) {
      prompt = 'Please analyze the attached image.'
    }
    if (!prompt && !hasImages) return false

    if (session.isRunning) {
      // Interrupt the running turn and proceed to start a fresh turn below.
      // We don't wait for the old turn to unwind because the Codex SDK's async
      // iterator doesn't reliably respond to AbortSignal — the for-await can
      // block forever waiting for the next event, so the old turn's finally
      // block never runs and any queued message is never drained.
      //
      // Instead we abort the old controller and replace session.abortController
      // with a fresh one below. The old turn's finally block checks
      // `session.abortController === ctrl` and will skip cleanup (including
      // queue drain) when it eventually unblocks. Its orphaned codex subprocess
      // exits on its own once its abort signal propagates.
      logger.log(`${stag} Interrupting running turn to start new message immediately`)
      const abortedPrompt = session.currentPrompt
      session.abortController.abort()
      session.messageQueue = []
      prompt = abortedPrompt ? wrapInterruptedPrompt(abortedPrompt, prompt) : prompt
      // Fall through to fresh-turn setup.
    }

    // Fresh controller for every turn so a prior abort() doesn't poison this one.
    session.abortController = new AbortController()
    session.isRunning = true
    session.currentPrompt = prompt
    session.state.isStreaming = true
    session.state.streamingText = ''
    session.state.streamingThinking = ''
    session.lastEventAt = Date.now()
    const ctrl = session.abortController

    // Add user message to UI (with note when images are attached, so remote viewers see context)
    const displayContent = prompt + (images?.length ? `\n[${images.length} image${images.length > 1 ? 's' : ''} attached]` : '')
    const userMessageId = `user-${Date.now()}`
    this.addMessage(sessionId, {
      id: userMessageId,
      sessionId,
      role: 'user',
      content: displayContent,
      timestamp: Date.now(),
    })

    // Materialise any data-URL images to temp files — the Codex SDK only accepts local image paths.
    const tempImagePaths: string[] = []
    if (images && images.length > 0) {
      for (const dataUrl of images) {
        try {
          const p = await dataUrlToTempFile(dataUrl)
          if (p) tempImagePaths.push(p)
        } catch (err) {
          logger.warn(`${stag} Failed to save pasted image to temp:`, err)
        }
      }
    }

    const turnStart = Date.now()
    session.turnStartTime = turnStart
    session.turnFirstTokenSeen = false
    const itemState: CodexStreamItemState = {
      currentAssistantText: '',
      currentThinkingText: '',
      currentThinkingByItemId: {},
      currentItemId: '',
      itemIdPrefix: `turn-${turnStart.toString(36)}`,
    }
    const itemSink: CodexStreamItemSink = {
      addMessage: msg => this.addMessage(sessionId, msg),
      addToolCall: tool => this.addToolCall(sessionId, tool),
      updateToolCall: (toolId, updates) => this.updateToolCall(sessionId, toolId, updates),
      hasToolCall: toolId => this.hasToolCall(sessionId, toolId),
      sendStream: data => {
        const liveSession = this.sessions.get(sessionId)
        if (liveSession) {
          if (data.text) liveSession.state.streamingText = (liveSession.state.streamingText || '') + data.text
          if (data.thinking) liveSession.state.streamingThinking = (liveSession.state.streamingThinking || '') + data.thinking
        }
        this.send('claude:stream', sessionId, data)
      },
      sendError: message => this.send('claude:error', sessionId, message),
    }
    let sawTurnCompleted = false
    // Codex SDK doesn't surface image_generation_call response_items as
    // item.* events; the only signal is an empty agent_message item.completed.
    // We use that as a hint to scan the rollout for the missing image.
    let suspectImageGen = false
    let idleTimedOut = false
    let retryAfterStaleResume = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const IDLE_TIMEOUT_MS = 300_000

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        logger.warn(`${stag} No events for ${IDLE_TIMEOUT_MS / 1000}s; aborting stalled turn`)
        ctrl.abort()
      }, IDLE_TIMEOUT_MS)
    }

    try {
      type CodexUserInput = { type: 'text'; text: string } | { type: 'local_image'; path: string }
      type CodexInput = string | CodexUserInput[]
      const thread = session.thread as CodexThread
      let input: CodexInput = prompt
      if (tempImagePaths.length > 0) {
        input = [
          ...tempImagePaths.map((path): CodexUserInput => ({ type: 'local_image', path })),
          ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
        ]
      }
      const { events } = await thread.runStreamed(input, { signal: ctrl.signal })

      resetIdleTimer()

      for await (const event of events) {
        if (ctrl.signal.aborted || session.abortController !== ctrl) break
        session.lastEventAt = Date.now()
        resetIdleTimer()

        const type = event.type as string
        if (logger.enabled && (type === 'item.started' || type === 'item.updated' || type === 'item.completed')) {
          const item = (event as { item?: Record<string, unknown> }).item
          const itemType = item?.type
          const keys = item ? Object.keys(item).join(',') : ''
          logger.log(`${stag} event: ${type} item.type=${itemType} keys=${keys}`)
          if (type === 'item.completed') {
            try {
              const snapshot = JSON.stringify(item, (_k, v) => typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…(+${v.length - 500})` : v)
              logger.log(`${stag} item.completed payload: ${snapshot?.slice(0, 2000)}`)
            } catch {
              logger.log(`${stag} item.completed payload: <unserializable>`)
            }
          }
        } else {
          logger.log(`${stag} event: ${type}`)
        }

        switch (type) {
          case 'response_item': {
            const payload = (event.payload || event.item || event) as Record<string, unknown> | undefined
            if (payload) {
              appendThinkingFromItem(payload, itemState, itemSink)
              this.handleResponseItemToolEvent(sessionId, payload, Date.now())
            }
            break
          }

          case 'thread.started': {
            const threadId = (event.thread_id as string | undefined) || (event.threadId as string | undefined)
            if (threadId && !session.threadId) {
              session.threadId = threadId
              session.metadata.sdkSessionId = threadId
              sdkThreadIds.set(sessionId, threadId)
              this.send('claude:status', sessionId, { ...session.metadata })
            }
            break
          }

          case 'turn.started':
            session.metadata.numTurns++
            await this.syncModelFromSessionLog(sessionId)
            break

          case 'item.started': {
            const item = event.item as Record<string, unknown>
            handleItemStarted(sessionId, item, itemState, itemSink)
            break
          }

          case 'item.updated': {
            const item = event.item as Record<string, unknown>
            const itemType = item?.type as string | undefined
            if (!session.turnFirstTokenSeen && session.turnStartTime && (itemType === 'agent_message' || itemType === 'reasoning')) {
              session.turnFirstTokenSeen = true
              session.metadata.lastTurnFirstTokenMs = Date.now() - session.turnStartTime
              this.send('claude:status', sessionId, { ...session.metadata })
            }
            handleItemUpdated(sessionId, item, itemState, itemSink)
            break
          }

          case 'item.completed': {
            const item = event.item as Record<string, unknown>
            if (item?.type === 'agent_message' && !((item.text as string) || (item.content as string) || '').trim()) {
              suspectImageGen = true
            }
            handleItemCompleted(sessionId, item, itemState, itemSink)
            break
          }

          case 'turn.completed': {
            sawTurnCompleted = true
            const usage = event.usage as { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | undefined
            if (usage) {
              session.metadata.inputTokens += usage.input_tokens || 0
              session.metadata.outputTokens += usage.output_tokens || 0
              session.metadata.cacheReadTokens += usage.cached_input_tokens || 0
              session.metadata.lastQueryCalls = 1
            }
            await this.syncModelFromSessionLog(sessionId)
            // The Codex SDK doesn't surface image_generation_call response_items
            // as item.* events during streaming. Empty agent_message item.completed
            // is the only live signal that one happened — gate the rollout sweep
            // on it so normal text turns don't pay the I/O cost.
            if (suspectImageGen) {
              await this.flushImageGenFromSessionLog(sessionId, turnStart)
            }
            session.metadata.durationMs = Date.now() - (session.startTime || turnStart)
            session.metadata.lastTurnDurationMs = Date.now() - turnStart
            this.send('claude:status', sessionId, { ...session.metadata })

            this.send('claude:result', sessionId, {
              subtype: 'result',
              totalCost: session.metadata.totalCost,
              totalTokens: session.metadata.inputTokens + session.metadata.outputTokens,
              result: itemState.currentAssistantText || undefined,
            })
            this.send('claude:turn-end', sessionId, {
              reason: 'completed',
              totalCost: session.metadata.totalCost,
              totalTokens: session.metadata.inputTokens + session.metadata.outputTokens,
              result: itemState.currentAssistantText || undefined,
            })
            notificationCenter.add({
              sessionId,
              profileId: session.ownerProfileId ?? null,
              cwd: session.cwd,
              reason: 'completed',
              result: itemState.currentAssistantText || undefined,
              agentKind: 'codex',
            })
            break
          }

          case 'turn.failed': {
            const errMsg = stringifyCodexError(event.error, 'Turn failed')
            logger.error(`${stag} Turn failed: ${errMsg}`)
            this.send('claude:error', sessionId, errMsg)
            this.send('claude:turn-end', sessionId, { reason: 'error', error: errMsg })
            break
          }

          case 'error': {
            // ThreadErrorEvent shape is { type: 'error', message: string }; older/alt payloads may nest under .error.
            const errMsg = stringifyCodexError((event as { message?: unknown }).message ?? event.error)
            logger.error(`${stag} Error: ${errMsg}`)
            this.send('claude:error', sessionId, errMsg)
            break
          }
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        if (CodexAgentManager.isStaleResumeError(err) && session.threadId) {
          logger.warn(`${stag} Stale Codex thread ${session.threadId.slice(0, 8)}; starting a fresh thread and retrying`)
          session.state.messages = session.state.messages.filter(message => message.id !== userMessageId)
          session.threadId = undefined
          session.metadata.sdkSessionId = undefined
          sdkThreadIds.delete(sessionId)
          retryAfterStaleResume = this.startFreshThread(sessionId, session)
        } else {
          logger.error(`${stag} Query error:`, err)
          this.send('claude:error', sessionId, `Codex error: ${stringifyCodexError(err)}`)
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)

      // Remove any temp image files we created for this turn; Codex has already read them.
      for (const p of tempImagePaths) {
        fs.unlink(p).catch(() => {})
      }

      // If a newer sendMessage has superseded this one, don't touch session state.
      if (session.abortController === ctrl) {
        if (!sawTurnCompleted && !retryAfterStaleResume) {
          if (idleTimedOut) {
            const msg = `Codex: no response from model after ${IDLE_TIMEOUT_MS / 1000}s. Please try again.`
            this.send('claude:error', sessionId, msg)
            this.send('claude:turn-end', sessionId, { reason: 'error', error: msg })
          } else if (!ctrl.signal.aborted) {
            logger.warn(`${stag} Turn ended without turn.completed; clearing UI state`)
            const msg = 'Codex turn ended unexpectedly.'
            this.send('claude:error', sessionId, msg)
            this.send('claude:turn-end', sessionId, { reason: 'error', error: msg })
          } else {
            this.send('claude:turn-end', sessionId, { reason: 'aborted' })
          }
        }
        session.isRunning = false
        session.state.isStreaming = false
        session.state.streamingText = ''
        session.state.streamingThinking = ''
        session.currentPrompt = undefined

        // Process queued messages
        const next = session.messageQueue.shift()
        if (next) {
          await this.sendMessage(sessionId, next.prompt, next.images)
        }
      }
    }

    if (retryAfterStaleResume) {
      return this.sendMessage(sessionId, prompt, images)
    }

    return true
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.state.isStreaming = false
    session.state.streamingText = ''
    session.state.streamingThinking = ''
    session.isRunning = false
    return true
  }

  abortSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.abortController = new AbortController()
    session.state.isStreaming = false
    session.state.streamingText = ''
    session.state.streamingThinking = ''
    session.isRunning = false
    session.currentPrompt = undefined
    session.messageQueue = []
    session.lastEventAt = undefined
    this.send('claude:result', sessionId, { subtype: 'aborted' })
    this.send('claude:turn-end', sessionId, { reason: 'aborted' })
    return true
  }

  async resetSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    session.abortController.abort()
    session.state = { sessionId, messages: [], isStreaming: false }
    session.metadata = { ...this.makeMetadata(), model: session.model, cwd: session.cwd }
    session.thread = undefined
    session.threadId = undefined
    session.isRunning = false
    sdkThreadIds.delete(sessionId)
    this.send('claude:session-reset', sessionId)

    // Create a new thread
    session.abortController = new AbortController()
    try {
      const codex = session.codexInstance as Record<string, (opts: Record<string, unknown>) => unknown>
      const threadOpts: Record<string, unknown> = {
        workingDirectory: session.cwd,
        sandboxMode: session.sandboxMode,
        approvalPolicy: session.approvalPolicy,
        modelReasoningEffort: session.effort,
        skipGitRepoCheck: true,
      }
      if (session.model) threadOpts.model = session.model
      session.thread = codex.startThread(threadOpts)
      const threadId = (session.thread as Record<string, unknown>)?.id as string | undefined
      if (threadId) {
        session.threadId = threadId
        session.metadata.sdkSessionId = threadId
        sdkThreadIds.set(sessionId, threadId)
        await this.syncModelFromSessionLog(sessionId)
      }
    } catch (err) {
      logger.error(`[codex:${sessionId.slice(0, 8)}] Reset failed:`, err)
    }
    return true
  }

  restSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.isResting = true
    session.state.isStreaming = false
    session.state.streamingText = ''
    session.state.streamingThinking = ''
    session.isRunning = false
    session.codexInstance = undefined
    session.thread = undefined
    return true
  }

  wakeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.isResting = false
    session.abortController = new AbortController()
    return true
  }

  isResting(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isResting ?? false
  }

  async resumeSession(
    sessionId: string,
    threadId: string,
    cwd: string,
    model?: string,
    codexSandboxMode?: CodexSandboxMode,
    codexApprovalPolicy?: CodexApprovalPolicy,
    useWorktree?: boolean,
    worktreePath?: string,
    worktreeBranch?: string,
    ownerProfileId?: string | null
  ): Promise<boolean> {
    sdkThreadIds.set(sessionId, threadId)
    // Signal "loading" immediately so the panel can render a skeleton while the
    // Codex instance spins up and the JSONL is parsed. loadSessionHistory()
    // emits the matching "false" once it finishes (or errors).
    this.send('claude:resume-loading', sessionId, true)
    const result = await this.startSession(sessionId, {
      cwd, model,
      ...(codexSandboxMode ? { codexSandboxMode } : {}),
      ...(codexApprovalPolicy ? { codexApprovalPolicy } : {}),
      ...(useWorktree ? { useWorktree: true, worktreePath, worktreeBranch } : {}),
      ownerProfileId,
    })
    if (result) {
      await this.loadSessionHistory(sessionId, threadId).catch(err => {
        logger.error(`[codex:${sessionId.slice(0, 8)}] Failed to load session history:`, err)
        this.replaceHistory(sessionId, [])
        this.send('claude:resume-loading', sessionId, false)
      })
    } else {
      this.send('claude:resume-loading', sessionId, false)
    }
    return result
  }

  getSessionState(sessionId: string): ClaudeSessionState | null {
    return this.sessions.get(sessionId)?.state ?? null
  }

  getSessionMeta(sessionId: string): Record<string, unknown> | null {
    const session = this.sessions.get(sessionId)
    return session ? { ...session.metadata } : null
  }

  async getSupportedModels(_sessionId: string): Promise<Array<{ value: string; displayName: string; description: string; source: string }>> {
    return CODEX_MODELS.map(m => ({ ...m, source: 'builtin' }))
  }

  setModel(sessionId: string, model: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (session.model === model) return true
    const aborted = this.abortRunningTurn(session)
    session.model = model
    session.metadata.model = model
    this.rebuildThread(session)
    this.addMessage(sessionId, {
      id: `sys-model-${Date.now()}`,
      sessionId,
      role: 'system',
      content: aborted
        ? `Codex model updated to ${model}. Previous turn aborted.`
        : `Codex model updated to ${model}.`,
      timestamp: Date.now(),
    })
    this.send('claude:status', sessionId, { ...session.metadata })
    return true
  }

  setSandboxMode(sessionId: string, sandboxMode: CodexSandboxMode): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (session.sandboxMode === sandboxMode) return true
    const aborted = this.abortRunningTurn(session)
    session.sandboxMode = sandboxMode
    this.rebuildThread(session)
    this.addMessage(sessionId, {
      id: `sys-sandbox-${Date.now()}`,
      sessionId,
      role: 'system',
      content: aborted
        ? `Codex sandbox updated to ${sandboxMode}. Previous turn aborted.`
        : `Codex sandbox updated to ${sandboxMode}.`,
      timestamp: Date.now(),
    })
    return true
  }

  setApprovalPolicy(sessionId: string, approvalPolicy: CodexApprovalPolicy): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (session.approvalPolicy === approvalPolicy) return true
    const aborted = this.abortRunningTurn(session)
    session.approvalPolicy = approvalPolicy
    this.rebuildThread(session)
    this.addMessage(sessionId, {
      id: `sys-approval-${Date.now()}`,
      sessionId,
      role: 'system',
      content: aborted
        ? `Codex approval updated to ${approvalPolicy}. Previous turn aborted.`
        : `Codex approval updated to ${approvalPolicy}.`,
      timestamp: Date.now(),
    })
    return true
  }

  setPermissionMode(_sessionId: string, _mode: string): boolean {
    return false
  }

  setEffort(sessionId: string, effort: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const next = normalizeCodexEffort(effort)
    if (session.effort === next) return true
    const aborted = this.abortRunningTurn(session)
    session.effort = next
    this.rebuildThread(session)
    this.addMessage(sessionId, {
      id: `sys-effort-${Date.now()}`,
      sessionId,
      role: 'system',
      content: aborted
        ? `Codex reasoning effort updated to ${next}. Previous turn aborted.`
        : `Codex reasoning effort updated to ${next}.`,
      timestamp: Date.now(),
    })
    return true
  }

  async stopTask(_sessionId: string, _taskId: string): Promise<boolean> {
    return false
  }

  async getAccountInfo(_sessionId: string): Promise<null> { return null }
  async getSupportedCommands(_sessionId: string): Promise<[]> { return [] }
  async getSupportedAgents(_sessionId: string): Promise<[]> { return [] }
  async getContextUsage(_sessionId: string): Promise<null> { return null }
  async forkSession(_sessionId: string): Promise<null> { return null }
  async fetchSubagentMessages(_sessionId: string, _agentToolUseId: string): Promise<[]> { return [] }
  async getWorktreeStatus(sessionId: string): Promise<{ diff: string; branchName: string; worktreePath: string; sourceBranch: string } | null> {
    return worktreeManager.getWorktreeStatus(sessionId)
  }

  async cleanupWorktree(sessionId: string, deleteBranch = true): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    try {
      await worktreeManager.removeWorktree(sessionId, deleteBranch)
      if (session) {
        session.worktreeInfo = undefined
        session.originalCwd = undefined
      }
      this.send('claude:worktree-info', sessionId, null)
      return true
    } catch (err) {
      logger.error(`[codex:${sessionId.slice(0, 8)}] Failed to cleanup worktree:`, err)
      return false
    }
  }

  resolvePermission(_sessionId: string, _toolUseId: string, _result: unknown): boolean { return false }
  resolveAskUser(_sessionId: string, _toolUseId: string, _answers: unknown): boolean { return false }

  async listSessions(_cwd: string): Promise<SessionSummary[]> {
    return listCodexSessionSummaries()
  }

  killAll(): void {
    for (const [, session] of this.sessions) {
      session.abortController.abort()
    }
    this.sessions.clear()
  }

  dispose(): void {
    this.killAll()
  }
}
