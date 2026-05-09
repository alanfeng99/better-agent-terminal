import type { BrowserWindow } from 'electron'
import type { ClaudeMessage, ClaudeToolCall, ClaudeSessionState } from '../src/types/claude-agent'
import type { SessionSummary } from './openai-agent/persistence'
import { prepareImageForApi } from './image-utils'
import { logger } from './logger'
import { broadcastHub } from './remote/broadcast-hub'
import { notificationCenter } from './notification-center'
import { wrapInterruptedPrompt } from './agent-prompt-utils'
import { buildBuiltinTools } from './openai-tools/registry'
import { TOOL_CONTEXT_KEY, type OpenAIAskUserQuestion, type OpenAIPermissionMode, type OpenAIToolContext } from './openai-tools/context'
import { hasCodexOAuthCredential, loadOpenAIAuthCredential } from './openai-agent/api-key'
import { DEFAULT_OPENAI_MODEL, findModel, OPENAI_MODELS, CODEX_CHATGPT_SUPPORTED_MODELS } from './openai-agent/models'
import { scanSkills, buildSkillsSystemPromptSection, type SkillMeta } from './openai-agent/skills-scanner'
import { buildCxSystemPromptAppend } from './semantic-navigation'
import {
  needsCompaction as compactionNeeded,
  splitForCompaction,
  truncateToolOutputs,
  buildCompactionPrompt,
} from './openai-agent/compaction'
import {
  appendEvent,
  findSessionFile,
  listAllSessions,
  loadHistory,
  newSessionId,
  sessionFilePath,
} from './openai-agent/persistence'

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
  maxOutputTokens: number
  contextTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  callCacheRead: number
  callCacheWrite: number
  lastQueryCalls: number
  lastTurnFirstTokenMs?: number
  lastTurnDurationMs?: number
}

interface QueuedMessage {
  prompt: string
  images?: string[]
  suppressUserMessage?: boolean
}

interface PendingPermission {
  resolve: (ok: boolean) => void
  toolName: string
  input: Record<string, unknown>
}

interface PendingAskUser {
  resolve: (answers: Record<string, string>) => void
  questions: OpenAIAskUserQuestion[]
}

interface OpenAISessionInstance {
  abortController: AbortController
  state: ClaudeSessionState
  ownerProfileId: string | null
  cwd: string
  metadata: SessionMetadata
  model: string
  effort: string
  permissionMode: OpenAIPermissionMode
  messageQueue: QueuedMessage[]
  currentPrompt?: string
  isRunning?: boolean
  lastEventAt?: number
  startTime: number
  sdkSessionId: string
  jsonlFile: string
  pendingPermissions: Map<string, PendingPermission>
  pendingAskUsers: Map<string, PendingAskUser>
  modelMessages: ModelMessage[]
  systemPrompt: string
  toolApprovedOnce: Set<string>
  skills: Map<string, SkillMeta>
  turnStartTime?: number
  turnFirstTokenSeen?: boolean
}

type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
}

type HistoryItem = ClaudeMessage | ClaudeToolCall

const CODEX_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const CODEX_CHATGPT_ONLY_MODELS = new Set(['gpt-5.5'])

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI coding assistant running inside a terminal UI.

You have access to the following tools for working with the user's codebase:
- Bash: run shell commands in the working directory
- Read: read files with line numbers
- Write: create or overwrite files
- Edit: replace exact text in a file
- Grep: regex-search file contents
- Glob: find files by pattern
- TodoWrite: maintain a structured checklist for multi-step work
- AskUserQuestion: ask the user concrete blocking questions with explicit options

Rules:
- Keep responses concise. Prefer direct action over commentary.
- When editing, prefer Edit over Write for targeted changes.
- Always read a file before editing it.
- Don't make assumptions about the codebase — inspect it.
- Treat the user's requested deliverable as already requested. Do not end with vague offers such as "if you want, I can..." when the next useful action is within the requested scope.
- If the user asks to create, write, draft, organize, or document something, produce the artifact directly using Write/Edit when allowed. If plan mode blocks writing, use ExitPlanMode with a concrete plan to request execution approval.
- If a decision is genuinely blocking, call AskUserQuestion with 2-4 concrete options and a recommended default. If the decision is not blocking, choose a reasonable default, state the assumption briefly, and continue.
- Prefer creating durable files for long plans, checklists, release notes, specs, and docs instead of only streaming a long prose answer. Summarize the file path and key contents after writing.

Plan mode:
- Treat plan mode as read-only investigation. Read files, search, and run safe inspection commands as needed, but do not edit project files.
- When the task needs implementation, produce a concrete plan with scope, ordered steps, risks, and validation.
- To request execution approval, call ExitPlanMode with the plan. Wait for the user decision before making changes.
- If the plan is rejected, revise the plan instead of executing.
- After approval, continue with the approved scope only.

Execution tracking:
- For multi-step implementation, call TodoWrite with the full checklist before changing files.
- Keep exactly one checklist item in_progress while work is active.
- Mark items completed as soon as they are actually done, not at the end.`

let openaiModule: typeof import('@ai-sdk/openai') | null = null
let aiModule: typeof import('ai') | null = null

async function getOpenAI() {
  if (!openaiModule) openaiModule = await import('@ai-sdk/openai')
  return openaiModule
}
async function getAI() {
  if (!aiModule) aiModule = await import('ai')
  return aiModule
}

export class OpenAIAgentManager {
  private sessions: Map<string, OpenAISessionInstance> = new Map()
  private getWindows: () => BrowserWindow[]
  private getWindowsForProfile?: (profileId: string | null) => BrowserWindow[]
  private static readonly MSG_BUFFER_CAP = 300

  constructor(getWindows: () => BrowserWindow[], getWindowsForProfile?: (profileId: string | null) => BrowserWindow[]) {
    this.getWindows = getWindows
    this.getWindowsForProfile = getWindowsForProfile
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
      if (!win.isDestroyed()) win.webContents.send(channel, sessionId, ...args)
    }
    broadcastHub.broadcast(channel, sessionId, ...args)
  }

  private makeMetadata(model: string | undefined, cwd: string): SessionMetadata {
    const info = findModel(model)
    return {
      model,
      cwd,
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      numTurns: 0,
      contextWindow: info?.contextWindow ?? 0,
      maxOutputTokens: info?.maxOutputTokens ?? 0,
      contextTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      callCacheRead: 0,
      callCacheWrite: 0,
      lastQueryCalls: 0,
    }
  }

  private addMessage(sessionId: string, msg: ClaudeMessage) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(msg)
      if (session.state.messages.length > OpenAIAgentManager.MSG_BUFFER_CAP) {
        session.state.messages = session.state.messages.slice(-OpenAIAgentManager.MSG_BUFFER_CAP)
      }
      if (msg.role === 'user') {
        appendEvent(session.jsonlFile, { type: 'user', payload: { content: msg.content } }).catch(() => { /* ignore */ })
      } else if (msg.role === 'assistant') {
        appendEvent(session.jsonlFile, { type: 'assistant', payload: { content: msg.content, thinking: msg.thinking } }).catch(() => { /* ignore */ })
      }
    }
    this.send('claude:message', sessionId, msg)
  }

  private addToolCall(sessionId: string, tool: ClaudeToolCall) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(tool)
      if (session.state.messages.length > OpenAIAgentManager.MSG_BUFFER_CAP) {
        session.state.messages = session.state.messages.slice(-OpenAIAgentManager.MSG_BUFFER_CAP)
      }
    }
    this.send('claude:tool-use', sessionId, tool)
  }

  private updateToolCall(sessionId: string, toolId: string, updates: Partial<ClaudeToolCall>) {
    const session = this.sessions.get(sessionId)
    if (session) {
      const idx = session.state.messages.findIndex(m => 'toolName' in m && m.id === toolId)
      if (idx !== -1) {
        const existing = session.state.messages[idx] as ClaudeToolCall
        Object.assign(existing, updates)
        if (updates.status === 'completed' || updates.status === 'error') {
          appendEvent(session.jsonlFile, {
            type: 'tool',
            payload: {
              id: existing.id,
              toolName: existing.toolName,
              input: existing.input,
              status: existing.status,
              result: existing.result,
            },
          }).catch(() => { /* ignore */ })
        }
      }
    }
    this.send('claude:tool-result', sessionId, { id: toolId, ...updates })
  }

  private replaceHistory(sessionId: string, items: HistoryItem[]) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages = items.slice(-OpenAIAgentManager.MSG_BUFFER_CAP)
    }
    this.send('claude:history', sessionId, items)
  }

  private rebuildModelMessages(session: OpenAISessionInstance): void {
    const msgs: ModelMessage[] = [{ role: 'system', content: session.systemPrompt }]
    let pendingToolCalls: Array<{ id: string; toolName: string; input: Record<string, unknown>; result?: string }> = []
    let lastAssistantText = ''

    const flush = () => {
      if (pendingToolCalls.length === 0) {
        if (lastAssistantText) {
          msgs.push({ role: 'assistant', content: lastAssistantText })
          lastAssistantText = ''
        }
        return
      }
      const assistantContent: unknown[] = []
      if (lastAssistantText) assistantContent.push({ type: 'text', text: lastAssistantText })
      for (const tc of pendingToolCalls) {
        assistantContent.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.toolName, args: tc.input })
      }
      msgs.push({ role: 'assistant', content: assistantContent })
      const toolContent: unknown[] = []
      for (const tc of pendingToolCalls) {
        toolContent.push({ type: 'tool-result', toolCallId: tc.id, toolName: tc.toolName, result: tc.result ?? '' })
      }
      msgs.push({ role: 'tool', content: toolContent })
      pendingToolCalls = []
      lastAssistantText = ''
    }

    for (const item of session.state.messages) {
      if ('role' in item) {
        if (item.role === 'system') continue
        flush()
        if (item.role === 'assistant') {
          lastAssistantText = item.content
        } else {
          msgs.push({ role: item.role, content: item.content })
        }
      } else {
        const tc = item as ClaudeToolCall
        pendingToolCalls.push({ id: tc.id, toolName: tc.toolName, input: tc.input, result: tc.result })
      }
    }
    flush()
    session.modelMessages = msgs
  }

  private async compactHistory(session: OpenAISessionInstance, reason: 'auto' | 'manual'): Promise<boolean> {
    const stag = `[openai:${session.state.sessionId.slice(0, 8)}]`
    const { head, tail } = splitForCompaction(session.state.messages)
    if (!head.length) {
      logger.log(`${stag} Compaction (${reason}) skipped — nothing in head`)
      return false
    }
    const authCredential = await loadOpenAIAuthCredential(CODEX_CHATGPT_ONLY_MODELS.has(session.model))
    if (!authCredential) {
      this.send('claude:error', session.state.sessionId, 'Compaction failed: OpenAI API key missing')
      return false
    }
    if (CODEX_CHATGPT_ONLY_MODELS.has(session.model) && authCredential.source !== 'codex-oauth') {
      this.send('claude:error', session.state.sessionId, 'Compaction failed: GPT-5.5 requires Codex ChatGPT sign-in; API-key auth is not supported yet.')
      return false
    }
    this.send('claude:status', session.state.sessionId, { ...session.metadata, compacting: true })
    try {
      const { createOpenAI } = await getOpenAI()
      const { generateText, streamText: streamTextFn } = await getAI()
      const isCodexOAuth = authCredential.source === 'codex-oauth'
      const provider = createOpenAI({
        apiKey: authCredential.apiKey,
        ...(isCodexOAuth ? {
          baseURL: CODEX_CHATGPT_BASE_URL,
          ...(authCredential.accountId ? { headers: { 'ChatGPT-Account-ID': authCredential.accountId } } : {}),
        } : {}),
      })
      const compactModel = isCodexOAuth ? provider.responses(session.model) : provider(session.model)
      const truncated = truncateToolOutputs(head)
      const prompt = buildCompactionPrompt(truncated)
      const compactSystem = 'You are a summarizer. Produce only the requested Markdown summary; no preamble.'
      let summary: string
      if (isCodexOAuth) {
        const stream = streamTextFn({
          model: compactModel, system: compactSystem, prompt,
          providerOptions: { openai: { store: false, instructions: compactSystem } },
        })
        summary = (await stream.text).trim()
      } else {
        const result = await generateText({ model: compactModel, system: compactSystem, prompt })
        summary = result.text.trim()
      }
      const systemNote: ClaudeMessage = {
        id: `sys-compact-${Date.now()}`,
        sessionId: session.state.sessionId,
        role: 'system',
        content: `[Compacted ${head.length} prior messages]\n\n${summary}`,
        timestamp: Date.now(),
      }
      session.state.messages = [systemNote, ...tail]
      session.modelMessages = []
      await appendEvent(session.jsonlFile, { type: 'compaction', payload: { count: head.length, reason, summary } })
      this.send('claude:history', session.state.sessionId, session.state.messages)
      this.addMessage(session.state.sessionId, {
        id: `sys-compact-done-${Date.now()}`,
        sessionId: session.state.sessionId,
        role: 'system',
        content: `📦 Compacted ${head.length} prior messages (${reason}).`,
        timestamp: Date.now(),
      })
      logger.log(`${stag} Compacted ${head.length} messages (${reason})`)
      return true
    } catch (err) {
      logger.error(`${stag} Compaction failed:`, err)
      this.send('claude:error', session.state.sessionId, `Compaction failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      this.send('claude:status', session.state.sessionId, { ...session.metadata, compacting: false })
    }
  }

  async compactNow(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (session.isRunning) return false
    return this.compactHistory(session, 'manual')
  }

  private makePermissionRequester(session: OpenAISessionInstance): OpenAIToolContext['requestPermission'] {
    return (toolName, input, toolCallId) => {
      if (session.permissionMode === 'bypassPermissions') return Promise.resolve(true)
      if (session.permissionMode === 'acceptEdits' && (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'Grep' || toolName === 'Glob')) {
        return Promise.resolve(true)
      }
      const isPlanMode = session.permissionMode === 'plan' || session.permissionMode === 'bypassPlan'
      if (session.toolApprovedOnce.has(toolName) && session.permissionMode !== 'default' && !isPlanMode) {
        return Promise.resolve(true)
      }
      return new Promise<boolean>((resolve) => {
        session.pendingPermissions.set(toolCallId, { resolve, toolName, input })
        this.send('claude:permission-request', session.state.sessionId, {
          toolUseId: toolCallId,
          toolName,
          input,
          decisionReason: typeof input.decisionReason === 'string' ? input.decisionReason : undefined,
        })
      })
    }
  }

  private makeAskUserRequester(session: OpenAISessionInstance): OpenAIToolContext['askUser'] {
    return (questions, toolCallId) => new Promise<Record<string, string>>((resolve) => {
      session.pendingAskUsers.set(toolCallId, { resolve, questions })
      this.send('claude:ask-user', session.state.sessionId, {
        toolUseId: toolCallId,
        questions,
      })
    })
  }

  async startSession(sessionId: string, options: {
    cwd: string
    prompt?: string
    permissionMode?: string
    model?: string
    effort?: string
    apiVersion?: string
    agentPreset?: string
    resumeSdkSessionId?: string
    ownerProfileId?: string | null
    [key: string]: unknown
  }): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true

    const stag = `[openai:${sessionId.slice(0, 8)}]`
    const authCredential = await loadOpenAIAuthCredential(CODEX_CHATGPT_ONLY_MODELS.has(options.model || DEFAULT_OPENAI_MODEL))
    if (!authCredential) {
      this.send('claude:error', sessionId, 'OpenAI API key not configured. Set it in Settings → OpenAI Agent, or login to Codex CLI (`codex login`).')
      return false
    }

    const model = options.model || DEFAULT_OPENAI_MODEL
    const sdkSessionId = options.resumeSdkSessionId || newSessionId()
    const startTime = Date.now()
    const jsonlFile = sessionFilePath(sdkSessionId, startTime)

    const session: OpenAISessionInstance = {
      abortController: new AbortController(),
      state: { sessionId, messages: [], isStreaming: false },
      ownerProfileId: options.ownerProfileId ?? null,
      cwd: options.cwd,
      metadata: { ...this.makeMetadata(model, options.cwd), sdkSessionId },
      model,
      effort: options.effort || 'medium',
      permissionMode: (options.permissionMode as OpenAIPermissionMode) || 'default',
      messageQueue: [],
      startTime,
      sdkSessionId,
      jsonlFile,
      pendingPermissions: new Map(),
      pendingAskUsers: new Map(),
      modelMessages: [],
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      toolApprovedOnce: new Set(),
      skills: new Map(),
    }

    this.sessions.set(sessionId, session)

    try {
      const found = await scanSkills(options.cwd)
      for (const s of found) session.skills.set(s.name, s)
      const cxSystemPromptAppend = buildCxSystemPromptAppend()
      session.systemPrompt = DEFAULT_SYSTEM_PROMPT
        + (found.length ? buildSkillsSystemPromptSection(found) : '')
        + (cxSystemPromptAppend ? `\n\n${cxSystemPromptAppend}` : '')
      logger.log(`${stag} Loaded ${found.length} skills`)
    } catch (err) {
      logger.warn(`${stag} Skills scan failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    logger.log(`${stag} Starting cwd=${options.cwd} model=${model} resume=${!!options.resumeSdkSessionId}`)

    if (options.resumeSdkSessionId) {
      this.send('claude:resume-loading', sessionId, true)
      try {
        const file = await findSessionFile(options.resumeSdkSessionId)
        if (file) {
          session.jsonlFile = file
          const items = await loadHistory(file, sessionId)
          this.replaceHistory(sessionId, items)
          logger.log(`${stag} Resumed ${items.length} history items`)
        } else {
          logger.warn(`${stag} Resume file not found for ${options.resumeSdkSessionId}`)
        }
      } finally {
        this.send('claude:resume-loading', sessionId, false)
      }
    } else {
      this.addMessage(sessionId, {
        id: `sys-init-${sessionId}`,
        sessionId,
        role: 'system',
        content: `OpenAI session started (model: ${model}, permission: ${session.permissionMode})`,
        timestamp: Date.now(),
      })
    }

    this.send('claude:status', sessionId, { ...session.metadata })

    if (options.prompt) {
      await this.sendMessage(sessionId, options.prompt)
    }

    return true
  }

  async sendMessage(sessionId: string, prompt: string, images?: string[], suppressUserMessage = false): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const stag = `[openai:${sessionId.slice(0, 8)}]`

    if (session.isRunning) {
      logger.log(`${stag} Interrupting running turn to queue new message`)
      const aborted = session.currentPrompt
      session.abortController.abort()
      session.messageQueue.length = 0
      const contextual = aborted ? wrapInterruptedPrompt(aborted, prompt) : prompt
      const displayContent = contextual + (images?.length ? `\n[${images.length} image${images.length > 1 ? 's' : ''} attached]` : '')
      this.addMessage(sessionId, {
        id: `user-${Date.now()}`,
        sessionId,
        role: 'user',
        content: displayContent,
        timestamp: Date.now(),
      })
      session.messageQueue.push({ prompt: contextual, images, suppressUserMessage: true })
      return true
    }

    session.abortController = new AbortController()
    session.isRunning = true
    session.currentPrompt = prompt
    session.state.isStreaming = true
    session.lastEventAt = Date.now()
    const ctrl = session.abortController

    if (session.modelMessages.length === 0) {
      this.rebuildModelMessages(session)
    }

    if (!suppressUserMessage) {
      const displayContent = prompt + (images?.length ? `\n[${images.length} image${images.length > 1 ? 's' : ''} attached]` : '')
      this.addMessage(sessionId, {
        id: `user-${Date.now()}`,
        sessionId,
        role: 'user',
        content: displayContent,
        timestamp: Date.now(),
      })
    }

    // Build user message content — multi-part when images are attached
    let userContent: unknown = prompt
    if (images?.length) {
      const parts: unknown[] = []
      for (const dataUrl of images) {
        const prepared = prepareImageForApi(dataUrl)
        if (prepared) {
          parts.push({ type: 'image', image: prepared.base64, mimeType: prepared.mimeType })
        }
      }
      if (parts.length > 0) {
        parts.push({ type: 'text', text: prompt })
        userContent = parts
      }
    }
    session.modelMessages.push({ role: 'user', content: userContent })

    const turnStart = Date.now()
    session.turnStartTime = turnStart
    session.turnFirstTokenSeen = false
    let currentAssistantText = ''
    let currentThinkingText = ''

    try {
      const authCredential = await loadOpenAIAuthCredential(CODEX_CHATGPT_ONLY_MODELS.has(session.model))
      if (!authCredential) {
        this.send('claude:error', sessionId, 'OpenAI API key not configured. Set it in Settings → OpenAI Agent, or login to Codex CLI (`codex login`).')
        this.send('claude:turn-end', sessionId, { reason: 'error', error: 'API key missing' })
        return false
      }
      if (CODEX_CHATGPT_ONLY_MODELS.has(session.model) && authCredential.source !== 'codex-oauth') {
        this.send('claude:error', sessionId, 'GPT-5.5 is currently available only through Codex ChatGPT sign-in, not API-key auth. Run `codex login` or choose GPT-5.4.')
        this.send('claude:turn-end', sessionId, { reason: 'error', error: 'GPT-5.5 requires Codex ChatGPT auth' })
        return false
      }

      const { createOpenAI } = await getOpenAI()
      const { streamText, stepCountIs } = await getAI()
      const isCodexOAuth = authCredential.source === 'codex-oauth'
      const debugFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const body = typeof init?.body === 'string' ? init.body : '(non-string body)'
        logger.log(`${stag} → ${init?.method || 'POST'} ${url} body=${body.length > 4000 ? body.slice(0, 4000) + '…(truncated)' : body}`)
        const res = await fetch(input, init)
        if (!res.ok) {
          const clone = res.clone()
          const text = await clone.text().catch(() => '(unreadable)')
          logger.error(`${stag} ← ${res.status} ${res.statusText} body=${text.length > 4000 ? text.slice(0, 4000) + '…(truncated)' : text}`)
        } else {
          logger.log(`${stag} ← ${res.status} ${res.statusText}`)
        }
        return res
      }
      const provider = createOpenAI({
        apiKey: authCredential.apiKey,
        fetch: debugFetch,
        ...(isCodexOAuth ? {
          baseURL: CODEX_CHATGPT_BASE_URL,
          ...(authCredential.accountId ? { headers: { 'ChatGPT-Account-ID': authCredential.accountId } } : {}),
        } : {}),
      })
      const languageModel = isCodexOAuth
        ? provider.responses(session.model)
        : provider(session.model)

      const tools = buildBuiltinTools({ skills: session.skills.size > 0 })

      const toolCtx: OpenAIToolContext = {
        sessionId,
        cwd: session.cwd,
        permissionMode: session.permissionMode,
        abortSignal: ctrl.signal,
        requestPermission: this.makePermissionRequester(session),
        askUser: this.makeAskUserRequester(session),
        setPermissionMode: (mode) => {
          session.permissionMode = mode
          this.send('claude:modeChange', sessionId, mode)
          this.send('claude:status', sessionId, { ...session.metadata, permissionMode: mode })
        },
        addToolCall: (t) => this.addToolCall(sessionId, t),
        updateToolCall: (id, u) => this.updateToolCall(sessionId, id, u),
        skills: session.skills,
      }

      const experimental_context: Record<string | symbol, unknown> = { [TOOL_CONTEXT_KEY]: toolCtx }

      session.metadata.numTurns++
      this.send('claude:status', sessionId, { ...session.metadata })

      const modelInfo = findModel(session.model)
      const supportsReasoning = modelInfo?.supportsReasoning === true

      const providerOpts: Record<string, unknown> = {}
      if (supportsReasoning) providerOpts.reasoningEffort = session.effort
      if (isCodexOAuth) {
        providerOpts.store = false
        providerOpts.instructions = session.systemPrompt
      }

      logger.log(`${stag} streamText: model=${session.model} supportsReasoning=${supportsReasoning} effort=${session.effort} api=${isCodexOAuth ? 'codex-oauth(responses)' : 'responses'} providerOpts=${JSON.stringify(Object.keys(providerOpts))} msgCount=${session.modelMessages.length - 1}`)

      const streamArgs = {
        model: languageModel,
        system: session.systemPrompt,
        messages: session.modelMessages.slice(1),
        tools,
        stopWhen: stepCountIs(25),
        abortSignal: ctrl.signal,
        experimental_context,
        ...(Object.keys(providerOpts).length > 0 ? {
          providerOptions: { openai: providerOpts },
        } : {}),
      } as unknown as Parameters<typeof streamText>[0]
      const result = streamText(streamArgs)

      for await (const part of result.fullStream) {
        if (ctrl.signal.aborted || session.abortController !== ctrl) break
        session.lastEventAt = Date.now()

        switch (part.type) {
          case 'text-delta': {
            if (!session.turnFirstTokenSeen && session.turnStartTime) {
              session.turnFirstTokenSeen = true
              session.metadata.lastTurnFirstTokenMs = Date.now() - session.turnStartTime
              this.send('claude:status', sessionId, { ...session.metadata })
            }
            currentAssistantText += part.text
            this.send('claude:stream', sessionId, { text: part.text })
            break
          }
          case 'reasoning-delta': {
            if (!session.turnFirstTokenSeen && session.turnStartTime) {
              session.turnFirstTokenSeen = true
              session.metadata.lastTurnFirstTokenMs = Date.now() - session.turnStartTime
              this.send('claude:status', sessionId, { ...session.metadata })
            }
            currentThinkingText += part.text
            this.send('claude:stream', sessionId, { thinking: part.text })
            break
          }
          case 'tool-input-start': {
            this.addToolCall(sessionId, {
              id: part.id,
              sessionId,
              toolName: part.toolName,
              input: {},
              status: 'running',
              timestamp: Date.now(),
            })
            break
          }
          case 'tool-call': {
            const existing = session.state.messages.find(m => 'toolName' in m && m.id === part.toolCallId) as ClaudeToolCall | undefined
            if (existing) {
              existing.input = part.input as Record<string, unknown>
              this.send('claude:tool-use', sessionId, existing)
            } else {
              this.addToolCall(sessionId, {
                id: part.toolCallId,
                sessionId,
                toolName: part.toolName,
                input: part.input as Record<string, unknown>,
                status: 'running',
                timestamp: Date.now(),
              })
            }
            break
          }
          case 'tool-result': {
            const out = part.output as Record<string, unknown> | string | undefined
            const denied = typeof out === 'object' && out !== null && (out as Record<string, unknown>).denied === true
            const errorVal = typeof out === 'object' && out !== null ? (out as Record<string, unknown>).error : undefined
            const status: 'completed' | 'error' = denied || errorVal ? 'error' : 'completed'
            const resultText = typeof out === 'string' ? out : safeStringify(out)
            const existing = session.state.messages.find(m => 'toolName' in m && m.id === part.toolCallId) as ClaudeToolCall | undefined
            const planFilePath = typeof out === 'object' && out !== null && typeof out.planFilePath === 'string' ? out.planFilePath : undefined
            this.updateToolCall(sessionId, part.toolCallId, {
              status,
              result: resultText.slice(0, 8000),
              ...(planFilePath ? { input: { ...(existing?.input ?? {}), planFilePath } } : {}),
              ...(denied ? { denied: true, denyReason: typeof errorVal === 'string' ? errorVal : 'User denied' } : {}),
            })
            break
          }
          case 'tool-error': {
            const errText = part.error instanceof Error ? part.error.message : safeStringify(part.error)
            this.updateToolCall(sessionId, part.toolCallId, { status: 'error', result: errText.slice(0, 8000) })
            break
          }
          case 'finish-step': {
            const usage = part.usage
            if (usage) {
              session.metadata.inputTokens += usage.inputTokens ?? 0
              session.metadata.outputTokens += usage.outputTokens ?? 0
              session.metadata.cacheReadTokens += usage.cachedInputTokens ?? 0
            }
            if (currentAssistantText.trim()) {
              this.addMessage(sessionId, {
                id: `asst-${Date.now()}`,
                sessionId,
                role: 'assistant',
                content: currentAssistantText,
                thinking: currentThinkingText || undefined,
                timestamp: Date.now(),
              })
              currentAssistantText = ''
              currentThinkingText = ''
            }
            break
          }
          case 'finish': {
            if (currentAssistantText.trim()) {
              this.addMessage(sessionId, {
                id: `asst-${Date.now()}`,
                sessionId,
                role: 'assistant',
                content: currentAssistantText,
                thinking: currentThinkingText || undefined,
                timestamp: Date.now(),
              })
            }
            session.metadata.durationMs = Date.now() - (session.startTime || turnStart)
            session.metadata.lastTurnDurationMs = Date.now() - turnStart
            const totalTokens = session.metadata.inputTokens + session.metadata.outputTokens
            session.metadata.contextTokens = totalTokens
            this.send('claude:status', sessionId, { ...session.metadata })
            this.send('claude:result', sessionId, {
              subtype: 'result',
              totalCost: session.metadata.totalCost,
              totalTokens,
              result: currentAssistantText || undefined,
            })
            this.send('claude:turn-end', sessionId, {
              reason: 'completed',
              totalCost: session.metadata.totalCost,
              totalTokens,
            })
            notificationCenter.add({
              sessionId,
              profileId: session.ownerProfileId,
              cwd: session.cwd,
              reason: 'completed',
              result: currentAssistantText || undefined,
              agentKind: 'openai',
            })
            break
          }
          case 'error': {
            const msg = stringifyError(part.error)
            logger.error(`${stag} Stream error: ${msg}`)
            this.send('claude:error', sessionId, msg)
            break
          }
          case 'abort': {
            logger.log(`${stag} Abort event`)
            break
          }
        }
      }

      // Capture SDK response messages (includes tool calls/results) for cross-turn memory
      if (!ctrl.signal.aborted && session.abortController === ctrl) {
        try {
          const resp = await result.response
          if (resp.messages?.length) {
            for (const msg of resp.messages) {
              session.modelMessages.push(msg as ModelMessage)
            }
          }
        } catch { /* response may not resolve on edge cases */ }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const roles = session.modelMessages.slice(1).map((m: ModelMessage) => m.role)
        logger.error(`${stag} Turn failed (model=${session.model} msgs=[${roles.join(',')}]):`, err)
        const msg = stringifyError(err)
        this.send('claude:error', sessionId, `OpenAI error: ${msg}`)
        this.send('claude:turn-end', sessionId, { reason: 'error', error: msg })
      } else {
        this.send('claude:turn-end', sessionId, { reason: 'aborted' })
      }
    } finally {
      if (session.abortController === ctrl) {
        session.isRunning = false
        session.state.isStreaming = false
        session.currentPrompt = undefined
        if (ctrl.signal.aborted) {
          session.modelMessages = []
        }
        for (const [, pending] of session.pendingPermissions) {
          pending.resolve(false)
        }
        session.pendingPermissions.clear()
        for (const [toolUseId, pending] of session.pendingAskUsers) {
          pending.resolve({})
          this.send('claude:ask-user-resolved', sessionId, toolUseId)
        }
        session.pendingAskUsers.clear()

        const info = findModel(session.model)
        const totalTokens = session.metadata.inputTokens + session.metadata.outputTokens
        if (info && compactionNeeded({ totalTokens, modelMaxInput: info.contextWindow })) {
          logger.log(`${stag} Auto-compaction triggered at ${totalTokens}/${info.contextWindow} tokens`)
          await this.compactHistory(session, 'auto').catch(() => { /* logged inside */ })
        }

        const next = session.messageQueue.shift()
        if (next) {
          await this.sendMessage(sessionId, next.prompt, next.images, next.suppressUserMessage)
        }
      }
    }

    return true
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.state.isStreaming = false
    session.isRunning = false
    return true
  }

  abortSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.abortController = new AbortController()
    session.state.isStreaming = false
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
    const oldModel = session.model
    const oldCwd = session.cwd
    const newId = newSessionId()
    session.state = { sessionId, messages: [], isStreaming: false }
    session.metadata = { ...this.makeMetadata(oldModel, oldCwd), sdkSessionId: newId }
    session.sdkSessionId = newId
    session.jsonlFile = sessionFilePath(newId, Date.now())
    session.isRunning = false
    session.modelMessages = []
    session.toolApprovedOnce.clear()
    session.pendingPermissions.clear()
    session.pendingAskUsers.clear()
    session.abortController = new AbortController()
    this.send('claude:session-reset', sessionId)
    this.addMessage(sessionId, {
      id: `sys-reset-${Date.now()}`,
      sessionId,
      role: 'system',
      content: 'Session reset.',
      timestamp: Date.now(),
    })
    return true
  }

  restSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.state.isStreaming = false
    session.isRunning = false
    return true
  }
  wakeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController = new AbortController()
    return true
  }
  isResting(_sessionId: string): boolean { return false }

  async resumeSession(sessionId: string, sdkSessionId: string, cwd: string, model?: string, permissionMode?: string, effort?: string, ownerProfileId?: string | null): Promise<boolean> {
    return this.startSession(sessionId, {
      cwd,
      model,
      permissionMode,
      effort,
      resumeSdkSessionId: sdkSessionId,
      ownerProfileId,
    })
  }

  getSessionState(sessionId: string): ClaudeSessionState | null {
    return this.sessions.get(sessionId)?.state ?? null
  }

  getSessionMeta(sessionId: string): Record<string, unknown> | null {
    const session = this.sessions.get(sessionId)
    return session ? { ...session.metadata } : null
  }

  async getSupportedModels(_sessionId: string): Promise<Array<{ value: string; displayName: string; description: string; source: string }>> {
    const hasCodexOAuth = await hasCodexOAuthCredential()
    const models = hasCodexOAuth
      ? OPENAI_MODELS.filter(m => CODEX_CHATGPT_SUPPORTED_MODELS.has(m.value))
      : OPENAI_MODELS.filter(m => !CODEX_CHATGPT_ONLY_MODELS.has(m.value))
    return models.map(m => ({ value: m.value, displayName: m.displayName, description: m.description, source: 'builtin' }))
  }

  setModel(sessionId: string, model: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (session.model === model) return true
    const wasRunning = session.isRunning
    if (wasRunning) session.abortController.abort()
    session.model = model
    session.metadata.model = model
    const info = findModel(model)
    if (info) {
      session.metadata.contextWindow = info.contextWindow
      session.metadata.maxOutputTokens = info.maxOutputTokens
    }
    this.send('claude:status', sessionId, { ...session.metadata })
    this.addMessage(sessionId, {
      id: `sys-model-${Date.now()}`,
      sessionId,
      role: 'system',
      content: wasRunning ? `Model updated to ${model}. Previous turn aborted.` : `Model updated to ${model}.`,
      timestamp: Date.now(),
    })
    return true
  }

  setPermissionMode(sessionId: string, mode: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const valid: OpenAIPermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'bypassPlan']
    if (!valid.includes(mode as OpenAIPermissionMode)) return false
    session.permissionMode = mode as OpenAIPermissionMode
    this.send('claude:modeChange', sessionId, mode)
    return true
  }

  setEffort(sessionId: string, effort: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.effort = effort
    return true
  }

  resolvePermission(sessionId: string, toolUseId: string, result: unknown): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const pending = session.pendingPermissions.get(toolUseId)
    if (!pending) return false
    session.pendingPermissions.delete(toolUseId)
    const ok = Boolean(
      result === true ||
      (typeof result === 'object' && result !== null && ((result as { approved?: boolean }).approved === true || (result as { ok?: boolean }).ok === true || (result as { behavior?: string }).behavior === 'allow')),
    )
    if (ok) session.toolApprovedOnce.add(pending.toolName)
    pending.resolve(ok)
    this.send('claude:permission-resolved', sessionId, toolUseId)
    return true
  }

  resolveAskUser(sessionId: string, toolUseId: string, answers: unknown): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const pending = session.pendingAskUsers.get(toolUseId)
    if (!pending) return false
    session.pendingAskUsers.delete(toolUseId)
    const normalized = answers && typeof answers === 'object'
      ? Object.fromEntries(
        Object.entries(answers as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
      : {}
    pending.resolve(normalized)
    this.send('claude:ask-user-resolved', sessionId, toolUseId)
    return true
  }

  async stopTask(_sessionId: string, _taskId: string): Promise<boolean> { return false }
  async getAccountInfo(_sessionId: string): Promise<null> { return null }
  async getSupportedCommands(_sessionId: string): Promise<[]> { return [] }
  async getSupportedAgents(_sessionId: string): Promise<[]> { return [] }
  async getContextUsage(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const info = findModel(session.model)
    const maxTokens = info?.contextWindow ?? 128_000
    const total = session.metadata.inputTokens + session.metadata.outputTokens
    return {
      categories: [
        { name: 'input', tokens: session.metadata.inputTokens, color: '#3b82f6' },
        { name: 'output', tokens: session.metadata.outputTokens, color: '#22c55e' },
      ],
      totalTokens: total,
      maxTokens,
      percentage: maxTokens > 0 ? (total / maxTokens) * 100 : 0,
      model: session.model,
    }
  }
  async forkSession(_sessionId: string): Promise<null> { return null }
  async fetchSubagentMessages(_sessionId: string, _agentToolUseId: string): Promise<[]> { return [] }
  async getWorktreeStatus(_sessionId: string): Promise<null> { return null }
  async cleanupWorktree(_sessionId: string, _deleteBranch?: boolean): Promise<boolean> { return false }

  async listSessions(_cwd: string): Promise<SessionSummary[]> {
    return listAllSessions()
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

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>
    const nested = obj.error as Record<string, unknown> | undefined
    const msg = nested?.message ?? obj.message
    if (typeof msg === 'string' && msg.trim()) return msg
  }
  try { return JSON.stringify(err) } catch { return String(err) }
}
