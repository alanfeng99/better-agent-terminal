export interface ClaudeMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  kind?: 'auto-continue'
  autoContinue?: { used: number; max: number; prompt: string }
  thinking?: string
  parentToolUseId?: string
  timestamp: number
}

export interface ClaudeToolCall {
  id: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  status: 'running' | 'completed' | 'error'
  result?: string
  description?: string
  denyReason?: string
  denied?: boolean
  isDeferred?: boolean
  parentToolUseId?: string
  timestamp: number
}

export interface ClaudeSessionState {
  sessionId: string
  messages: (ClaudeMessage | ClaudeToolCall)[]
  isStreaming: boolean
  streamingText?: string
  streamingThinking?: string
  totalCost?: number
  totalTokens?: number
}

// Discriminator helper
export function isToolCall(item: ClaudeMessage | ClaudeToolCall): item is ClaudeToolCall {
  return 'toolName' in item
}
