import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { host } from '../host-api'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'
import type { EnvVariable, TerminalInstance } from '../types'
import { effortLevelForClaudeMode } from '../types'
import {
  autoCompactWindowForClaudeSelection,
  normalizeClaudeModelSelection,
  sdkModelForClaudeSelection,
} from '../utils/claude-model-presets'
import {
  type ClaudeChannelCapabilities,
  type ClaudeChannelEntry,
  type ClaudeChannelStatus,
  type ClaudeChannelUsage,
  claudeChannelMessageClass,
  isRecord,
  normalizeAssistantFrame,
  normalizeClaudeChannelMessage,
  normalizeThinkingFrame,
  normalizeToolResultFrame,
  normalizeToolUseFrame,
  normalizeUsageFrame,
} from '../utils/claude-channel-events'
import { TerminalPanel } from './TerminalPanel'

interface ClaudeCliAgentPanelProps {
  terminal: TerminalInstance
  isActive: boolean
  workspaceId?: string
  onClose: (id: string) => void
  showUserMsg?: boolean
  showAssistantMsg?: boolean
  showToolMsg?: boolean
  showThinkingMsg?: boolean
}

interface ClaudeCliStartResult {
  ok?: boolean
  sessionId?: string
  cliSessionId?: string
  launchMode?: 'resume' | 'session'
  settingsPath?: string
  transcriptPath?: string | null
  cliPath?: string
  nodePath?: string
  cliVersion?: string
  capabilities?: ClaudeChannelCapabilities & Record<string, unknown>
  error?: string
}

const DEFAULT_PTY_COLS = 100
const DEFAULT_PTY_ROWS = 30
const startedClaudeCliAgentTokens = new Set<string>()

function mergeEnvVars(global: EnvVariable[] = [], workspace: EnvVariable[] = []): Record<string, string> {
  const result: Record<string, string> = {}
  for (const env of global) {
    if (env.enabled && env.key) result[env.key] = env.value
  }
  for (const env of workspace) {
    if (env.enabled && env.key) result[env.key] = env.value
  }
  return result
}

function extractErrorMessage(value: unknown, fallback = 'Unknown error'): string {
  if (value instanceof Error) return value.message || fallback
  if (typeof value === 'string' && value) return value
  if (isRecord(value)) {
    if (typeof value.error === 'string' && value.error) return value.error
    if (typeof value.message === 'string' && value.message) return value.message
  }
  return fallback
}

function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/\r/g, '')
    .trim()
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) return ''
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function buildClaudeLaunch(
  cliPath: string,
  settingsPath: string,
  cliSessionId: string,
  launchMode: 'resume' | 'session',
  nodePath: string | undefined,
  options: { model?: string, permissionMode?: string, effort?: string },
  capabilities: Record<string, unknown> | null,
): { command: string, args: string[] } {
  const args = [
    '--settings',
    settingsPath,
    launchMode === 'resume' ? '--resume' : '--session-id',
    cliSessionId,
  ]
  if (capabilities?.supportsModel === true && options.model) args.push('--model', options.model)
  if (capabilities?.supportsPermissionMode === true && options.permissionMode && options.permissionMode !== 'default') {
    args.push('--permission-mode', options.permissionMode)
  }
  if (capabilities?.supportsEffort === true && options.effort) args.push('--effort', options.effort)

  if (/\.js$/i.test(cliPath)) {
    return { command: nodePath || 'node', args: [cliPath, ...args] }
  }
  if (/\.(?:cmd|bat)$/i.test(cliPath)) {
    return { command: 'cmd.exe', args: ['/D', '/C', cliPath, ...args] }
  }
  return { command: cliPath, args }
}

export function ClaudeCliAgentPanel({
  terminal,
  isActive,
  workspaceId,
  onClose,
  showUserMsg = true,
  showAssistantMsg = true,
  showToolMsg = true,
  showThinkingMsg = true,
}: Readonly<ClaudeCliAgentPanelProps>) {
  const startedTokenRef = useRef<string | null>(null)
  const [readySize, setReadySize] = useState<{ cols: number, rows: number } | null>(null)
  const [ptyReady, setPtyReady] = useState(false)
  const [status, setStatus] = useState<ClaudeChannelStatus>('starting')
  const [messages, setMessages] = useState<ClaudeChannelEntry[]>([])
  const [usage, setUsage] = useState<ClaudeChannelUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cliVersion, setCliVersion] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const handleReadySize = useCallback((size: { cols: number, rows: number }) => {
    const cols = Number.isFinite(size.cols) && size.cols > 0 ? Math.floor(size.cols) : DEFAULT_PTY_COLS
    const rows = Number.isFinite(size.rows) && size.rows > 0 ? Math.floor(size.rows) : DEFAULT_PTY_ROWS
    setReadySize(prev => (prev?.cols === cols && prev.rows === rows ? prev : { cols, rows }))
  }, [])

  useEffect(() => {
    const appendEntry = (entry: ClaudeChannelEntry | null) => {
      if (!entry || entry.sessionId !== terminal.id) return
      setMessages(prev => {
        if (prev.some(existing => existing.id === entry.id)) return prev
        return [...prev, entry]
      })
    }
    const unsubs = [
      host.claudeCli.onMessage((payload: unknown) => {
        const message = normalizeClaudeChannelMessage(payload)
        if (!message || message.sessionId !== terminal.id) return
        appendEntry({ ...message, role: message.role })
      }),
      host.claudeCli.onAssistant((payload: unknown) => appendEntry(normalizeAssistantFrame(payload))),
      host.claudeCli.onThinking((payload: unknown) => appendEntry(normalizeThinkingFrame(payload))),
      host.claudeCli.onToolUse((payload: unknown) => appendEntry(normalizeToolUseFrame(payload))),
      host.claudeCli.onToolResult((payload: unknown) => appendEntry(normalizeToolResultFrame(payload))),
      host.claudeCli.onUsage((payload: unknown) => {
        const next = normalizeUsageFrame(payload)
        if (next) setUsage(next)
      }),
      host.claudeCli.onStatus((payload: unknown) => {
        if (!isRecord(payload) || payload.sessionId !== terminal.id) return
        if (typeof payload.status === 'string') setStatus(payload.status as ClaudeChannelStatus)
        if (payload.status === 'error' && typeof payload.error === 'string') {
          setError(sanitizeTerminalText(payload.error))
        }
      }),
    ]
    return () => {
      for (const unsub of unsubs) unsub?.()
    }
  }, [terminal.id])

  useEffect(() => {
    if (!isActive) return
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [isActive, messages.length])

  useEffect(() => {
    const token = `${terminal.id}:${terminal.claudeCliRestartToken ?? 0}`
    setPtyReady(startedClaudeCliAgentTokens.has(token))
  }, [terminal.claudeCliRestartToken, terminal.id])

  useEffect(() => {
    if (!readySize) return
    const token = `${terminal.id}:${terminal.claudeCliRestartToken ?? 0}`
    if (startedTokenRef.current === token || startedClaudeCliAgentTokens.has(token)) {
      startedTokenRef.current = token
      setPtyReady(true)
      return
    }
    startedTokenRef.current = token
    let cancelled = false

    const start = async () => {
      setStatus('starting')
      setError(null)
      const settings = settingsStore.getSettings()
      const workspace = workspaceStore.getState().workspaces.find(w => w.id === terminal.workspaceId)
      const customEnv = mergeEnvVars(settings.globalEnvVars, workspace?.envVars)
      const currentModel = normalizeClaudeModelSelection(terminal.model || settings.defaultClaudeModel) || ''
      const sdkModel = sdkModelForClaudeSelection(currentModel) || currentModel
      const effort = effortLevelForClaudeMode(settings.defaultEffort || 'high')
      const permissionMode = 'default'
      const compactWindow = autoCompactWindowForClaudeSelection(currentModel, settings.autoCompactWindow)
      const options: Record<string, unknown> = {
        cwd: terminal.cwd || workspace?.folderPath || '',
        workspaceId: workspaceId || terminal.workspaceId,
        currentCliSessionId: terminal.claudeCliSessionId || undefined,
        resume: Boolean(terminal.claudeCliSessionId),
        model: sdkModel || undefined,
        permissionMode,
        effort: effort || undefined,
        autoCompactWindow: compactWindow || undefined,
      }
      const started = await host.claudeCli.startSession(terminal.id, options) as ClaudeCliStartResult
      if (cancelled) return
      if (started.ok === false) {
        setStatus('error')
        setError(sanitizeTerminalText(started.error || 'Claude CLI Agent failed to start.'))
        return
      }
      if (!started.settingsPath || !started.cliPath || !started.cliSessionId) {
        throw new Error('Claude CLI Agent start did not return launch details.')
      }
      setCliVersion(started.cliVersion || null)
      workspaceStore.setTerminalClaudeCliSessionId(terminal.id, started.cliSessionId)
      // When the sidecar session already exists (PTY restart), startSession
      // returns a status-shaped result without launchMode. If a transcript
      // already exists for the CLI session id, `--session-id` would collide —
      // resume instead.
      const launchMode: 'resume' | 'session' = started.launchMode === 'resume' || (started.launchMode == null && started.transcriptPath)
        ? 'resume'
        : 'session'
      const launch = buildClaudeLaunch(
        started.cliPath,
        started.settingsPath,
        started.cliSessionId,
        launchMode,
        started.nodePath,
        { model: sdkModel || undefined, permissionMode, effort: effort || undefined },
        started.capabilities || null,
      )
      try {
        await host.pty.create({
          id: terminal.id,
          cwd: terminal.cwd || workspace?.folderPath || '',
          type: 'terminal',
          agentPreset: terminal.agentPreset,
          command: launch.command,
          args: launch.args,
          cols: readySize.cols,
          rows: readySize.rows,
          customEnv: {
            ...customEnv,
            CLAUDE_CODE_NO_FLICKER: '1',
          },
          perTerminalHistory: settings.perTerminalHistory,
          historyKey: terminal.historyKey,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!message.includes('already exists')) throw err
      }
      if (cancelled) return
      startedClaudeCliAgentTokens.add(token)
      setPtyReady(true)
    }

    void start().catch(err => {
      const message = extractErrorMessage(err, 'Claude CLI Agent failed to start.')
      void host.debug.log(`[ClaudeCliAgentPanel] failed to start ${terminal.id}: ${message}`).catch(() => {})
      if (!cancelled) {
        setStatus('error')
        setError(sanitizeTerminalText(message))
      }
    })

    return () => {
      cancelled = true
    }
  }, [
    readySize,
    terminal.agentPreset,
    terminal.claudeCliRestartToken,
    terminal.claudeCliSessionId,
    terminal.cwd,
    terminal.historyKey,
    terminal.id,
    terminal.model,
    terminal.workspaceId,
    workspaceId,
  ])

  useEffect(() => {
    return () => {
      void host.claudeCli.stopSession(terminal.id).catch(() => {})
    }
  }, [terminal.id])

  const visibleMessages = useMemo(() => messages.filter(message => {
    if (message.role === 'user') return showUserMsg
    if (message.role === 'assistant') return showAssistantMsg
    if (message.role === 'tool_use' || message.role === 'tool_result') return showToolMsg
    if (message.role === 'thinking') return showThinkingMsg
    return true
  }), [messages, showAssistantMsg, showThinkingMsg, showToolMsg, showUserMsg])

  return (
    <div className="claude-cli-agent-panel">
      <div className="claude-cli-agent-terminal">
        <TerminalPanel
          terminalId={terminal.id}
          isActive={isActive}
          onClose={onClose}
          agentPreset={terminal.agentPreset}
          ptyReady={ptyReady}
          onReadySize={handleReadySize}
        />
      </div>
      <div className="claude-cli-agent-structured">
        <div ref={listRef} className="claude-messages claude-timeline claude-channel-messages claude-cli-agent-messages">
          {visibleMessages.length === 0 ? (
            <div className="tl-item">
              <div className="tl-dot dot-system" />
              <div className="tl-content claude-message-system">
                Transcript frames will appear here after Claude writes the session JSONL.
              </div>
            </div>
          ) : visibleMessages.map(message => {
            const dotClass = (() => {
              switch (message.role) {
                case 'user': return 'dot-user'
                case 'assistant': return 'dot-assistant'
                case 'tool_use': return 'dot-tool-use'
                case 'tool_result': return message.isError ? 'dot-error' : 'dot-tool-result'
                case 'thinking': return 'dot-thinking'
                default: return 'dot-system'
              }
            })()
            const contentClass = (() => {
              switch (message.role) {
                case 'user': return 'claude-message-user'
                case 'assistant': return 'claude-message-assistant'
                case 'tool_use': return 'claude-message-tool-use'
                case 'tool_result': return `claude-message-tool-result${message.isError ? ' claude-message-tool-result-error' : ''}`
                case 'thinking': return 'claude-message-thinking'
                default: return 'claude-message-system'
              }
            })()
            let body: JSX.Element | string
            if (message.role === 'tool_use') {
              let inputPreview = ''
              if (message.toolInput != null) {
                try {
                  const text = typeof message.toolInput === 'string'
                    ? message.toolInput
                    : JSON.stringify(message.toolInput)
                  inputPreview = text.length > 160 ? `${text.slice(0, 160)}...` : text
                } catch {
                  inputPreview = String(message.toolInput)
                }
              }
              body = (
                <>
                  <span className="claude-tool-name">tool {message.toolName || 'tool'}</span>
                  {inputPreview && <span className="claude-tool-input"> {inputPreview}</span>}
                </>
              )
            } else if (message.role === 'tool_result') {
              const preview = message.text.length > 240 ? `${message.text.slice(0, 240)}...` : message.text
              body = (
                <>
                  <span className="claude-tool-result-label">{message.isError ? 'tool error' : 'tool result'}</span>
                  {preview && <span className="claude-tool-result-preview"> {preview}</span>}
                </>
              )
            } else if (message.role === 'thinking') {
              body = (
                <>
                  <span className="claude-thinking-label">thinking</span>
                  <span className="claude-thinking-preview"> {message.text}</span>
                </>
              )
            } else {
              body = message.text
            }
            return (
              <div key={message.id} className={`tl-item claude-channel-message ${claudeChannelMessageClass(message.role)}`}>
                <div className={`tl-dot ${dotClass}`} />
                <div className={`tl-content ${contentClass}`}>
                  {body}
                  <span className="claude-msg-time">{formatTimestamp(message.timestamp)}</span>
                </div>
              </div>
            )
          })}
          {error && (
            <div className="tl-item tl-item-system">
              <div className="tl-dot dot-error" />
              <div className="tl-content claude-message-system claude-channel-error-message">
                {error}
                <span className="claude-msg-time">{formatTimestamp(Date.now())}</span>
              </div>
            </div>
          )}
        </div>
        <div className="claude-statusline-bar attached">
          <div className="claude-statusline">
            <div className="claude-statusline-left">
              <span className="claude-statusline-item" title={`Panel: ${terminal.id}`}>{terminal.id.slice(0, 8)}</span>
              <span className="claude-statusline-item">Subscription (CLI)</span>
              <span className="claude-statusline-item">{status}</span>
            </div>
            <div className="claude-statusline-right">
              {usage && (usage.inputTokens != null || usage.outputTokens != null) && (
                <span className="claude-statusline-item" title={[
                  usage.model ? `model: ${usage.model}` : null,
                  usage.inputTokens != null ? `in: ${usage.inputTokens}` : null,
                  usage.outputTokens != null ? `out: ${usage.outputTokens}` : null,
                  usage.cacheReadInputTokens != null ? `cache read: ${usage.cacheReadInputTokens}` : null,
                  usage.cacheCreationInputTokens != null ? `cache write: ${usage.cacheCreationInputTokens}` : null,
                ].filter(Boolean).join('\n')}>
                  {`in ${usage.inputTokens ?? 0} / out ${usage.outputTokens ?? 0}`}
                </span>
              )}
              {cliVersion && <span className="claude-statusline-item">Claude {cliVersion}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
