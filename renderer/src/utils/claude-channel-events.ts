export type ClaudeChannelStatus = 'starting' | 'ready' | 'running' | 'stopped' | 'error'

export type ClaudeChannelEntryRole = 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' | 'thinking'

// One unified entry the panel renders in timeline order. Assistant text,
// tool calls, and tool results all become entries; usage and status are
// header telemetry and don't appear here.
export interface ClaudeChannelEntry {
  id: string
  sessionId: string
  role: ClaudeChannelEntryRole
  text: string
  status?: string
  toolUseId?: string
  toolName?: string
  toolInput?: unknown
  isError?: boolean
  inReplyTo?: string | null
  timestamp: number
}

// Legacy shape kept for the existing :message listener path. Subset of
// ClaudeChannelEntry restricted to the user/assistant/system roles.
export interface ClaudeChannelMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  status?: string
  timestamp: number
}

export interface ClaudeChannelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  model?: string
  costUsd?: number
}

export interface ClaudeChannelCapabilities {
  supported: boolean
  cliPath?: string | null
  cliVersion: string | null
  supportsChannels: boolean
  supportsModel: boolean
  supportsPermissionMode: boolean
  supportsThinkingEffort: boolean
  supportsCompactWindow: boolean
  supportsStopTask: boolean
  supportsStreaming: boolean
  error?: string | null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function normalizeClaudeChannelMessage(value: unknown): ClaudeChannelMessage | null {
  if (!isRecord(value)) return null
  const sessionId = asString(value.sessionId)
  const role = value.role === 'user' || value.role === 'assistant' || value.role === 'system'
    ? value.role
    : 'system'
  return {
    id: asString(value.id) || `channel-message-${Date.now()}`,
    sessionId,
    role,
    text: asString(value.text),
    status: asOptionalString(value.status),
    timestamp: asOptionalNumber(value.timestamp) ?? Date.now(),
  }
}

function payloadOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  if (isRecord(value.payload)) return value.payload
  return {}
}

export function normalizeAssistantFrame(value: unknown): ClaudeChannelEntry | null {
  if (!isRecord(value)) return null
  const sessionId = asString(value.sessionId)
  const text = asString(value.text)
  if (!sessionId) return null
  return {
    id: asString(value.id) || `channel-assistant-${Date.now()}`,
    sessionId,
    role: 'assistant',
    text,
    status: asOptionalString(value.status),
    inReplyTo: asOptionalString(value.inReplyTo) ?? null,
    timestamp: asOptionalNumber(value.timestamp) ?? Date.now(),
  }
}

export function normalizeToolUseFrame(value: unknown): ClaudeChannelEntry | null {
  if (!isRecord(value)) return null
  const sessionId = asString(value.sessionId)
  const payload = payloadOf(value)
  const toolUseId = asString(payload.id)
  const name = asString(payload.name)
  if (!sessionId || !toolUseId || !name) return null
  return {
    id: `tool-use-${toolUseId}`,
    sessionId,
    role: 'tool_use',
    text: '',
    toolUseId,
    toolName: name,
    toolInput: payload.input,
    inReplyTo: asOptionalString(value.inReplyTo) ?? null,
    timestamp: asOptionalNumber(value.timestamp) ?? Date.now(),
  }
}

export function normalizeToolResultFrame(value: unknown): ClaudeChannelEntry | null {
  if (!isRecord(value)) return null
  const sessionId = asString(value.sessionId)
  const payload = payloadOf(value)
  const toolUseId = asString(payload.tool_use_id)
  if (!sessionId || !toolUseId) return null
  const content = payload.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (content != null) {
    try { text = JSON.stringify(content) } catch { text = String(content) }
  }
  return {
    id: `tool-result-${toolUseId}`,
    sessionId,
    role: 'tool_result',
    text,
    toolUseId,
    isError: asOptionalBoolean(payload.is_error) ?? false,
    inReplyTo: asOptionalString(value.inReplyTo) ?? null,
    timestamp: asOptionalNumber(value.timestamp) ?? Date.now(),
  }
}

export function normalizeThinkingFrame(value: unknown): ClaudeChannelEntry | null {
  if (!isRecord(value)) return null
  const sessionId = asString(value.sessionId)
  const payload = payloadOf(value)
  const text = asString(payload.text)
  if (!sessionId || !text) return null
  return {
    id: asString(payload.id) || `thinking-${Date.now()}`,
    sessionId,
    role: 'thinking',
    text,
    status: asOptionalString(payload.status),
    inReplyTo: asOptionalString(value.inReplyTo) ?? null,
    timestamp: asOptionalNumber(value.timestamp) ?? Date.now(),
  }
}

export function normalizeUsageFrame(value: unknown): ClaudeChannelUsage | null {
  if (!isRecord(value)) return null
  const payload = payloadOf(value)
  return {
    inputTokens: asOptionalNumber(payload.input_tokens),
    outputTokens: asOptionalNumber(payload.output_tokens),
    cacheReadInputTokens: asOptionalNumber(payload.cache_read_input_tokens),
    cacheCreationInputTokens: asOptionalNumber(payload.cache_creation_input_tokens),
    model: asOptionalString(payload.model),
    costUsd: asOptionalNumber(payload.cost_usd),
  }
}

export function claudeChannelMessageClass(role: ClaudeChannelEntry['role']): string {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  if (role === 'tool_use') return 'tool-use'
  if (role === 'tool_result') return 'tool-result'
  if (role === 'thinking') return 'thinking'
  return 'system'
}
