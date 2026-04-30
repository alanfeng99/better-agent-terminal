import type { BrowserWindow } from 'electron'
import { createRequire } from 'module'
import * as fsSync from 'fs'
import * as fsPromises from 'fs/promises'
import * as pathModule from 'path'
import type { ClaudeMessage, ClaudeToolCall, ClaudeSessionState } from '../src/types/claude-agent'
import type { EffortLevel } from '../src/types'
import type { Query, PermissionMode, CanUseTool, SlashCommand, SDKSession } from '@anthropic-ai/claude-agent-sdk'
import { logger } from './logger'
import { wrapInterruptedPrompt } from './agent-prompt-utils'
import { getNodeExecutable, isElectronFallback } from './node-resolver'
import { worktreeManager } from './worktree-manager'
import type { WorktreeInfo } from './worktree-manager'
import {
  CLAUDE_BUILTIN_MODELS,
  CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS,
  autoCompactWindowForClaudeSelection,
  contextWindowForClaudeSelection,
  isClaudeModelPreset,
  normalizeClaudeModelSelection,
  sdkModelForClaudeSelection,
} from '../src/utils/claude-model-presets'

// App-level permission mode extends SDK's PermissionMode with bypassPlan
// bypassPlan = plan mode (read-only exploration) + auto-approve all tool permissions
type AppPermissionMode = PermissionMode | 'bypassPlan'
import { broadcastHub } from './remote/broadcast-hub'
import { getDataDir } from './server-core/data-dir'
import { getNotifier } from './server-core/notifier'
import { applyCxEnvironment, buildCxSystemPromptAppend } from './semantic-navigation'

function expectedContextWindowForModel(model?: string): number | undefined {
  if (!model) return undefined
  const presetContextWindow = contextWindowForClaudeSelection(model)
  if (presetContextWindow) return presetContextWindow
  return CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS.get(model)
}

function buildClaudeSdkEnv(autoCompactWindow?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (autoCompactWindow) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow)
  } else {
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  }
  return applyCxEnvironment(env)
}


// Lazy import the SDK (it's an ES module)
let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null
let listSessionsFn: typeof import('@anthropic-ai/claude-agent-sdk').listSessions | null = null
let getSessionMessagesFn: typeof import('@anthropic-ai/claude-agent-sdk').getSessionMessages | null = null
let getSubagentMessagesFn: typeof import('@anthropic-ai/claude-agent-sdk').getSubagentMessages | null = null
let listSubagentsFn: typeof import('@anthropic-ai/claude-agent-sdk').listSubagents | null = null

async function getQuery() {
  if (!queryFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    queryFn = sdk.query
    listSessionsFn = sdk.listSessions
    getSessionMessagesFn = sdk.getSessionMessages
    getSubagentMessagesFn = sdk.getSubagentMessages
    listSubagentsFn = sdk.listSubagents
  }
  return queryFn
}

// V2 SDK lazy imports
let createSessionFn: typeof import('@anthropic-ai/claude-agent-sdk').unstable_v2_createSession | null = null
let resumeSessionV2Fn: typeof import('@anthropic-ai/claude-agent-sdk').unstable_v2_resumeSession | null = null

async function getV2Api() {
  if (!createSessionFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    createSessionFn = sdk.unstable_v2_createSession
    resumeSessionV2Fn = sdk.unstable_v2_resumeSession
  }
  return { createSession: createSessionFn!, resumeSession: resumeSessionV2Fn! }
}

// Parse a data URL (data:image/png;base64,...) into a content block
function dataUrlToContentBlock(dataUrl: string): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | null {
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i)
  if (!match) return null
  const base64 = match[2]
  // Skip images > 20MB base64 to avoid API rejection
  if (base64.length > 20 * 1024 * 1024) return null
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: base64,
    },
  }
}

// On Linux, prefer the variant matching the current libc. npm may install
// both musl and glibc optionalDependencies in some setups; picking the wrong
// binary (e.g. musl on Ubuntu) crashes at exec. Detect glibc via node's
// process.report; fall back to musl-first ordering if detection fails.
function linuxArchCandidates(): string[] {
  const arch = process.arch
  let isGlibc: boolean | null = null
  try {
    const report = (process as unknown as { report?: { getReport: () => { header?: { glibcVersionRuntime?: string } } } }).report
    const header = report?.getReport()?.header
    if (header && 'glibcVersionRuntime' in header) {
      isGlibc = !!header.glibcVersionRuntime
    }
  } catch { /* ignore */ }
  if (isGlibc === true) return [`linux-${arch}`, `linux-${arch}-musl`]
  if (isGlibc === false) return [`linux-${arch}-musl`, `linux-${arch}`]
  return [`linux-${arch}`, `linux-${arch}-musl`]
}

// Resolve the Claude Code CLI binary path. Since claude-code v2.1.113 the
// package ships a native binary placed by postinstall from a per-platform
// optionalDependency. install.cjs writes it to bin/claude.exe on EVERY
// platform — the .exe suffix is literal (just a filename on Unix). The
// platform packages still hold the unsuffixed name on Unix, so search the
// main package by `claude.exe` first, then fall back to the platform-pkg
// filename for dev setups where the platform package is present.
// In packaged Electron apps, asarUnpack puts files under app.asar.unpacked
// but require.resolve returns the app.asar path — we rewrite to .unpacked.
function resolveClaudeCodePath(): string {
  const platformPkgBin = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const archKey = process.platform === 'linux'
    ? linuxArchCandidates()
    : [`${process.platform}-${process.arch}`]

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    for (const key of archKey) {
      const packagedPath = pathModule.join(
        resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@anthropic-ai',
        `claude-code-${key}`,
        platformPkgBin
      )
      if (fsSync.existsSync(packagedPath)) return packagedPath
    }
  }

  const candidates = [
    ...archKey.map(k => `@anthropic-ai/claude-code-${k}/${platformPkgBin}`),
    `@anthropic-ai/claude-code/bin/claude.exe`,
  ]
  const req = (() => {
    try { return createRequire(import.meta.url ?? __filename) }
    catch { return null }
  })()
  for (const spec of candidates) {
    let resolved = ''
    try { resolved = req ? req.resolve(spec) : require.resolve(spec) }
    catch { continue }
    if (resolved.includes('app.asar') && !resolved.includes('app.asar.unpacked')) {
      resolved = resolved.replace('app.asar', 'app.asar.unpacked')
    }
    return resolved
  }
  return ''
}

export interface SessionSummary {
  sdkSessionId: string
  timestamp: number
  preview: string
  messageCount: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  createdAt?: number
  summary?: string
}

interface SessionMetadata {
  model?: string
  sdkSessionId?: string
  cwd?: string
  totalCost: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  numTurns: number
  contextWindow: number
  autoCompactWindow?: number
  maxOutputTokens: number
  contextTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  // Per-API-call cache breakdown (from latest streaming event)
  callCacheRead: number
  callCacheWrite: number
  lastQueryCalls: number  // Number of API calls in the last query/turn
  // Per-model usage breakdown (from SDK modelUsage)
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>
  // Ephemeral cache write breakdown (aggregate, not per-model)
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
}

interface QueuedMessage {
  prompt: string
  images?: string[]
}

interface ActiveTask {
  toolUseId: string
  description: string
  summary?: string
  lastProgressTime: number
  stalled?: boolean
  lastToolName?: string
}

interface SessionInstance {
  abortController: AbortController
  state: ClaudeSessionState
  sdkSessionId?: string
  cwd: string
  metadata: SessionMetadata
  queryInstance?: Query
  pendingPermissions: Map<string, PendingRequest>
  pendingAskUser: Map<string, PendingRequest>
  permissionMode: AppPermissionMode
  effort: EffortLevel
  autoCompactWindow?: number
  model?: string
  messageQueue: QueuedMessage[]
  currentPrompt?: string  // Track the currently running prompt for abort context
  isResting?: boolean
  activeTasks: Map<string, ActiveTask>
  apiVersion: 'v1' | 'v2'
  v2Session?: SDKSession  // V2 persistent session object
  v2SessionModel?: string // Model the V2 session was created with (to detect changes)
  v2SessionAutoCompactWindow?: number
  worktreeInfo?: WorktreeInfo  // Set when running in worktree isolation
  originalCwd?: string         // Original workspace cwd before worktree redirect
  cachedContextUsage?: unknown  // Cached getContextUsage() result for after process exits
  // /auto-continue: when set, after each successful turn ends, auto-send `prompt`
  // up to `max` times. `used` resets when the user manually sends a message.
  autoContinue?: { enabled: boolean; max: number; used: number; prompt: string }
  lastResultSubtype?: string   // Subtype of the most recent result message
}

// Persists SDK session IDs across stop/restart so we can resume conversations
const sdkSessionIds = new Map<string, string>()

export class ClaudeAgentManager {
  private sessions: Map<string, SessionInstance> = new Map()
  private getWindows: () => BrowserWindow[]
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null

  constructor(getWindows: () => BrowserWindow[]) {
    this.getWindows = getWindows
    // Health check: detect stalled subagents every 45s
    this.healthCheckTimer = setInterval(() => this.checkStalledTasks(), 45_000)
  }

  private checkStalledTasks() {
    const now = Date.now()
    const STALL_THRESHOLD = 60_000 // 60s without progress
    for (const [sessionId, session] of this.sessions) {
      for (const [taskId, task] of session.activeTasks) {
        if (!task.stalled && now - task.lastProgressTime > STALL_THRESHOLD) {
          task.stalled = true
          if (task.toolUseId) {
            this.updateToolCall(sessionId, task.toolUseId, {
              description: `[stalled] ${task.summary || task.description}`,
            } as Partial<ClaudeToolCall>)
          }
        }
      }
    }
  }

  private send(channel: string, ...args: unknown[]) {
    for (const win of this.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
    broadcastHub.broadcast(channel, ...args)
  }

  /**
   * Send a macOS/Windows/Linux system notification when Agent completes.
   * Reads settings from settings.json to check if notifications are enabled.
   */
  private sendCompletionNotification(session: { cwd: string }, result?: string) {
    try {
      const notifier = getNotifier()
      if (!notifier.isSupported()) return

      // Read settings directly from file (main process doesn't have settings store)
      const settingsPath = pathModule.join(getDataDir(), 'settings.json')
      let settings: Record<string, unknown> = {}
      try {
        settings = JSON.parse(fsSync.readFileSync(settingsPath, 'utf-8'))
      } catch { /* settings file doesn't exist or is invalid */ }

      // Check if notifications are enabled (default: true)
      if (settings.notifyOnComplete === false) return

      // Check if only notify when window is not focused
      if (settings.notifyOnlyBackground !== false) {
        const focused = this.getWindows().some(w => !w.isDestroyed() && w.isFocused())
        if (focused) return
      }

      const workspaceName = pathModule.basename(session.cwd)
      const body = result
        ? result.slice(0, 100) + (result.length > 100 ? '...' : '')
        : 'Task completed'

      notifier.show({
        title: `✅ ${workspaceName}`,
        body,
        silent: settings.notifySound === false,
        onClick: () => {
          // Focus the main window when notification is clicked
          for (const win of this.getWindows()) {
            if (!win.isDestroyed()) {
              win.show()
              win.focus()
              break
            }
          }
        },
      })
    } catch (err) {
      logger.error('[notification] Failed to send:', err)
    }
  }

  private static readonly MSG_BUFFER_CAP = 300

  private addMessage(sessionId: string, msg: ClaudeMessage) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(msg)
      if (session.state.messages.length > ClaudeAgentManager.MSG_BUFFER_CAP) {
        session.state.messages = session.state.messages.slice(-ClaudeAgentManager.MSG_BUFFER_CAP)
      }
    }
    this.send('claude:message', sessionId, msg)
  }

  private addToolCall(sessionId: string, tool: ClaudeToolCall) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(tool)
      if (session.state.messages.length > ClaudeAgentManager.MSG_BUFFER_CAP) {
        session.state.messages = session.state.messages.slice(-ClaudeAgentManager.MSG_BUFFER_CAP)
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

  async startSession(sessionId: string, options: { cwd: string; prompt?: string; sdkSessionId?: string; permissionMode?: AppPermissionMode; model?: string; effort?: EffortLevel; apiVersion?: 'v1' | 'v2'; useWorktree?: boolean; worktreePath?: string; worktreeBranch?: string; autoCompactWindow?: number }): Promise<boolean> {
    // Prevent duplicate session creation
    if (this.sessions.has(sessionId)) {
      return true
    }

    try {
      // Validate cwd — must be a non-empty absolute path to prevent sessions running in wrong directory
      // Reject bare "/" to avoid running in filesystem root
      if (!options.cwd || !pathModule.isAbsolute(options.cwd) || options.cwd === '/') {
        const errMsg = `[Claude] Cannot start session: invalid cwd "${options.cwd || '(empty)'}". A valid workspace path is required.`
        logger.log(errMsg)
        throw new Error(errMsg)
      }

      // Worktree isolation: reuse existing worktree or create a new one
      let worktreeInfo: WorktreeInfo | undefined
      let effectiveCwd = options.cwd
      if (options.useWorktree) {
        // Check if a persisted worktree path exists and is still valid
        if (options.worktreePath && fsSync.existsSync(options.worktreePath)) {
          // Reuse existing worktree (e.g. after app restart)
          worktreeInfo = worktreeManager.rehydrate(sessionId, options.cwd, options.worktreePath, options.worktreeBranch || '')
          effectiveCwd = options.worktreePath
          logger.log(`[Claude] Session ${sessionId.slice(0, 8)} reusing existing worktree at ${effectiveCwd}`)
        } else {
          try {
            worktreeInfo = await worktreeManager.createWorktree(sessionId, options.cwd)
            effectiveCwd = worktreeInfo.worktreePath
            logger.log(`[Claude] Session ${sessionId.slice(0, 8)} using worktree at ${effectiveCwd}`)
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            // If worktree directory already exists (e.g. tab closed without cleanup), rehydrate it
            if (errMsg.includes('already exists')) {
              const gitRoot = await worktreeManager.getGitRoot(options.cwd)
              if (gitRoot) {
                const existingPath = pathModule.join(gitRoot, '.bat-worktrees', sessionId.slice(0, 8))
                if (fsSync.existsSync(existingPath)) {
                  worktreeInfo = worktreeManager.rehydrate(sessionId, options.cwd, existingPath, options.worktreeBranch || `bat/worktree-${sessionId.slice(0, 8)}`)
                  effectiveCwd = existingPath
                  logger.log(`[Claude] Session ${sessionId.slice(0, 8)} rehydrated existing worktree at ${effectiveCwd}`)
                }
              }
            }
            if (!worktreeInfo) {
              logger.warn(`[Claude] Failed to create worktree, falling back to normal mode: ${errMsg}`)
            }
          }
        }
      }

      const abortController = new AbortController()
      const state: ClaudeSessionState = {
        sessionId,
        messages: [],
        isStreaming: false,
      }

      // Only resume if explicitly requested (e.g. from /resume command)
      // Don't auto-resume from sdkSessionIds — each new session starts fresh
      const previousSdkSessionId = options.sdkSessionId || undefined
      if (previousSdkSessionId) {
        sdkSessionIds.set(sessionId, previousSdkSessionId)
      }
      const selectedModel = normalizeClaudeModelSelection(options.model)
      const resolvedAutoCompactWindow = autoCompactWindowForClaudeSelection(selectedModel, options.autoCompactWindow)
      const sessionAutoCompactWindow = resolvedAutoCompactWindow || undefined

      this.sessions.set(sessionId, {
        abortController,
        state,
        sdkSessionId: previousSdkSessionId,
        cwd: effectiveCwd,
        metadata: {
          model: selectedModel,
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          numTurns: 0,
          contextWindow: expectedContextWindowForModel(selectedModel) || 0,
          autoCompactWindow: sessionAutoCompactWindow,
          maxOutputTokens: 0,
          contextTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          callCacheRead: 0,
          callCacheWrite: 0,
          lastQueryCalls: 0,
        },
        pendingPermissions: new Map(),
        pendingAskUser: new Map(),
        permissionMode: options.permissionMode || 'default',
        effort: options.effort || 'high',
        autoCompactWindow: sessionAutoCompactWindow,
        model: selectedModel,
        messageQueue: [],
        activeTasks: new Map(),
        apiVersion: options.apiVersion || 'v1',
        ...(worktreeInfo ? { worktreeInfo, originalCwd: options.cwd } : {}),
      })

      // Send worktree info/warning after session is created
      if (options.useWorktree && worktreeInfo) {
        this.send('claude:message', sessionId, {
          id: `sys-worktree-${sessionId}`,
          sessionId,
          role: 'system',
          content: `🌳 Running in worktree isolation: \`${worktreeInfo.branchName}\`\nPath: ${worktreeInfo.worktreePath}`,
          timestamp: Date.now(),
        } satisfies ClaudeMessage)
        this.send('claude:worktree-info', sessionId, {
          branchName: worktreeInfo.branchName,
          worktreePath: worktreeInfo.worktreePath,
          sourceBranch: worktreeInfo.sourceBranch,
          gitRoot: worktreeInfo.gitRoot,
        })
      } else if (options.useWorktree && !worktreeInfo) {
        this.send('claude:message', sessionId, {
          id: `sys-worktree-warn-${sessionId}`,
          sessionId,
          role: 'system',
          content: '⚠️ Failed to create worktree. Running in normal mode.',
          timestamp: Date.now(),
        } satisfies ClaudeMessage)
      }

      // If no initial prompt, just set up session and wait
      if (!options.prompt) {
        const resumeNote = previousSdkSessionId ? ' (resumed)' : ''
        const worktreeNote = worktreeInfo ? ` [worktree: ${worktreeInfo.branchName}]` : ''
        this.send('claude:message', sessionId, {
          id: `sys-init-${sessionId}`,
          sessionId,
          role: 'system',
          content: `Claude Code session ready${resumeNote}${worktreeNote}. Type a message to start.`,
          timestamp: Date.now(),
        } satisfies ClaudeMessage)
        // Load history from previous session if resuming
        if (previousSdkSessionId) {
          this.loadSessionHistory(sessionId, previousSdkSessionId, options.cwd).catch(e => {
            logger.warn('Failed to load session history on auto-resume:', e)
          })
        }
        return true
      }

      await this.runQuery(sessionId, options.prompt)
      return true
    } catch (error) {
      logger.error('Failed to start Claude session:', error)
      this.send('claude:error', sessionId, String(error))
      return false
    }
  }

  async sendMessage(sessionId: string, prompt: string, images?: string[], autoCompactWindow?: number | null): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.send('claude:error', sessionId, 'Session not found')
      return false
    }
    if (isClaudeModelPreset(session.model) || autoCompactWindow !== undefined) {
      const resolvedAutoCompactWindow = autoCompactWindowForClaudeSelection(session.model, autoCompactWindow)
      session.autoCompactWindow = resolvedAutoCompactWindow || undefined
      session.metadata.autoCompactWindow = session.autoCompactWindow
    }
    // Manual user send refreshes the auto-continue budget for the new chain.
    if (session.autoContinue) session.autoContinue.used = 0
    const displayContent = prompt + (images?.length ? `\n[${images.length} image${images.length > 1 ? 's' : ''} attached]` : '')
    return this._doSendMessage(session, sessionId, prompt, images, displayContent)
  }

  /** Internal send used by both public sendMessage and auto-continue. Skips the
   *  budget reset and lets the caller customise the broadcast message. */
  private async _doSendMessage(
    session: SessionInstance, sessionId: string, prompt: string,
    images: string[] | undefined, displayContent: string,
    displayOptions?: { kind?: ClaudeMessage['kind']; autoContinue?: NonNullable<ClaudeMessage['autoContinue']> },
  ): Promise<boolean> {
    // Auto-wake resting sessions
    if (session.isResting) {
      session.isResting = false
    }

    if (session.state.isStreaming) {
      // Abort current query and immediately send the new message
      // Prepend the aborted prompt as context so Claude doesn't forget it
      const abortedPrompt = session.currentPrompt
      session.abortController.abort()
      session.pendingPermissions.clear()
      session.pendingAskUser.clear()
      session.messageQueue.length = 0
      const contextualPrompt = abortedPrompt ? wrapInterruptedPrompt(abortedPrompt, prompt) : prompt
      const queuedDisplayContent = contextualPrompt + (images?.length ? `\n[${images.length} image${images.length > 1 ? 's' : ''} attached]` : '')
      this.addMessage(sessionId, {
        id: `user-${Date.now()}`,
        sessionId,
        role: 'user',
        content: queuedDisplayContent,
        timestamp: Date.now(),
      })
      session.messageQueue.push({ prompt: contextualPrompt, images })
      return true
    }

    if (displayOptions?.kind === 'auto-continue' && displayOptions.autoContinue) {
      this.addMessage(sessionId, {
        id: `sys-auto-${Date.now()}`,
        sessionId,
        role: 'system',
        kind: 'auto-continue',
        autoContinue: displayOptions.autoContinue,
        content: displayContent,
        timestamp: Date.now(),
      })
    } else {
      // Broadcast user message so all windows (including remote host) can see it.
      // The sender's frontend already adds it locally; dedup by id prevents doubles.
      const userMsg: ClaudeMessage = {
        id: `user-${Date.now()}`,
        sessionId,
        role: 'user',
        content: displayContent,
        timestamp: Date.now(),
      }
      this.addMessage(sessionId, userMsg)
    }

    await this.runQuery(sessionId, prompt, images)
    return true
  }

  setAutoContinue(sessionId: string, opts: { enabled: boolean; max?: number; prompt?: string }): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (!opts.enabled) {
      session.autoContinue = undefined
    } else {
      session.autoContinue = {
        enabled: true,
        max: Math.max(1, Math.min(1000, opts.max ?? 3)),
        used: 0,
        prompt: opts.prompt ?? '繼續',
      }
    }
    return true
  }

  getAutoContinue(sessionId: string): { enabled: boolean; max: number; used: number; prompt: string } | null {
    return this.sessions.get(sessionId)?.autoContinue ?? null
  }

  /** Trigger auto-continue if the session is configured for it and the most
   *  recent turn ended successfully. Called from runQuery's finally block. */
  private _maybeAutoContinue(session: SessionInstance, sessionId: string): void {
    const ac = session.autoContinue
    if (!ac || !ac.enabled) return
    const subtype = session.lastResultSubtype
    const recoverableSubtype = !subtype || subtype === 'success' || subtype === 'error_max_turns'
    if (ac.used >= ac.max) {
      logger.log(`[Claude auto] skip sessionId=${sessionId} reason=max-used used=${ac.used}/${ac.max}`)
      return
    }
    if (!recoverableSubtype) {
      logger.log(`[Claude auto] skip sessionId=${sessionId} reason=result-subtype subtype=${subtype} used=${ac.used}/${ac.max}`)
      return
    }
    if (session.state.isStreaming) {
      logger.log(`[Claude auto] skip sessionId=${sessionId} reason=streaming used=${ac.used}/${ac.max}`)
      return
    }
    if (session.messageQueue.length > 0) {
      logger.log(`[Claude auto] skip sessionId=${sessionId} reason=queued queue=${session.messageQueue.length} used=${ac.used}/${ac.max}`)
      return
    }
    if (session.abortController.signal.aborted) {
      logger.log(`[Claude auto] skip sessionId=${sessionId} reason=aborted used=${ac.used}/${ac.max}`)
      return
    }
    // Defer one tick so the result/status events flush to clients first.
    setImmediate(() => {
      const s = this.sessions.get(sessionId)
      const current = s?.autoContinue
      if (!s || !current || !current.enabled) {
        logger.log(`[Claude auto] skip sessionId=${sessionId} reason=session-missing`)
        return
      }
      if (current.used >= current.max) {
        logger.log(`[Claude auto] skip sessionId=${sessionId} reason=max-used-deferred used=${current.used}/${current.max}`)
        return
      }
      if (s.state.isStreaming) {
        logger.log(`[Claude auto] skip sessionId=${sessionId} reason=streaming-deferred used=${current.used}/${current.max}`)
        return
      }
      if (s.messageQueue.length > 0) {
        logger.log(`[Claude auto] skip sessionId=${sessionId} reason=queued-deferred queue=${s.messageQueue.length} used=${current.used}/${current.max}`)
        return
      }
      if (s.abortController.signal.aborted) {
        logger.log(`[Claude auto] skip sessionId=${sessionId} reason=aborted-deferred used=${current.used}/${current.max}`)
        return
      }
      current.used++
      const displayContent = `Auto-continue ${current.used}/${current.max} · prompt: ${current.prompt}`
      logger.log(`[Claude auto] continue sessionId=${sessionId} used=${current.used}/${current.max} subtype=${subtype || 'none'}`)
      this._doSendMessage(s, sessionId, current.prompt, undefined, displayContent, {
        kind: 'auto-continue',
        autoContinue: { used: current.used, max: current.max, prompt: current.prompt },
      }).catch((error) => {
        logger.error(`[Claude auto] send failed sessionId=${sessionId}`, error)
      })
    })
  }

  private async runQuery(sessionId: string, prompt: string, images?: string[]) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    if (session.apiVersion === 'v2') {
      return this.runQueryV2(sessionId, prompt, images)
    }

    session.state.isStreaming = true
    session.abortController = new AbortController()
    session.currentPrompt = prompt
    session.lastResultSubtype = undefined

    // Collect stderr output for better error diagnostics
    let stderrOutput = ''

    // Declare resumeId outside try so it's accessible in catch for retry logic
    const resumeId = session.sdkSessionId
    const electronFallback = isElectronFallback()

    try {
      const query = await getQuery()
      const claudeCodePath = resolveClaudeCodePath()
      const nodeExecutable = getNodeExecutable()
      if (electronFallback) {
        process.env.ELECTRON_RUN_AS_NODE = '1'
        logger.log('[Claude] Using Electron binary as Node.js runtime (ELECTRON_RUN_AS_NODE=1)')
      }
      logger.log(`[Claude] runQuery: cwd=${session.cwd}, resumeId=${resumeId || 'none'}, claudeCodePath=${claudeCodePath || 'none'}, nodeExecutable=${nodeExecutable}, autoCompactWindow=${session.autoCompactWindow || 'none'}`)
      const canUseTool: CanUseTool = async (toolName, input, opts) => {
        // Check if this is an AskUserQuestion tool — always show UI
        if (toolName === 'AskUserQuestion') {
          return new Promise((resolve) => {
            session.pendingAskUser.set(opts.toolUseID, { resolve })
            this.send('claude:ask-user', sessionId, {
              toolUseId: opts.toolUseID,
              questions: (input as Record<string, unknown>).questions,
            })
          })
        }

        // In bypassPlan mode, auto-approve all tool calls except ExitPlanMode
        // ExitPlanMode requires user confirmation before switching to bypass execution
        if (session.permissionMode === 'bypassPlan') {
          if (toolName === 'ExitPlanMode') {
            return new Promise((resolve) => {
              session.pendingPermissions.set(opts.toolUseID, {
                resolve: (result: unknown) => {
                  if ((result as { behavior: string }).behavior === 'allow') {
                    // bypassPlan + Yes → bypassPermissions (user chose bypass path)
                    session.permissionMode = 'bypassPermissions'
                    this.send('claude:modeChange', sessionId, 'bypassPermissions')
                  }
                  // deny: don't change mode, stay in bypassPlan
                  resolve(result)
                }
              })
              this.send('claude:permission-request', sessionId, {
                toolUseId: opts.toolUseID,
                toolName,
                input,
                suggestions: opts.suggestions,
                decisionReason: 'Exit plan mode and switch to bypass execution?',
              })
            })
          }
          return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
        }

        // In bypassPermissions mode (e.g. after bypassPlan → ExitPlanMode approval),
        // auto-approve all tool calls without prompting
        if (session.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
        }

        // In acceptEdits mode, auto-approve file edit and read-only tools
        if (session.permissionMode === 'acceptEdits') {
          const autoApprovedTools = ['Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep']
          if (autoApprovedTools.includes(toolName)) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
          }
          // All other tools (Bash, Agent, etc.) still require user confirmation
        }

        // For all other tools, send permission request to frontend
        return new Promise((resolve) => {
          const wrappedResolve = toolName === 'ExitPlanMode'
            ? (result: unknown) => {
                if ((result as { behavior: string }).behavior === 'allow') {
                  if ((result as { dontAskAgain?: boolean }).dontAskAgain) {
                    session.permissionMode = 'acceptEdits'
                  } else {
                    session.permissionMode = 'default'
                  }
                  this.send('claude:modeChange', sessionId, session.permissionMode)
                }
                // deny: don't change mode, stay in plan
                resolve(result)
              }
            : resolve
          session.pendingPermissions.set(opts.toolUseID, { resolve: wrappedResolve })
          this.send('claude:permission-request', sessionId, {
            toolUseId: opts.toolUseID,
            toolName,
            input,
            suggestions: opts.suggestions,
            decisionReason: opts.decisionReason,
          })
        })
      }

      // Load installed plugins from ~/.claude/plugins/installed_plugins.json
      const installedPlugins: Array<{ type: 'local'; path: string }> = []
      try {
        const os = await import('os')
        const pluginsJsonPath = pathModule.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')
        const pluginsData = JSON.parse(fsSync.readFileSync(pluginsJsonPath, 'utf-8'))
        if (pluginsData.plugins) {
          for (const entries of Object.values(pluginsData.plugins)) {
            for (const entry of entries as Array<{ installPath?: string }>) {
              if (entry.installPath) {
                installedPlugins.push({ type: 'local', path: entry.installPath })
              }
            }
          }
        }
        if (installedPlugins.length > 0) {
          logger.log(`[Claude] Loaded ${installedPlugins.length} plugins: ${installedPlugins.map(p => pathModule.basename(pathModule.dirname(p.path)) + '/' + pathModule.basename(p.path)).join(', ')}`)
        }
      } catch (e) {
        // No plugins file or parse error — continue without plugins
        logger.log('[Claude] No installed plugins found or failed to parse:', e)
      }

      const currentMode = session.permissionMode
      // Map app-level bypassPlan to SDK's plan mode
      const sdkMode: PermissionMode = currentMode === 'bypassPlan' ? 'plan' : currentMode
      const sdkModel = sdkModelForClaudeSelection(session.model)
      const sdkEnv = buildClaudeSdkEnv(session.autoCompactWindow)
      const cxSystemPromptAppend = buildCxSystemPromptAppend()
      const queryOptions: Record<string, unknown> = {
        abortController: session.abortController,
        cwd: session.cwd,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(cxSystemPromptAppend ? { append: cxSystemPromptAppend } : {}),
        },
        tools: { type: 'preset', preset: 'claude_code' },
        permissionMode: sdkMode,
        ...(currentMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        includePartialMessages: true,
        promptSuggestions: true,
        settingSources: ['user', 'project', 'local'],
        effort: session.effort,
        env: sdkEnv,
        toolConfig: { askUserQuestion: { previewFormat: 'html' } },
        agentProgressSummaries: true,
        ...(sdkModel ? { model: sdkModel } : {}),
        ...(installedPlugins.length > 0 ? { plugins: installedPlugins } : {}),
        canUseTool,
        ...(claudeCodePath ? { pathToClaudeCodeExecutable: claudeCodePath } : {}),
        ...(nodeExecutable !== 'node' || electronFallback ? { executable: nodeExecutable } : {}),
        stderr: (data: string) => {
          logger.error('[Claude Code stderr]', data)
          stderrOutput += data
        },
      }

      if (resumeId) {
        queryOptions.resume = resumeId
        // Only auto-continue when there's no new user prompt
        // When the user sends a message, we want to resume context but process their new input
        if (!prompt || prompt.trim() === '' || prompt.trim() === ' ') {
          queryOptions.continue = true
        }
      }

      // Build prompt: if images are attached, construct a multi-content SDKUserMessage
      // Use a single space as fallback to prevent empty text block errors from the API
      let promptArg: unknown = prompt || ' '
      if (images && images.length > 0) {
        // Images are now passed as data URLs (data:image/...;base64,...) from the frontend
        const imageBlocks = images
          .map(dataUrl => dataUrlToContentBlock(dataUrl))
          .filter(Boolean) as Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>
        if (imageBlocks.length > 0) {
          const contentBlocks = [
            ...imageBlocks,
            ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
          ]
          const userMessage = {
            type: 'user' as const,
            message: {
              role: 'user' as const,
              content: contentBlocks,
            },
          }
          async function* singleMessage() {
            yield userMessage
          }
          promptArg = singleMessage()
        }
      }

      // Clear per-query fields so renderer can distinguish streaming vs result
      session.metadata.modelUsage = undefined
      session.metadata.cacheWrite5mTokens = undefined
      session.metadata.cacheWrite1hTokens = undefined

      const generator = query({
        prompt: promptArg as Parameters<typeof query>[0]['prompt'],
        options: queryOptions as Parameters<typeof query>[0]['options'],
      })

      // Store the query instance so we can call runtime methods
      session.queryInstance = generator

      for await (const message of generator) {
        // Check abort
        if (session.abortController.signal.aborted) break
        this.processMessage(sessionId, session, message)
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      const isAbort = errMsg === 'aborted'
        || errMsg === 'The operation was aborted'
        || errMsg.includes('aborted')
        || session?.abortController.signal.aborted
      if (!isAbort) {
        // If the persisted Claude conversation disappeared, retry without resume.
        if (resumeId && (errMsg.includes('exited with code') || errMsg.includes('No conversation found'))) {
          logger.warn('Claude query failed with resume, retrying without resume:', errMsg)
          if (stderrOutput) logger.warn('stderr:', stderrOutput)
          session.sdkSessionId = undefined
          sdkSessionIds.delete(sessionId)
          session.state.isStreaming = false
          this.addMessage(sessionId, {
            id: `sys-retry-${Date.now()}`,
            sessionId,
            role: 'system',
            content: 'Previous session could not be resumed. Starting fresh...',
            timestamp: Date.now(),
          })
          // Retry without resume
          return this.runQuery(sessionId, prompt, images)
        }
        logger.error('Claude query error:', error)
        if (stderrOutput) logger.error('stderr output:', stderrOutput)
        if (error instanceof Error && error.stack) {
          logger.error('Stack:', error.stack)
        }
        // Detect node spawn failures and provide helpful guidance
        const combined = `${errMsg}\n${stderrOutput}`
        const isNodeError = /ENOENT|spawn.*node|node.*spawn|cannot find.*node|node\.exe.*not found/i.test(combined)
          || (errMsg.includes('spawn') && getNodeExecutable() === 'node')
        const displayMsg = isNodeError
          ? `Node.js not found.\n\nThe Claude Agent SDK requires Node.js to run. Please install it:\n\n` +
            (process.platform === 'win32'
              ? `  winget install OpenJS.NodeJS.LTS\n\nor download from https://nodejs.org`
              : process.platform === 'darwin'
                ? `  brew install node\n\nor download from https://nodejs.org`
                : `  Install via your package manager or https://nodejs.org`) +
            `\n\nRestart Better Agent Terminal after installation.`
          : stderrOutput
            ? `${errMsg}\n${stderrOutput.slice(0, 500)}`
            : errMsg
        this.send('claude:error', sessionId, displayMsg)
      }
    } finally {
      // Clean up ELECTRON_RUN_AS_NODE to avoid affecting other child processes
      if (electronFallback) {
        delete process.env.ELECTRON_RUN_AS_NODE
      }
      if (session) {
        session.state.isStreaming = false
        session.currentPrompt = undefined
        session.activeTasks.clear()
        // Mark any tool calls still in 'running' state as error (e.g. subprocess crashed)
        for (const msg of session.state.messages) {
          if ('toolName' in msg && (msg as ClaudeToolCall).status === 'running') {
            const toolMsg = msg as ClaudeToolCall
            toolMsg.status = 'error'
            toolMsg.result = toolMsg.result || 'Agent terminated unexpectedly'
            this.send('claude:tool-result', sessionId, {
              id: toolMsg.id,
              status: 'error',
              result: toolMsg.result,
            })
          }
        }
        // Process queued messages
        const next = session.messageQueue.shift()
        if (next) {
          this.runQuery(sessionId, next.prompt, next.images)
        } else {
          this._maybeAutoContinue(session, sessionId)
        }
      }
    }
  }

  // Shared message processing for both V1 and V2 streams
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private processMessage(sessionId: string, session: SessionInstance, message: any) {
    // Debug: log all message types
    const msgSubtype = (message as { subtype?: string }).subtype
    if (message.type !== 'stream_event' && message.type !== 'assistant') {
      logger.log(`[claude:msg] type=${message.type} subtype=${msgSubtype || ''} parent_tool_use_id=${(message as { parent_tool_use_id?: string }).parent_tool_use_id || 'none'}`)
    }
    if (message.type === 'rate_limit_event') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rle = message as { rate_limit_info?: any }
      const info = rle.rate_limit_info
      logger.log(`[claude:rate_limit_event] ${JSON.stringify(info)}`)
      if (info?.rateLimitType && info.resetsAt) {
        this.send('claude:rate-limit', sessionId, {
          rateLimitType: info.rateLimitType as string,
          resetsAt: info.resetsAt * 1000, // convert to ms
          utilization: typeof info.utilization === 'number' ? info.utilization : null,
          isUsingOverage: info.isUsingOverage ?? false,
        })
      }
    }
    if (message.type === 'assistant') {
      const blocks = (message as { message?: { content?: unknown[] } }).message?.content
      if (Array.isArray(blocks)) {
        const toolBlocks = blocks.filter((b: unknown) => (b as { type?: string }).type === 'tool_use')
        if (toolBlocks.length > 0) {
          for (const tb of toolBlocks) {
            const t = tb as { name?: string; id?: string }
            logger.log(`[claude:tool_use] name=${t.name} id=${t.id?.slice(0, 12)} parent_tool_use_id=${(message as { parent_tool_use_id?: string }).parent_tool_use_id || 'none'}`)
          }
        }
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      const initMsg = message as { session_id: string; model?: string; cwd?: string; permissionMode?: string }
      session.sdkSessionId = initMsg.session_id
      sdkSessionIds.set(sessionId, initMsg.session_id)
      session.metadata.model = session.model || initMsg.model
      const selectedContextWindow = expectedContextWindowForModel(session.model)
      if (selectedContextWindow) {
        session.metadata.contextWindow = selectedContextWindow
      }
      session.metadata.sdkSessionId = initMsg.session_id
      session.metadata.cwd = initMsg.cwd || session.cwd
      const reportedMode = (initMsg.permissionMode === 'plan' && session.permissionMode === 'bypassPlan')
        ? session.permissionMode
        : (initMsg.permissionMode || 'default')
      logger.log(`[claude:status] EMIT sessionId=${sessionId.slice(0, 8)} sdkSessionId=${session.metadata.sdkSessionId?.slice(0, 8)} sdkMode=${initMsg.permissionMode} appMode=${session.permissionMode} reported=${reportedMode}`)
      this.send('claude:status', sessionId, {
        ...session.metadata,
        permissionMode: reportedMode,
      })
    }

    if (message.type === 'assistant') {
      const content = message.message?.content
      if (Array.isArray(content)) {
        const thinkingParts: string[] = []
        for (const block of content) {
          if ('type' in block && block.type === 'thinking' && 'thinking' in block) {
            thinkingParts.push((block as { thinking: string }).thinking)
          }
        }
        const thinkingText = thinkingParts.join('\n') || undefined

        for (const block of content) {
          if ('text' in block && block.text) {
            this.addMessage(sessionId, {
              id: message.uuid || `asst-${Date.now()}`,
              sessionId,
              role: 'assistant',
              content: block.text,
              thinking: thinkingText,
              parentToolUseId: message.parent_tool_use_id,
              timestamp: Date.now(),
            })
            if (message.parent_tool_use_id) {
              const parentTask = Array.from(session.activeTasks.values())
                .find(t => t.toolUseId === message.parent_tool_use_id)
              if (parentTask) {
                parentTask.lastProgressTime = Date.now()
                parentTask.stalled = false
              }
            }
          }
          if ('type' in block && block.type === 'tool_use') {
            const toolBlock = block as { id: string; name: string; input: Record<string, unknown> }
            this.addToolCall(sessionId, {
              id: toolBlock.id,
              sessionId,
              toolName: toolBlock.name,
              input: toolBlock.input || {},
              status: 'running',
              parentToolUseId: message.parent_tool_use_id,
              timestamp: Date.now(),
            })
            if (message.parent_tool_use_id) {
              const parentTask = Array.from(session.activeTasks.values())
                .find(t => t.toolUseId === message.parent_tool_use_id)
              if (parentTask) {
                parentTask.lastProgressTime = Date.now()
                parentTask.stalled = false
                const toolLabel = toolBlock.name === 'Bash'
                  ? `Bash: ${((toolBlock.input as Record<string, unknown>)?.command as string)?.slice(0, 40) || '...'}`
                  : toolBlock.name === 'Read' || toolBlock.name === 'Write' || toolBlock.name === 'Edit'
                    ? `${toolBlock.name}: ${((toolBlock.input as Record<string, unknown>)?.file_path as string)?.split('/').pop() || '...'}`
                    : toolBlock.name === 'Grep'
                      ? `Grep: ${((toolBlock.input as Record<string, unknown>)?.pattern as string)?.slice(0, 30) || '...'}`
                      : toolBlock.name === 'Glob'
                        ? `Glob: ${((toolBlock.input as Record<string, unknown>)?.pattern as string)?.slice(0, 30) || '...'}`
                        : toolBlock.name
                parentTask.summary = toolLabel
                this.updateToolCall(sessionId, parentTask.toolUseId, {
                  description: toolLabel,
                } as Partial<ClaudeToolCall>)
              }
            }
            if ((toolBlock.name === 'Agent' || toolBlock.name === 'Task') && !message.parent_tool_use_id) {
              const desc = (toolBlock.input as { description?: string }).description || toolBlock.name
              session.activeTasks.set(toolBlock.id, {
                toolUseId: toolBlock.id,
                description: desc,
                lastProgressTime: Date.now(),
              })
              logger.log(`[activeTasks] Registered ${toolBlock.name} tool_use_id=${toolBlock.id.slice(0, 12)} desc=${desc.slice(0, 60)}`)
            }
            if (toolBlock.name === 'EnterPlanMode') {
              if (session.permissionMode !== 'bypassPlan') {
                session.permissionMode = 'plan'
              }
              this.send('claude:modeChange', sessionId, session.permissionMode)
            }
          }
          if ('type' in block && block.type === 'tool_result') {
            const resultBlock = block as { tool_use_id: string; content?: string; is_error?: boolean }
            const resultContent = typeof resultBlock.content === 'string'
              ? resultBlock.content
              : JSON.stringify(resultBlock.content)
            const activeTask = Array.from(session.activeTasks.entries()).find(([, t]) => t.toolUseId === resultBlock.tool_use_id)
            if (activeTask && resultContent) {
              logger.log(`[activeTasks] Completed ${resultBlock.tool_use_id.slice(0, 12)} is_error=${resultBlock.is_error}`)
              session.activeTasks.delete(activeTask[0])
            }
            const hasActiveTask = session.activeTasks.has(resultBlock.tool_use_id)
            this.updateToolCall(sessionId, resultBlock.tool_use_id, {
              status: hasActiveTask ? 'running' : (resultBlock.is_error ? 'error' : 'completed'),
              result: resultContent,
            })
          }
        }
      }
    }

    if (message.type === 'user') {
      const content = message.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if ('type' in block && block.type === 'tool_result') {
            const resultBlock = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
            const resultStr = typeof resultBlock.content === 'string'
              ? resultBlock.content
              : JSON.stringify(resultBlock.content)
            const activeTask = Array.from(session.activeTasks.entries()).find(([, t]) => t.toolUseId === resultBlock.tool_use_id)
            if (activeTask && resultStr) {
              logger.log(`[activeTasks] Completed (user msg) ${resultBlock.tool_use_id.slice(0, 12)} is_error=${resultBlock.is_error}`)
              session.activeTasks.delete(activeTask[0])
            }
            const hasActiveTask = session.activeTasks.has(resultBlock.tool_use_id)
            this.updateToolCall(sessionId, resultBlock.tool_use_id, {
              status: hasActiveTask ? 'running' : (resultBlock.is_error ? 'error' : 'completed'),
              result: resultStr,
            })
          }
        }
      }
    }

    if (message.type === 'stream_event') {
      const event = message.event as {
        type?: string
        delta?: { text?: string; thinking?: string }
        content_block?: { type?: string; id?: string; name?: string; input?: string }
        usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number }
        message?: { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } }
      }
      const eventUsage = event.usage || event.message?.usage
      if (eventUsage && (event.type === 'message_delta' || event.type === 'message_start') && !message.parent_tool_use_id) {
        const contextTokens = (eventUsage.input_tokens || 0)
          + (eventUsage.cache_creation_input_tokens || 0)
          + (eventUsage.cache_read_input_tokens || 0)
        // Update current context size (latest API call's input = actual context window usage)
        if (contextTokens > 0) {
          session.metadata.contextTokens = contextTokens
          session.metadata.callCacheRead = eventUsage.cache_read_input_tokens || 0
          session.metadata.callCacheWrite = eventUsage.cache_creation_input_tokens || 0
        }
        if (contextTokens > session.metadata.inputTokens) {
          session.metadata.inputTokens = contextTokens
          session.metadata.cacheReadTokens = eventUsage.cache_read_input_tokens || 0
          session.metadata.cacheCreationTokens = eventUsage.cache_creation_input_tokens || 0
        }
        if (eventUsage.output_tokens && eventUsage.output_tokens > session.metadata.outputTokens) {
          session.metadata.outputTokens = eventUsage.output_tokens
        }
        this.send('claude:status', sessionId, { ...session.metadata })
      }
      if (event.type === 'content_block_delta') {
        if (event.delta?.text) {
          this.send('claude:stream', sessionId, {
            text: event.delta.text,
            parentToolUseId: message.parent_tool_use_id,
          })
        }
        if (event.delta?.thinking) {
          this.send('claude:stream', sessionId, {
            thinking: event.delta.thinking,
            parentToolUseId: message.parent_tool_use_id,
          })
        }
        if (message.parent_tool_use_id && (event.delta?.text || event.delta?.thinking)) {
          const parentTask = Array.from(session.activeTasks.values())
            .find(t => t.toolUseId === message.parent_tool_use_id)
          if (parentTask) {
            parentTask.lastProgressTime = Date.now()
            parentTask.stalled = false
          }
        }
      }
    }

    if (message.type === 'compact') {
      const compactMsg = message as { displayText?: string }
      const rawText = compactMsg.displayText || 'Context compacted'
      const cleanText = rawText.replace(/\x1b\[[0-9;]*m/g, '')
      this.addMessage(sessionId, {
        id: `sys-compact-${Date.now()}`,
        sessionId,
        role: 'system',
        content: cleanText,
        timestamp: Date.now(),
      })
    }

    if (message.type === 'prompt_suggestion') {
      const suggestion = (message as { suggestion?: string }).suggestion
      if (suggestion) {
        this.send('claude:prompt-suggestion', sessionId, suggestion)
      }
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
      const retry = message as { attempt?: number; maxAttempts?: number; delay?: number; status?: number; error?: string }
      logger.warn(`[api_retry] session=${sessionId.slice(0, 8)} raw=`, JSON.stringify(message))
      const parts = [`API retrying`]
      if (retry.attempt) parts.push(`(attempt ${retry.attempt}${retry.maxAttempts ? `/${retry.maxAttempts}` : ''})`)
      if (retry.delay) parts.push(`${retry.delay}ms`)
      if (retry.status) parts.push(`HTTP ${retry.status}`)
      if (retry.error) parts.push(`- ${retry.error}`)
      logger.warn(`[api_retry] ${parts.join(' ')}`)
      this.addMessage(sessionId, {
        id: `sys-retry-${Date.now()}`,
        sessionId,
        role: 'system',
        content: parts.join(' '),
        timestamp: Date.now(),
      })
    }

    if (message.type === 'system') {
      const subtype = (message as { subtype?: string }).subtype
      logger.log(`[claude:system] subtype=${subtype} keys=${Object.keys(message).join(',')}`)
      if (subtype === 'status') {
        const statusMsg = message as { status?: string | null; compact_result?: 'success' | 'failed'; compact_error?: string }
        if (statusMsg.status === 'compacting') {
          logger.log(`[claude:compact] status=compacting session=${sessionId.slice(0, 8)}`)
        }
        if (statusMsg.compact_result === 'failed') {
          const reason = statusMsg.compact_error ? `: ${statusMsg.compact_error}` : ''
          logger.warn(`[claude:compact] failed${reason}`)
          this.addMessage(sessionId, {
            id: `sys-compact-failed-${Date.now()}`,
            sessionId,
            role: 'system',
            content: `Context compaction failed${reason}`,
            timestamp: Date.now(),
          })
        }
      }
      if (subtype === 'compact_boundary') {
        const compactMsg = message as {
          compact_metadata?: { trigger?: 'manual' | 'auto'; pre_tokens?: number; post_tokens?: number; duration_ms?: number }
          compactMetadata?: { trigger?: 'manual' | 'auto'; preTokens?: number; postTokens?: number; durationMs?: number }
        }
        const metadata = compactMsg.compact_metadata || compactMsg.compactMetadata
        const trigger = metadata?.trigger || 'auto'
        const preTokens = 'pre_tokens' in (metadata || {}) ? compactMsg.compact_metadata?.pre_tokens : compactMsg.compactMetadata?.preTokens
        const postTokens = 'post_tokens' in (metadata || {}) ? compactMsg.compact_metadata?.post_tokens : compactMsg.compactMetadata?.postTokens
        const durationMs = 'duration_ms' in (metadata || {}) ? compactMsg.compact_metadata?.duration_ms : compactMsg.compactMetadata?.durationMs
        const tokenText = typeof preTokens === 'number'
          ? ` from ${preTokens.toLocaleString()}${typeof postTokens === 'number' ? ` to ${postTokens.toLocaleString()}` : ''} tokens`
          : ''
        const durationText = typeof durationMs === 'number' ? ` in ${durationMs}ms` : ''
        logger.log(`[claude:compact] boundary trigger=${trigger}, pre=${preTokens ?? 'unknown'}, post=${postTokens ?? 'unknown'}, durationMs=${durationMs ?? 'unknown'}`)
        this.addMessage(sessionId, {
          id: `sys-compact-boundary-${Date.now()}`,
          sessionId,
          role: 'system',
          content: `Context compacted (${trigger})${tokenText}${durationText}.`,
          timestamp: Date.now(),
        })
      }
      if (subtype === 'task_updated') {
        const updMsg = message as {
          task_id: string
          patch: {
            status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
            description?: string
            end_time?: number
            error?: string
            is_backgrounded?: boolean
          }
        }
        logger.log(`[task_updated] task_id=${updMsg.task_id} patch=${JSON.stringify(updMsg.patch)}`)
        const task = session.activeTasks.get(updMsg.task_id)
        if (task) {
          task.lastProgressTime = Date.now()
          task.stalled = false
          if (updMsg.patch.description) {
            task.summary = updMsg.patch.description
          }
          const terminalStatuses = ['completed', 'failed', 'killed']
          if (updMsg.patch.status && terminalStatuses.includes(updMsg.patch.status)) {
            // Task finished — update tool call and remove from active tasks
            if (task.toolUseId) {
              const statusLabel = updMsg.patch.status
              const desc = updMsg.patch.error
                ? `[${statusLabel}] ${updMsg.patch.error}`
                : `[${statusLabel}] ${task.summary || task.description}`
              this.updateToolCall(sessionId, task.toolUseId, {
                status: updMsg.patch.status === 'completed' ? 'completed' : 'error',
                description: desc,
              } as Partial<ClaudeToolCall>)
            }
            session.activeTasks.delete(updMsg.task_id)
          } else if (task.toolUseId) {
            // Task still running — update description
            const desc = updMsg.patch.description || task.summary || task.description
            this.updateToolCall(sessionId, task.toolUseId, {
              description: desc,
            } as Partial<ClaudeToolCall>)
          }
        } else if (updMsg.patch.status === 'running') {
          // Task we haven't seen before (race: task_updated arrived before tool_use block)
          // Register it so we can track it
          logger.log(`[task_updated] New task registered via task_updated: ${updMsg.task_id}`)
          session.activeTasks.set(updMsg.task_id, {
            toolUseId: '',
            description: updMsg.patch.description || '',
            lastProgressTime: Date.now(),
          })
        }
      }
      if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_notification') {
        const agentMsg = message as {
          subtype: string
          task_id?: string
          tool_use_id?: string
          description?: string
          summary?: string
          status?: string
          usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
          last_tool_name?: string
        }
        logger.log(`[agent-progress] ${subtype} task_id=${agentMsg.task_id} tool_use_id=${agentMsg.tool_use_id} desc=${agentMsg.description?.slice(0, 60)} status=${agentMsg.status}`)
        if (subtype === 'task_started' && agentMsg.task_id) {
          session.activeTasks.set(agentMsg.task_id, {
            toolUseId: agentMsg.tool_use_id || '',
            description: agentMsg.description || '',
            lastProgressTime: Date.now(),
          })
          if (agentMsg.tool_use_id) {
            this.updateToolCall(sessionId, agentMsg.tool_use_id, {
              description: agentMsg.description,
            } as Partial<ClaudeToolCall>)
          }
        } else if (subtype === 'task_progress' && agentMsg.task_id) {
          const task = session.activeTasks.get(agentMsg.task_id)
          if (task) {
            task.lastProgressTime = Date.now()
            task.summary = agentMsg.description || agentMsg.summary
            task.stalled = false
            if (agentMsg.last_tool_name) {
              task.lastToolName = agentMsg.last_tool_name
            }
            if (task.toolUseId) {
              const desc = agentMsg.description || task.description
              const toolSuffix = task.lastToolName ? ` [${task.lastToolName}]` : ''
              this.updateToolCall(sessionId, task.toolUseId, {
                description: desc + toolSuffix,
              } as Partial<ClaudeToolCall>)
            }
          }
        } else if (subtype === 'task_notification' && agentMsg.task_id) {
          const task = session.activeTasks.get(agentMsg.task_id)
          if (task && task.toolUseId) {
            const statusLabel = agentMsg.status === 'completed' ? 'completed' : agentMsg.status === 'failed' ? 'failed' : 'stopped'
            this.updateToolCall(sessionId, task.toolUseId, {
              status: agentMsg.status === 'failed' ? 'error' : 'completed',
              description: `[${statusLabel}] ${agentMsg.summary || task.description}`,
            } as Partial<ClaudeToolCall>)
          }
          session.activeTasks.delete(agentMsg.task_id)
        }
      }
    }

    if (message.type === 'result') {
      session.lastResultSubtype = (message as { subtype?: string }).subtype
      const resultMsg = message as {
        subtype: string
        total_cost_usd?: number
        usage?: { input_tokens?: number; output_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null }
        duration_ms?: number
        num_turns?: number
        result?: string
        errors?: string[]
        deferred_tool_use?: { id: string; name: string; input: Record<string, unknown> }
        modelUsage?: Record<string, { contextWindow?: number; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number; maxOutputTokens?: number }>
      }

      logger.log(`[Claude result] raw: subtype=${resultMsg.subtype}, cost=${resultMsg.total_cost_usd}, turns=${resultMsg.num_turns}, duration=${resultMsg.duration_ms}, result=${resultMsg.result ? JSON.stringify(resultMsg.result.slice(0, 300)) : 'null'}`)
      logger.log(`[Claude result] usage=${JSON.stringify(resultMsg.usage)}, modelUsage=${JSON.stringify(resultMsg.modelUsage)}`)

      session.state.totalCost = resultMsg.total_cost_usd
      session.state.totalTokens =
        (resultMsg.usage?.input_tokens || 0) + (resultMsg.usage?.output_tokens || 0)

      session.metadata.totalCost = resultMsg.total_cost_usd ?? session.metadata.totalCost
      session.metadata.durationMs += resultMsg.duration_ms || 0
      session.metadata.lastQueryCalls = resultMsg.num_turns || 0
      session.metadata.numTurns += resultMsg.num_turns || 0

      if (resultMsg.modelUsage) {
        let totalInput = 0
        let totalOutput = 0
        // Track primary model's cache stats separately (sub-agent tokens pollute cache efficiency)
        const primaryModel = sdkModelForClaudeSelection(session.model || session.metadata.model) || ''
        const selectedContextWindow = expectedContextWindowForModel(session.model || session.metadata.model)
        let primaryCacheRead = 0
        let primaryCacheCreate = 0
        let primaryInput = 0
        for (const [model, modelStats] of Object.entries(resultMsg.modelUsage)) {
          const stats = modelStats as { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; contextWindow?: number }
          const cacheRead = stats.cacheReadInputTokens || 0
          const cacheCreate = stats.cacheCreationInputTokens || 0
          const input = (stats.inputTokens || 0) + cacheRead + cacheCreate
          const line = `[Claude ctx] modelUsage[${model}]: input=${stats.inputTokens}, output=${stats.outputTokens}, cacheRead=${cacheRead}, cacheCreate=${cacheCreate}, contextWindow=${stats.contextWindow}`
          logger.log(line)
          totalInput += input
          totalOutput += stats.outputTokens || 0
          // Match primary model: exact match or prefix match (e.g. "claude-opus-4-6" matches "claude-opus-4-6-20250414")
          if (model === primaryModel || model.startsWith(primaryModel.replace(/\[.*\]$/, ''))) {
            primaryCacheRead = cacheRead
            primaryCacheCreate = cacheCreate
            primaryInput = input
            if (selectedContextWindow) {
              session.metadata.contextWindow = selectedContextWindow
            } else if (stats.contextWindow) {
              session.metadata.contextWindow = stats.contextWindow
            }
          }
          if ((modelStats as { maxOutputTokens?: number }).maxOutputTokens) {
            session.metadata.maxOutputTokens = (modelStats as { maxOutputTokens?: number }).maxOutputTokens!
          }
        }
        const summary = `[Claude ctx] prev: input=${session.metadata.inputTokens}, output=${session.metadata.outputTokens} | new: total=${totalInput}, primary=${primaryInput} (${primaryModel}), output=${totalOutput} | cost=${resultMsg.total_cost_usd}`
        logger.log(summary)
        session.metadata.inputTokens = primaryInput || totalInput
        session.metadata.outputTokens = totalOutput
        session.metadata.cacheReadTokens = primaryInput ? primaryCacheRead : 0
        session.metadata.cacheCreationTokens = primaryInput ? primaryCacheCreate : 0
        // Per-model usage for cost breakdown
        const mu: SessionMetadata['modelUsage'] = {}
        for (const [model, stats] of Object.entries(resultMsg.modelUsage)) {
          const s = stats as { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }
          mu[model] = {
            inputTokens: s.inputTokens || 0,
            outputTokens: s.outputTokens || 0,
            cacheReadInputTokens: s.cacheReadInputTokens || 0,
            cacheCreationInputTokens: s.cacheCreationInputTokens || 0,
            costUSD: s.costUSD || 0,
          }
        }
        session.metadata.modelUsage = mu
        // Ephemeral cache write breakdown (aggregate)
        if (resultMsg.usage?.cache_creation) {
          session.metadata.cacheWrite5mTokens = resultMsg.usage.cache_creation.ephemeral_5m_input_tokens ?? 0
          session.metadata.cacheWrite1hTokens = resultMsg.usage.cache_creation.ephemeral_1h_input_tokens ?? 0
        }
      } else if (resultMsg.usage) {
        const usageFull = resultMsg.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
        const cacheRead = usageFull.cache_read_input_tokens || 0
        const cacheCreate = usageFull.cache_creation_input_tokens || 0
        const totalInput = (usageFull.input_tokens || 0) + cacheRead + cacheCreate
        const line = `[Claude ctx] usage fallback: input=${usageFull.input_tokens}, output=${usageFull.output_tokens}, cacheRead=${cacheRead}, cacheCreate=${cacheCreate} | prev: input=${session.metadata.inputTokens}, output=${session.metadata.outputTokens}`
        logger.log(line)
        session.metadata.inputTokens = totalInput
        session.metadata.outputTokens = usageFull.output_tokens || 0
        session.metadata.cacheReadTokens = cacheRead
        session.metadata.cacheCreationTokens = cacheCreate
      }

      // contextTokens is set from streaming events (the latest API call's input = actual context size).
      // Only fall back to result usage if streaming didn't set it.
      if (!session.metadata.contextTokens && resultMsg.usage?.input_tokens) {
        const u = resultMsg.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
        session.metadata.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      }

      this.send('claude:status', sessionId, { ...session.metadata })

      // Emit deferred tool use as a tool call with deferred flag
      if (resultMsg.deferred_tool_use) {
        const deferred = resultMsg.deferred_tool_use
        logger.log(`[Claude] deferred_tool_use: name=${deferred.name} id=${deferred.id.slice(0, 12)}`)
        this.addToolCall(sessionId, {
          id: deferred.id,
          sessionId,
          toolName: deferred.name,
          input: deferred.input || {},
          status: 'running',
          isDeferred: true,
          timestamp: Date.now(),
        })
      }

      // Cache context usage once while process is still alive (for click after query ends)
      if (session.queryInstance) {
        session.queryInstance.getContextUsage().then(u => {
          if (u) session.cachedContextUsage = u
        }).catch(() => {})
      }

      this.send('claude:result', sessionId, {
        subtype: resultMsg.subtype,
        totalCost: resultMsg.total_cost_usd,
        totalTokens: session.state.totalTokens,
        result: resultMsg.result,
        errors: resultMsg.errors,
      })

      this.send('claude:turn-end', sessionId, {
        reason: resultMsg.subtype === 'success' ? 'completed' : 'error',
        totalCost: resultMsg.total_cost_usd,
        totalTokens: session.state.totalTokens,
        result: resultMsg.result,
        error: resultMsg.subtype !== 'success' ? (typeof resultMsg.errors === 'string' ? resultMsg.errors : resultMsg.subtype) : undefined,
      })

      this.sendCompletionNotification(session, resultMsg.result)
    }
  }

  // V2 session-based query — persistent session, multi-turn without process restart
  private async runQueryV2(sessionId: string, prompt: string, _images?: string[]) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.state.isStreaming = true
    session.abortController = new AbortController()
    session.currentPrompt = prompt
    session.lastResultSubtype = undefined
    this.send('claude:streaming', sessionId, true)

    try {
      const claudeCodePath = resolveClaudeCodePath()
      const nodeExecutable = getNodeExecutable()
      const electronFallback = isElectronFallback()
      if (electronFallback) {
        process.env.ELECTRON_RUN_AS_NODE = '1'
      }

      // Build canUseTool (same logic as V1)
      const canUseTool: CanUseTool = async (toolName, input, opts) => {
        if (toolName === 'AskUserQuestion') {
          return new Promise((resolve) => {
            session.pendingAskUser.set(opts.toolUseID, { resolve })
            this.send('claude:ask-user', sessionId, {
              toolUseId: opts.toolUseID,
              questions: (input as Record<string, unknown>).questions,
            })
          })
        }
        if (session.permissionMode === 'bypassPlan') {
          if (toolName === 'ExitPlanMode') {
            return new Promise((resolve) => {
              session.pendingPermissions.set(opts.toolUseID, {
                resolve: (result: unknown) => {
                  if ((result as { behavior: string }).behavior === 'allow') {
                    session.permissionMode = 'bypassPermissions'
                    this.send('claude:modeChange', sessionId, 'bypassPermissions')
                  }
                  resolve(result)
                }
              })
              this.send('claude:permission-request', sessionId, {
                toolUseId: opts.toolUseID,
                toolName,
                input,
                suggestions: opts.suggestions,
                decisionReason: 'Exit plan mode and switch to bypass execution?',
              })
            })
          }
          return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
        }
        if (session.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
        }
        if (session.permissionMode === 'acceptEdits') {
          const autoApprovedTools = ['Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep']
          if (autoApprovedTools.includes(toolName)) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
          }
        }
        return new Promise((resolve) => {
          const wrappedResolve = toolName === 'ExitPlanMode'
            ? (result: unknown) => {
                if ((result as { behavior: string }).behavior === 'allow') {
                  if ((result as { dontAskAgain?: boolean }).dontAskAgain) {
                    session.permissionMode = 'acceptEdits'
                  } else {
                    session.permissionMode = 'default'
                  }
                  this.send('claude:modeChange', sessionId, session.permissionMode)
                }
                resolve(result)
              }
            : resolve
          session.pendingPermissions.set(opts.toolUseID, { resolve: wrappedResolve })
          this.send('claude:permission-request', sessionId, {
            toolUseId: opts.toolUseID,
            toolName,
            input,
            suggestions: opts.suggestions,
          })
        })
      }

      const currentMode = session.permissionMode
      const sdkMode: PermissionMode = currentMode === 'bypassPlan' ? 'plan' : currentMode as PermissionMode

      // Create or reuse V2 session; recreate if model or compact target changed
      const effectiveModel = sdkModelForClaudeSelection(session.model) || 'sonnet'
      if (
        session.v2Session
        && (session.v2SessionModel !== effectiveModel || session.v2SessionAutoCompactWindow !== session.autoCompactWindow)
      ) {
        logger.log(`[Claude V2] Model/compact changed: ${session.v2SessionModel} → ${effectiveModel}, ${session.v2SessionAutoCompactWindow || 'none'} → ${session.autoCompactWindow || 'none'}, recreating session`)
        try { session.v2Session.close() } catch { /* ignore */ }
        session.v2Session = undefined
      }
      if (!session.v2Session) {
        const { createSession, resumeSession } = await getV2Api()
        const sdkEnv = buildClaudeSdkEnv(session.autoCompactWindow)
        const v2Options = {
          model: effectiveModel,
          permissionMode: sdkMode,
          canUseTool,
          env: sdkEnv,
          ...(claudeCodePath ? { pathToClaudeCodeExecutable: claudeCodePath } : {}),
          ...(nodeExecutable !== 'node' || electronFallback ? { executable: nodeExecutable } : {}),
        }

        // Only resume if the sdkSessionId was created by a V2 session
        const v2ResumeId = session.v2SessionModel ? session.sdkSessionId : undefined
        logger.log(`[Claude V2] Creating session: model=${v2Options.model}, permissionMode=${v2Options.permissionMode}, cwd=${session.cwd}, resumeId=${v2ResumeId || 'none'}, autoCompactWindow=${session.autoCompactWindow || 'none'}`)

        // WORKAROUND: V2 SDK's SDKSessionOptions does not support a `cwd` parameter.
        // The subprocess inherits process.cwd() which in Electron defaults to "/".
        // Temporarily chdir so the spawned subprocess uses the correct working directory.
        const previousCwd = process.cwd()
        try {
          process.chdir(session.cwd)
          if (v2ResumeId) {
            session.v2Session = resumeSession(v2ResumeId, v2Options)
          } else {
            session.v2Session = createSession(v2Options)
          }
        } finally {
          process.chdir(previousCwd)
        }
        session.v2SessionModel = effectiveModel
        session.v2SessionAutoCompactWindow = session.autoCompactWindow
      }

      // Send message — if images are attached, construct a multi-content SDKUserMessage
      if (_images && _images.length > 0) {
        const imageBlocks = _images
          .map(dataUrl => dataUrlToContentBlock(dataUrl))
          .filter(Boolean) as Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>
        if (imageBlocks.length > 0) {
          const contentBlocks = [
            ...imageBlocks,
            ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
          ]
          await session.v2Session.send({
            type: 'user' as const,
            message: {
              role: 'user' as const,
              content: contentBlocks,
            },
            parent_tool_use_id: null,
          })
        } else {
          await session.v2Session.send(prompt || ' ')
        }
      } else {
        await session.v2Session.send(prompt || ' ')
      }

      // Stream messages — reuse shared processMessage()
      for await (const message of session.v2Session.stream()) {
        if (session.abortController.signal.aborted) {
          session.v2Session.close()
          session.v2Session = undefined
          break
        }
        const msgType = (message as { type?: string; subtype?: string })
        if (msgType.type === 'system') {
          logger.log(`[Claude V2] system event: subtype=${msgType.subtype ?? 'none'} raw=`, JSON.stringify(message))
        }
        this.processMessage(sessionId, session, message)
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      const isAbort = errMsg === 'aborted' || errMsg.includes('aborted') || session?.abortController.signal.aborted
      if (!isAbort) {
        logger.error('[Claude V2] query error:', error)
        if (error instanceof Error && error.stack) {
          logger.error('Stack:', error.stack)
        }
        // If resume failed (process exit or invalid session ID), retry fresh
        if (session.sdkSessionId && (errMsg.includes('exited with code') || errMsg.includes('No conversation found'))) {
          logger.warn('[Claude V2] Resume failed, retrying fresh')
          session.sdkSessionId = undefined
          session.v2Session = undefined
          sdkSessionIds.delete(sessionId)
          session.state.isStreaming = false
          this.addMessage(sessionId, {
            id: `sys-retry-${Date.now()}`,
            sessionId,
            role: 'system',
            content: 'Previous V2 session could not be resumed. Starting fresh...',
            timestamp: Date.now(),
          })
          return this.runQueryV2(sessionId, prompt, _images)
        }
        this.send('claude:error', sessionId, errMsg)
      }
    } finally {
      if (isElectronFallback()) {
        delete process.env.ELECTRON_RUN_AS_NODE
      }
      if (session) {
        session.state.isStreaming = false
        session.currentPrompt = undefined
        session.activeTasks.clear()
        for (const msg of session.state.messages) {
          if ('toolName' in msg && (msg as ClaudeToolCall).status === 'running') {
            const toolMsg = msg as ClaudeToolCall
            toolMsg.status = 'error'
            toolMsg.result = toolMsg.result || 'Agent terminated unexpectedly'
            this.send('claude:tool-result', sessionId, {
              id: toolMsg.id,
              status: 'error',
              result: toolMsg.result,
            })
          }
        }
        this.send('claude:streaming', sessionId, false)
        // Send completion notification for V2 (V1 handles this in processMessage)
        if (!session.messageQueue.length) {
          this.sendCompletionNotification(session)
        }
        const next = session.messageQueue.shift()
        if (next) {
          this.runQueryV2(sessionId, next.prompt, next.images)
        } else {
          this._maybeAutoContinue(session, sessionId)
        }
      }
    }
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (session) {
      // Mark as not streaming FIRST — prevents sendMessage() from queuing
      // new messages during the async interrupt() await
      session.state.isStreaming = false
      session.messageQueue.length = 0
      // V2: close the persistent session
      if (session.apiVersion === 'v2' && session.v2Session) {
        try {
          session.v2Session.close()
        } catch { /* ignore close errors */ }
        session.v2Session = undefined
        session.abortController.abort()
      } else if (session.queryInstance) {
        // V1: Use graceful interrupt — lets user type to continue
        try {
          await session.queryInstance.interrupt()
        } catch {
          session.abortController.abort()
        }
      } else {
        session.abortController.abort()
      }
      // Keep the session alive so the user can continue the conversation
      return true
    }
    return false
  }

  /** Hard abort — immediately kill the query loop, no graceful interrupt */
  abortSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.isStreaming = false
      session.messageQueue.length = 0
      // User explicitly stopping — also halt any pending auto-continue.
      session.autoContinue = undefined
      if (session.apiVersion === 'v2' && session.v2Session) {
        try { session.v2Session.close() } catch { /* ignore */ }
        session.v2Session = undefined
      }
      session.abortController.abort()
      this.send('claude:turn-end', sessionId, { reason: 'aborted' })
      return true
    }
    return false
  }

  async stopTask(sessionId: string, toolUseId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session?.queryInstance) {
      logger.warn(`[stopTask] No queryInstance for session ${sessionId}`)
      return false
    }
    // Find the task_id by tool_use_id from activeTasks map
    let targetTaskId: string | null = null
    let targetTask: ActiveTask | null = null
    for (const [taskId, task] of session.activeTasks) {
      if (task.toolUseId === toolUseId) {
        targetTaskId = taskId
        targetTask = task
        break
      }
    }

    // If no mapping in activeTasks, try using tool_use_id directly as the task_id
    // (the SDK may accept it, and task_started events may not always be emitted)
    if (!targetTaskId) {
      logger.log(`[stopTask] No activeTasks mapping for toolUseId=${toolUseId}, trying toolUseId as task_id`)
      targetTaskId = toolUseId
    }

    try {
      await session.queryInstance.stopTask(targetTaskId)
      logger.log(`[stopTask] Successfully stopped task_id=${targetTaskId}`)
      this.updateToolCall(sessionId, toolUseId, {
        status: 'completed',
        description: `[stopped by user] ${targetTask?.summary || targetTask?.description || ''}`,
      } as Partial<ClaudeToolCall>)
      session.activeTasks.delete(targetTaskId)
      return true
    } catch (e) {
      logger.warn(`[stopTask] stopTask(${targetTaskId}) failed:`, e)
      // Fallback: try interrupt to stop the whole session if stopTask fails
      logger.log(`[stopTask] Falling back to marking tool as stopped in UI`)
      this.updateToolCall(sessionId, toolUseId, {
        status: 'error',
        description: `[stop failed] ${targetTask?.description || 'Could not stop task'}`,
      } as Partial<ClaudeToolCall>)
      return false
    }
  }

  /** Kill all sessions and their subprocesses completely */
  killAll() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
    for (const [id, session] of this.sessions) {
      session.abortController.abort()
      session.messageQueue.length = 0
      session.state.isStreaming = false
      try { session.queryInstance?.close() } catch { /* ignore */ }
    }
    this.sessions.clear()
    sdkSessionIds.clear()
  }

  getSessionState(sessionId: string): ClaudeSessionState | null {
    const session = this.sessions.get(sessionId)
    return session?.state || null
  }

  async setPermissionMode(sessionId: string, mode: AppPermissionMode): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    // Always track the mode on the session so the next runQuery picks it up
    session.permissionMode = mode
    if (!session.queryInstance) return true
    try {
      // Map app-level bypassPlan to SDK's plan mode
      const sdkMode: PermissionMode = mode === 'bypassPlan' ? 'plan' : mode
      await session.queryInstance.setPermissionMode(sdkMode)
      return true
    } catch (e) {
      logger.warn('setPermissionMode failed:', e)
      return false
    }
  }

  async setModel(sessionId: string, model: string, autoCompactWindow?: number): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || !model) return false
    const selectedModel = normalizeClaudeModelSelection(model) || model

    // Persist the full model value (including [1m] suffix) — SDK handles it natively
    session.model = selectedModel
    session.metadata.model = selectedModel

    // Sync contextWindow / maxOutputTokens to match the new model so the UI label
    // ("(1M)" vs "(200k)") updates immediately, not on next query response.
    session.metadata.contextWindow = expectedContextWindowForModel(selectedModel) || 200000
    session.metadata.maxOutputTokens = selectedModel.includes('haiku') ? 8192 : 64000

    // Model presets own their auto-compact target; global settings only apply to raw models.
    const previousAutoCompactWindow = session.autoCompactWindow
    const resolvedAutoCompactWindow = autoCompactWindowForClaudeSelection(selectedModel, autoCompactWindow)
    session.autoCompactWindow = resolvedAutoCompactWindow || undefined
    session.metadata.autoCompactWindow = session.autoCompactWindow
    logger.log(`[setModel] autoCompactWindow=${session.autoCompactWindow || 'none'}`)
    const compactChanged = previousAutoCompactWindow !== session.autoCompactWindow

    if (session.apiVersion === 'v2') {
      // V2 env is fixed when the Claude Code process is created. If the compact
      // target changed, close the runtime now so the next resume/send starts
      // with the new CLAUDE_CODE_AUTO_COMPACT_WINDOW.
      if (compactChanged && session.v2Session) {
        try { session.v2Session.close() } catch { /* ignore */ }
        session.v2Session = undefined
        session.v2SessionModel = undefined
        session.v2SessionAutoCompactWindow = undefined
        logger.log(`[setModel] V2 runtime restarted for compact change on session ${sessionId.slice(0, 8)}`)
      }
      logger.log(`[setModel] V2 stored model ${selectedModel} for session ${sessionId.slice(0, 8)}${compactChanged ? ' (runtime will use new compact env)' : ' (takes effect on next message)'}`)
      this.send('claude:status', sessionId, { ...session.metadata })
      return true
    }

    if (compactChanged && session.queryInstance) {
      try { session.queryInstance.close() } catch { /* ignore */ }
      session.queryInstance = undefined
      logger.log(`[setModel] V1 runtime restarted for compact change on session ${sessionId.slice(0, 8)}`)
    }

    if (!session.queryInstance) {
      logger.log(`[setModel] stored model ${selectedModel} for session ${sessionId.slice(0, 8)} (no active query)`)
      this.send('claude:status', sessionId, { ...session.metadata })
      return true
    }

    try {
      const sdkModel = sdkModelForClaudeSelection(selectedModel) || selectedModel
      logger.log(`[setModel] setting model to ${sdkModel} (${selectedModel}) for session ${sessionId.slice(0, 8)}`)
      await session.queryInstance.setModel(sdkModel)
      this.send('claude:status', sessionId, { ...session.metadata })
      logger.log(`[setModel] success: ${sdkModel}`)
      return true
    } catch (e) {
      logger.warn(`[setModel] SDK call failed (model stored for next query):`, e)
      this.send('claude:status', sessionId, { ...session.metadata })
      return true
    }
  }

  setEffort(sessionId: string, effort: EffortLevel): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.effort = effort
    return true
  }

  async getSupportedModels(_sessionId: string): Promise<Array<{ value: string; displayName: string; description: string; source: 'builtin' | 'sdk' }>> {
    const builtinValues = new Set(CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS.keys())
    const builtins = CLAUDE_BUILTIN_MODELS.map(m => ({ ...m, source: 'builtin' as const }))
    try {
      const query = await getQuery()
      const instance = query({ prompt: '', cwd: '/' })
      const sdkModels = await instance.supportedModels()
      // Exclude from SDK list any model already covered by builtins (including [1m] variants)
      const sdkFiltered = sdkModels
        .filter(m => !builtinValues.has(m.value) && !builtinValues.has(`${m.value}[1m]`))
        .map(m => ({ ...m, source: 'sdk' as const }))
      return [...builtins, ...sdkFiltered]
    } catch (e) {
      logger.warn('getSupportedModels failed, returning builtins only:', e)
      return builtins
    }
  }

  async getAccountInfo(sessionId: string): Promise<{ email?: string; organization?: string; subscriptionType?: string } | null> {
    const session = this.sessions.get(sessionId)
    if (!session?.queryInstance) return null
    try {
      return await session.queryInstance.accountInfo()
    } catch (e) {
      logger.warn('getAccountInfo failed:', e)
      return null
    }
  }

  async getSupportedCommands(sessionId: string): Promise<SlashCommand[]> {
    const session = this.sessions.get(sessionId)
    if (!session?.queryInstance) return []
    try {
      return await session.queryInstance.supportedCommands()
    } catch (e) {
      logger.warn('getSupportedCommands failed:', e)
      return []
    }
  }

  async getSupportedAgents(sessionId: string): Promise<Array<{ name: string; description: string; model?: string }>> {
    const session = this.sessions.get(sessionId)
    if (!session?.queryInstance) return []
    try {
      return await session.queryInstance.supportedAgents()
    } catch (e) {
      logger.warn('getSupportedAgents failed:', e)
      return []
    }
  }

  async getContextUsage(sessionId: string): Promise<{
    categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[]
    totalTokens: number
    maxTokens: number
    percentage: number
    model: string
    memoryFiles?: { path: string; type: string; tokens: number }[]
    mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[]
  } | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    // Try live query first
    if (session.queryInstance) {
      try {
        const usage = await session.queryInstance.getContextUsage()
        if (usage) {
          session.cachedContextUsage = usage
          return usage
        }
      } catch {
        // ProcessTransport not ready — fall through to cache
      }
    }
    // Return cached result from last successful live call
    return (session.cachedContextUsage ?? null) as Awaited<ReturnType<typeof this.getContextUsage>>
  }

  getSessionMeta(sessionId: string): Record<string, unknown> | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return { ...session.metadata, permissionMode: session.permissionMode }
  }

  resolvePermission(sessionId: string, toolUseId: string, result: { behavior: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[]; message?: string; dontAskAgain?: boolean }): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const pending = session.pendingPermissions.get(toolUseId)
    if (!pending) return false
    // Apply setMode directives from updatedPermissions (e.g. "don't ask again" → acceptEdits)
    if (result.behavior === 'allow' && result.updatedPermissions) {
      for (const perm of result.updatedPermissions) {
        const p = perm as { type?: string; mode?: string }
        if (p.type === 'setMode' && p.mode) {
          session.permissionMode = p.mode as AppPermissionMode
          this.send('claude:modeChange', sessionId, session.permissionMode)
        }
      }
    }
    pending.resolve(result)
    session.pendingPermissions.delete(toolUseId)
    // Notify all windows to dismiss the permission UI
    this.send('claude:permission-resolved', sessionId, toolUseId)
    return true
  }

  resolveAskUser(sessionId: string, toolUseId: string, answers: Record<string, string>): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const pending = session.pendingAskUser.get(toolUseId)
    if (!pending) return false
    // AskUserQuestion expects a PermissionResult with behavior 'allow' and updatedInput containing answers
    pending.resolve({
      behavior: 'allow',
      updatedInput: { answers },
    })
    session.pendingAskUser.delete(toolUseId)
    // Notify all windows to dismiss the ask-user UI
    this.send('claude:ask-user-resolved', sessionId, toolUseId)
    return true
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    // Try SDK's listSessions API first, fall back to manual JSONL parsing
    await getQuery() // ensure SDK is loaded
    if (listSessionsFn) {
      try {
        const sessions = await listSessionsFn({ dir: cwd, limit: 50 })
        return sessions.map(s => ({
          sdkSessionId: s.sessionId,
          timestamp: s.lastModified,
          preview: s.customTitle || s.firstPrompt || s.summary || '(no preview)',
          messageCount: 0, // SDK doesn't expose count directly
          customTitle: s.customTitle,
          firstPrompt: s.firstPrompt,
          gitBranch: s.gitBranch,
          createdAt: s.createdAt ? new Date(s.createdAt).getTime() : undefined,
          summary: s.summary,
        }))
      } catch (e) {
        logger.warn('SDK listSessions failed, falling back to manual parse:', e)
      }
    }
    return this.listSessionsFallback(cwd)
  }

  private async listSessionsFallback(cwd: string): Promise<SessionSummary[]> {
    const os = await import('os')
    const readline = await import('readline')

    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const projectDir = pathModule.join(os.homedir(), '.claude', 'projects', encoded)

    const results: SessionSummary[] = []
    const candidates = [projectDir]
    if (process.platform === 'win32' && encoded.length > 0) {
      const lower = encoded[0].toLowerCase() + encoded.slice(1)
      const upper = encoded[0].toUpperCase() + encoded.slice(1)
      if (lower !== encoded) candidates.push(pathModule.join(os.homedir(), '.claude', 'projects', lower))
      if (upper !== encoded) candidates.push(pathModule.join(os.homedir(), '.claude', 'projects', upper))
    }

    for (const dir of candidates) {
      let files: string[]
      try {
        files = (await fsPromises.readdir(dir)).filter(f => f.endsWith('.jsonl'))
      } catch {
        continue
      }

      for (const file of files) {
        const filePath = pathModule.join(dir, file)
        const sdkSessionId = pathModule.basename(file, '.jsonl')
        try {
          const stat = await fsPromises.stat(filePath)
          let preview = ''
          let messageCount = 0

          const stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' })
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
          let lineCount = 0
          for await (const line of rl) {
            lineCount++
            if (lineCount > 20) break
            try {
              const obj = JSON.parse(line)
              messageCount++
              if (!preview && obj.type === 'user') {
                const content = obj.message?.content
                if (typeof content === 'string') {
                  preview = content.slice(0, 120)
                } else if (Array.isArray(content)) {
                  const textBlock = content.find((b: { type?: string }) => b.type === 'text')
                  if (textBlock?.text) preview = String(textBlock.text).slice(0, 120)
                }
              }
            } catch {
              // skip malformed lines
            }
          }
          stream.destroy()

          results.push({
            sdkSessionId,
            timestamp: stat.mtimeMs,
            preview: preview || '(no preview)',
            messageCount,
          })
        } catch {
          // skip files that can't be read
        }
      }
    }

    const seen = new Set<string>()
    const deduped = results.filter(r => {
      if (seen.has(r.sdkSessionId)) return false
      seen.add(r.sdkSessionId)
      return true
    })
    deduped.sort((a, b) => b.timestamp - a.timestamp)
    return deduped
  }

  private async loadSessionHistory(sessionId: string, sdkSessionId: string, cwd: string): Promise<void> {
    this.send('claude:resume-loading', sessionId, true)
    try {
      await this._loadSessionHistoryInner(sessionId, sdkSessionId, cwd)
    } finally {
      this.send('claude:resume-loading', sessionId, false)
    }
  }

  private async _loadSessionHistoryInner(sessionId: string, sdkSessionId: string, cwd: string): Promise<void> {
    const os = await import('os')
    const readline = await import('readline')

    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const projectDir = pathModule.join(os.homedir(), '.claude', 'projects', encoded)
    const filePath = pathModule.join(projectDir, `${sdkSessionId}.jsonl`)

    try {
      await fsPromises.stat(filePath)
    } catch {
      return // file not found
    }

    const stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    // Collect all JSONL entries, dedup by uuid (keep last), filter by sessionId
    const entriesByUuid = new Map<string, unknown>()
    const orderedKeys: string[] = []
    let seqCounter = 0

    for await (const line of rl) {
      try {
        const obj = JSON.parse(line) as {
          type: string; uuid?: string; sessionId?: string;
          message?: { role?: string; content?: unknown };
          timestamp?: string
        }
        // Skip entries from other sessions
        if (obj.sessionId && obj.sessionId !== sdkSessionId) continue
        // Skip non-message types (include system for compact boundaries etc.)
        if (obj.type !== 'user' && obj.type !== 'assistant' && obj.type !== 'system') continue

        const key = obj.uuid || `seq-${seqCounter++}`
        if (!entriesByUuid.has(key)) {
          orderedKeys.push(key)
        }
        entriesByUuid.set(key, obj) // last write wins (most complete)
      } catch {
        // skip malformed lines
      }
    }
    stream.destroy()

    // Build message items from deduplicated entries
    type HistoryItem = (ClaudeMessage | ClaudeToolCall)
    const items: HistoryItem[] = []
    // Track tool_use IDs to their index in items for result matching
    const toolIndexMap = new Map<string, number>()

    for (const key of orderedKeys) {
      const obj = entriesByUuid.get(key) as {
        type: string; uuid?: string; message?: { role?: string; content?: unknown }; timestamp?: string
      }
      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()

      if (obj.type === 'user' && obj.message?.role === 'user') {
        const content = obj.message.content
        let text = ''
        if (typeof content === 'string') {
          text = content
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b: { type?: string }) => b.type === 'text')
          if (textBlock?.text) text = String(textBlock.text)
          // Match tool results to their tool calls
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const idx = toolIndexMap.get(block.tool_use_id)
              if (idx !== undefined) {
                const tool = items[idx] as ClaudeToolCall
                const resultStr = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content)
                tool.status = block.is_error ? 'error' : 'completed'
                tool.result = resultStr?.slice(0, 2000)
              }
            }
          }
        }
        // Filter out SDK noise and system caveats
        const isNoise = !text
          || text === '[Request interrupted by user for tool use]'
          || text.startsWith('<local-command-caveat>')
          || text === 'No response requested.'
          || text.startsWith('Unknown skill:')
        if (!isNoise) {
          items.push({
            id: obj.uuid || `hist-user-${items.length}`,
            sessionId,
            role: 'user' as const,
            content: text,
            timestamp: ts,
          })
        }
      }

      if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
        const content = obj.message.content
        if (Array.isArray(content)) {
          // Collect thinking text
          const thinkingBlocks = content.filter((b: { type?: string }) => b.type === 'thinking')
          const thinkingText = thinkingBlocks.map((b: { thinking?: string }) => b.thinking || '').join('\n').trim()

          // Collect assistant text
          const textBlocks = content.filter((b: { type?: string }) => b.type === 'text')
          const assistantText = textBlocks.map((b: { text?: string }) => b.text || '').join('\n').trim()

          // Strip task-notification XML blocks from assistant text (agent progress artifacts)
          const cleanedAssistantText = assistantText
            .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
            .replace(/Full transcript available at:.*$/gm, '')
            .trim()

          // Filter out assistant noise
          const isAssistantNoise = cleanedAssistantText === 'No response requested.'
          if ((cleanedAssistantText || thinkingText) && !isAssistantNoise) {
            const item = {
              id: `${obj.uuid || 'hist'}-text-${items.length}`,
              sessionId,
              role: 'assistant' as const,
              content: cleanedAssistantText || '',
              ...(thinkingText ? { thinking: thinkingText } : {}),
              ...(obj.parent_tool_use_id ? { parentToolUseId: obj.parent_tool_use_id } : {}),
              timestamp: ts,
            }
            items.push(item)
          }

          // Tool uses
          for (const block of content) {
            if (block.type === 'tool_use') {
              const toolItem: ClaudeToolCall = {
                id: block.id,
                sessionId,
                toolName: block.name,
                input: block.input || {},
                status: 'completed',
                ...(obj.parent_tool_use_id ? { parentToolUseId: obj.parent_tool_use_id } : {}),
                timestamp: ts,
              }
              toolIndexMap.set(block.id, items.length)
              items.push(toolItem)
            }
          }
        }
      }

      if (obj.type === 'system') {
        // Include system messages like compact boundaries
        const content = obj.message?.content
        let text = ''
        if (typeof content === 'string') {
          text = content
        } else if (Array.isArray(content)) {
          const textBlock = (content as Array<{ type?: string; text?: string }>).find(b => b.type === 'text')
          if (textBlock?.text) text = textBlock.text
        }
        // Filter out noise — only keep meaningful system messages
        if (text && !text.startsWith('{') && text.length > 5) {
          items.push({
            id: obj.uuid || `hist-sys-${items.length}`,
            sessionId,
            role: 'system' as const,
            content: text,
            timestamp: ts,
          })
        }
      }
    }

    // Send all history as a single batch
    this.send('claude:history', sessionId, items)
  }

  async resumeSession(sessionId: string, sdkSessionIdToResume: string, cwd: string, model?: string, apiVersion?: 'v1' | 'v2', useWorktree?: boolean, worktreePath?: string, worktreeBranch?: string): Promise<boolean> {
    // Stop current session if running
    const session = this.sessions.get(sessionId)
    if (session) {
      session.abortController.abort()
      this.sessions.delete(sessionId)
    }

    // Store the SDK session ID so startSession will use it for resume
    sdkSessionIds.set(sessionId, sdkSessionIdToResume)
    // startSession already calls loadSessionHistory when sdkSessionId is provided
    const result = await this.startSession(sessionId, {
      cwd, sdkSessionId: sdkSessionIdToResume, model, permissionMode: 'bypassPermissions', apiVersion,
      ...(useWorktree ? { useWorktree: true, worktreePath, worktreeBranch } : {}),
    })
    return result
  }

  /** Put a session to rest — kill subprocess but preserve sdkSessionId for resume */
  restSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.messageQueue.length = 0
    session.state.isStreaming = false
    try { session.queryInstance?.close() } catch { /* ignore */ }
    session.queryInstance = undefined
    session.isResting = true
    this.send('claude:message', sessionId, {
      id: `sys-rest-${Date.now()}`,
      sessionId,
      role: 'system',
      content: 'Session is resting. Send a message to wake it up.',
      timestamp: Date.now(),
    } satisfies ClaudeMessage)
    return true
  }

  /** Reset session — clear conversation and start fresh (like /new) */
  async resetSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const originalCwd = session.originalCwd || session.cwd
    const permissionMode = session.permissionMode
    const effort = session.effort
    const model = session.model
    const autoCompactWindow = session.autoCompactWindow
    const apiVersion = session.apiVersion
    // Preserve worktree — never auto-delete. Reuse it on the fresh session.
    const existingWorktreeInfo = session.worktreeInfo

    // Tear down old session completely
    session.abortController.abort()
    session.messageQueue.length = 0
    try { session.queryInstance?.close() } catch { /* ignore */ }
    this.sessions.delete(sessionId)
    sdkSessionIds.delete(sessionId)

    // Start a fresh session preserving settings and reusing existing worktree
    const ok = await this.startSession(sessionId, {
      cwd: originalCwd,
      permissionMode,
      apiVersion,
      useWorktree: !!existingWorktreeInfo,
      worktreePath: existingWorktreeInfo?.worktreePath,
      worktreeBranch: existingWorktreeInfo?.branchName,
      autoCompactWindow,
    })
    if (ok) {
      const newSession = this.sessions.get(sessionId)
      if (newSession) {
        newSession.effort = effort
        newSession.model = model
        newSession.metadata.model = model
        newSession.metadata.contextWindow = expectedContextWindowForModel(model) || newSession.metadata.contextWindow
      }
    }
    // Notify all windows to clear UI for this session
    this.send('claude:session-reset', sessionId)
    return ok
  }

  /** Wake a resting session — will auto-resume on next sendMessage */
  wakeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.isResting = false
    return true
  }

  isResting(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isResting ?? false
  }

  /** Fetch subagent conversation messages from SDK transcript files */
  async fetchSubagentMessages(sessionId: string, agentToolUseId: string): Promise<(ClaudeMessage | ClaudeToolCall)[]> {
    const session = this.sessions.get(sessionId)
    const sdkSid = session?.sdkSessionId || sdkSessionIds.get(sessionId)
    if (!sdkSid) return []

    try {
      await getQuery() // ensure SDK is loaded
      if (!getSubagentMessagesFn) return []

      const messages = await getSubagentMessagesFn(sdkSid, agentToolUseId, {
        dir: session?.cwd,
      })

      const items: (ClaudeMessage | ClaudeToolCall)[] = []
      const toolIndexMap = new Map<string, number>()

      for (const msg of messages) {
        const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now()

        if (msg.type === 'user') {
          const content = msg.message?.content
          let text = ''
          if (typeof content === 'string') {
            text = content
          } else if (Array.isArray(content)) {
            const textBlock = (content as Array<{ type?: string; text?: string }>).find(b => b.type === 'text')
            if (textBlock?.text) text = textBlock.text
            // Match tool results
            for (const block of content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const idx = toolIndexMap.get(block.tool_use_id)
                if (idx !== undefined) {
                  const tool = items[idx] as ClaudeToolCall
                  tool.status = block.is_error ? 'error' : 'completed'
                  tool.result = (typeof block.content === 'string' ? block.content : JSON.stringify(block.content))?.slice(0, 2000)
                }
              }
            }
          }
          const isNoise = !text || text === '[Request interrupted by user for tool use]' || text.startsWith('<local-command-caveat>')
          if (!isNoise) {
            items.push({ id: `sa-user-${items.length}`, sessionId, role: 'user' as const, content: text, parentToolUseId: agentToolUseId, timestamp: ts })
          }
        }

        if (msg.type === 'assistant') {
          const content = msg.message?.content
          if (Array.isArray(content)) {
            const contentArr = content as Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }>
            const thinkingText = contentArr.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('\n').trim()
            const assistantText = contentArr.filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim()
            if (assistantText || thinkingText) {
              items.push({
                id: `sa-asst-${items.length}`, sessionId, role: 'assistant' as const,
                content: assistantText || '', ...(thinkingText ? { thinking: thinkingText } : {}),
                parentToolUseId: agentToolUseId, timestamp: ts,
              })
            }
            for (const block of contentArr) {
              if (block.type === 'tool_use' && block.id && block.name) {
                const toolItem: ClaudeToolCall = {
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
    } catch (e) {
      logger.warn(`[fetchSubagentMessages] failed for agent ${agentToolUseId.slice(0, 12)}:`, e)
      return []
    }
  }

  /**
   * Rewind the session's conversation history to the state BEFORE the user prompt
   * at `promptIndex` (0-based, counting only user text prompts, not tool_results).
   *
   * Writes a new JSONL file containing only entries before the target prompt, then
   * swaps the session's sdkSessionId to point at it. The original JSONL is kept intact.
   *
   * The caller (renderer) is responsible for trimming its local message list to match.
   */
  async rewindToPrompt(sessionId: string, promptIndex: number): Promise<{ newSdkSessionId: string; removedPromptCount: number } | { error: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) return { error: 'Session not found' }

    const currentSdkId = session.sdkSessionId || sdkSessionIds.get(sessionId)
    if (!currentSdkId) return { error: 'No SDK session to rewind' }

    if (session.state.isStreaming) {
      return { error: 'Cannot rewind while Claude is responding — stop the current turn first.' }
    }

    const os = await import('os')
    const { randomUUID } = await import('crypto')
    const cwd = session.cwd
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const projectDir = pathModule.join(os.homedir(), '.claude', 'projects', encoded)
    const filePath = pathModule.join(projectDir, `${currentSdkId}.jsonl`)

    try {
      await fsPromises.stat(filePath)
    } catch {
      return { error: `Session history file not found: ${filePath}` }
    }

    const content = await fsPromises.readFile(filePath, 'utf-8')
    const lines = content.split('\n').filter(l => l.trim())

    let userPromptCount = 0
    let cutoffIdx = -1
    for (let i = 0; i < lines.length; i++) {
      try {
        const obj = JSON.parse(lines[i]) as { type?: string; message?: { role?: string; content?: unknown } }
        if (obj.type !== 'user' || obj.message?.role !== 'user') continue
        const msgContent = obj.message.content
        let hasText = false
        if (typeof msgContent === 'string' && msgContent.length > 0) {
          hasText = true
        } else if (Array.isArray(msgContent)) {
          hasText = msgContent.some((b: { type?: string }) => b.type === 'text')
        }
        if (!hasText) continue
        if (userPromptCount === promptIndex) {
          cutoffIdx = i
          break
        }
        userPromptCount++
      } catch { /* skip malformed */ }
    }

    if (cutoffIdx === -1) {
      return { error: `Prompt index ${promptIndex} not found (only ${userPromptCount} user prompt(s) in history)` }
    }

    const keptLines = lines.slice(0, cutoffIdx)
    const newSdkSessionId = randomUUID()

    const rewrittenLines = keptLines.map(line => {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (typeof obj.sessionId === 'string') obj.sessionId = newSdkSessionId
        return JSON.stringify(obj)
      } catch {
        return line
      }
    })

    const newFilePath = pathModule.join(projectDir, `${newSdkSessionId}.jsonl`)
    await fsPromises.writeFile(newFilePath, rewrittenLines.join('\n') + (rewrittenLines.length > 0 ? '\n' : ''), 'utf-8')

    // Abort any in-flight query (shouldn't be any since we checked isStreaming, but be safe)
    session.abortController.abort()
    session.abortController = new AbortController()

    // Swap session to the new SDK session ID
    session.sdkSessionId = newSdkSessionId
    sdkSessionIds.set(sessionId, newSdkSessionId)
    session.metadata.sdkSessionId = newSdkSessionId

    const removedPromptCount = lines.length - cutoffIdx
    logger.log(`[rewindToPrompt] sessionId=${sessionId.slice(0, 8)} promptIndex=${promptIndex} kept=${keptLines.length}/${lines.length} lines, newSdkSessionId=${newSdkSessionId.slice(0, 8)}`)

    this.send('claude:status', sessionId, { ...session.metadata })

    return { newSdkSessionId, removedPromptCount }
  }

  async forkSession(sessionId: string): Promise<{ newSdkSessionId: string } | null> {
    const session = this.sessions.get(sessionId)
    const currentSdkId = session?.sdkSessionId || sdkSessionIds.get(sessionId)
    if (!currentSdkId) {
      logger.warn(`[forkSession] no sdkSessionId for session ${sessionId.slice(0, 8)}`)
      return null
    }

    // sdk.forkSession is NOT an exported function — it's a QueryOptions boolean.
    // Correct approach: call query() with { resume: currentSdkId, forkSession: true },
    // capture the new session_id from system:init, then abort immediately.
    const query = await getQuery()
    const claudeCodePath = resolveClaudeCodePath()
    const nodeExecutable = getNodeExecutable()
    const cwd = session?.cwd

    logger.log(`[forkSession] starting: sdkSessionId=${currentSdkId.slice(0, 8)} cwd=${cwd}`)

    const abortController = new AbortController()
    let newSdkSessionId: string | null = null

    // Safety timeout: if the fork turn never completes, abort so we don't hang forever.
    const timeoutHandle = setTimeout(() => {
      if (!abortController.signal.aborted) {
        logger.warn('[forkSession] timeout waiting for result, aborting')
        abortController.abort()
      }
    }, 60_000)

    try {
      const generator = query({
        prompt: ' ',
        options: {
          abortController,
          cwd,
          resume: currentSdkId,
          forkSession: true,
          maxTurns: 1,
          ...(claudeCodePath ? { pathToClaudeCodeExecutable: claudeCodePath } : {}),
          ...(nodeExecutable !== 'node' ? { executable: nodeExecutable } : {}),
        } as Parameters<typeof query>[0]['options'],
      })

      // Must wait for `result` (not just `init`) — the CLI only writes the forked
      // transcript file (~/.claude/projects/.../<newId>.jsonl) after at least one
      // turn completes. Aborting on init leaves the new session_id unresumable.
      for await (const message of generator) {
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
          newSdkSessionId = (message as { session_id: string }).session_id
          logger.log(`[forkSession] received init, new session=${newSdkSessionId?.slice(0, 8)}`)
        } else if (message.type === 'result') {
          logger.log(`[forkSession] fork turn complete, transcript persisted`)
          break
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      const isExpectedAbort = errMsg.includes('abort') || errMsg.includes('aborted') || abortController.signal.aborted
      if (!isExpectedAbort) {
        logger.error(`[forkSession] unexpected error:`, e)
      }
    } finally {
      clearTimeout(timeoutHandle)
    }

    if (!newSdkSessionId) {
      logger.error(`[forkSession] failed — did not receive system:init`)
      return null
    }

    logger.log(`[forkSession] success newSdkSessionId=${newSdkSessionId.slice(0, 8)}`)
    return { newSdkSessionId }
  }

  dispose() {
    for (const [id, session] of this.sessions) {
      this.stopSession(id)
      // Forcefully terminate the CLI subprocess
      try {
        session.queryInstance?.close()
      } catch {
        // Ignore errors during shutdown
      }
    }
    // Do NOT clean up worktrees on dispose — they should persist across app restarts.
    // Users explicitly discard worktrees via the UI.
    this.sessions.clear()
    sdkSessionIds.clear()
  }

  // --- Worktree operations ---

  async getWorktreeStatus(sessionId: string): Promise<{ diff: string; branchName: string; worktreePath: string; sourceBranch: string } | null> {
    return worktreeManager.getWorktreeStatus(sessionId)
  }

  async cleanupWorktree(sessionId: string, deleteBranch = true): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    try {
      await worktreeManager.removeWorktree(sessionId, deleteBranch)
      if (session) {
        // Restore original cwd
        if (session.originalCwd) {
          session.cwd = session.originalCwd
        }
        session.worktreeInfo = undefined
        session.originalCwd = undefined
        this.send('claude:worktree-info', sessionId, null)
      }
      return true
    } catch (err) {
      logger.error(`[Claude] Failed to cleanup worktree: ${err}`)
      return false
    }
  }

}
