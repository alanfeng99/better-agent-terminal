export type ClaudeChannelStatus = 'starting' | 'ready' | 'running' | 'stopped' | 'error'

export interface ClaudeChannelMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  status?: string
  timestamp: number
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

export function normalizeClaudeChannelMessage(value: unknown): ClaudeChannelMessage | null {
  if (!isRecord(value)) return null
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
  const role = value.role === 'user' || value.role === 'assistant' || value.role === 'system'
    ? value.role
    : 'system'
  return {
    id: typeof value.id === 'string' ? value.id : `channel-message-${Date.now()}`,
    sessionId,
    role,
    text: typeof value.text === 'string' ? value.text : '',
    status: typeof value.status === 'string' ? value.status : undefined,
    timestamp: typeof value.timestamp === 'number' ? value.timestamp : Date.now(),
  }
}

export function claudeChannelMessageClass(role: ClaudeChannelMessage['role']): string {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return 'system'
}
