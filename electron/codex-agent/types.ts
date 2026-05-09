import type { ClaudeMessage, ClaudeSessionState, ClaudeToolCall } from '../../src/types/claude-agent'
import type { CodexEffortLevel } from '../../src/types'
import type { WorktreeInfo } from '../worktree-manager'

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never'

export interface SessionMetadata {
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

export interface QueuedMessage {
  prompt: string
  images?: string[]
}

export interface CodexSessionInstance {
  abortController: AbortController
  state: ClaudeSessionState
  ownerProfileId: string | null
  threadId?: string
  cwd: string
  metadata: SessionMetadata
  codexInstance?: unknown
  thread?: unknown
  worktreeInfo?: WorktreeInfo
  originalCwd?: string
  sandboxMode: CodexSandboxMode
  approvalPolicy: CodexApprovalPolicy
  model?: string
  effort: CodexEffortLevel
  messageQueue: QueuedMessage[]
  currentPrompt?: string
  isResting?: boolean
  isRunning?: boolean
  startTime?: number
  lastEventAt?: number
  turnStartTime?: number
  turnFirstTokenSeen?: boolean
}

export type HistoryItem = ClaudeMessage | ClaudeToolCall
