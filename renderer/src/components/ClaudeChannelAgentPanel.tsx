import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { host } from '../host-api'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'
import { EFFORT_LEVELS } from '../types'
import {
  CLAUDE_BUILTIN_MODELS,
  autoCompactWindowForClaudeSelection,
  displayNameForClaudeSelection,
  normalizeClaudeModelSelection,
  sdkModelForClaudeSelection,
} from '../utils/claude-model-presets'
import {
  type ClaudeChannelCapabilities,
  type ClaudeChannelMessage,
  type ClaudeChannelStatus,
  claudeChannelMessageClass,
  isRecord,
  normalizeClaudeChannelMessage,
} from '../utils/claude-channel-events'

interface ClaudeChannelAgentPanelProps {
  sessionId: string
  cwd: string
  isActive: boolean
  workspaceId?: string
  onClose: (id: string) => void
  showUserMsg?: boolean
  showAssistantMsg?: boolean
}

type ClaudeChannelControls = {
  model: string
  permissionMode: string
  effort: string
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'bypassPlan', 'plan'] as const
const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: 'Default',
  acceptEdits: 'Accept edits',
  bypassPermissions: 'Bypass permissions',
  bypassPlan: 'Bypass plan',
  plan: 'Plan mode',
}

function formatChannelTimestamp(timestamp: number): string {
  if (!timestamp) return ''
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function includeCurrentOption(options: readonly string[], current: string): string[] {
  return current && !options.includes(current) ? [current, ...options] : [...options]
}

function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/\r/g, '')
    .trim()
}

export const ClaudeChannelAgentPanel = memo(function ClaudeChannelAgentPanel({
  sessionId,
  cwd,
  isActive,
  workspaceId,
  onClose,
  showUserMsg = true,
  showAssistantMsg = true,
}: Readonly<ClaudeChannelAgentPanelProps>) {
  const [status, setStatus] = useState<ClaudeChannelStatus>('starting')
  const [channelStatus, setChannelStatus] = useState('unknown')
  const [capabilities, setCapabilities] = useState<ClaudeChannelCapabilities | null>(null)
  const [messages, setMessages] = useState<ClaudeChannelMessage[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [restartToken, setRestartToken] = useState(0)
  const [showModelList, setShowModelList] = useState(false)
  const [controls, setControls] = useState<ClaudeChannelControls>({
    model: (() => {
      const terminal = workspaceStore.getState().terminals.find(item => item.id === sessionId)
      return normalizeClaudeModelSelection(terminal?.model || settingsStore.getSettings().defaultClaudeModel) || ''
    })(),
    permissionMode: 'bypassPermissions',
    effort: settingsStore.getSettings().defaultEffort || 'high',
  })
  const listRef = useRef<HTMLDivElement | null>(null)
  const controlsRef = useRef(controls)

  const isDebug = host.debug.isDebugMode === true

  useEffect(() => {
    controlsRef.current = controls
  }, [controls])

  useEffect(() => {
    if (!isDebug) {
      setStatus('error')
      setError('Claude Channel Agent is available only when BAT_DEBUG is enabled.')
      return
    }
    let cancelled = false
    const unsubs = [
      host.claudeChannel.onMessage((payload: unknown) => {
        const message = normalizeClaudeChannelMessage(payload)
        if (!message || message.sessionId !== sessionId) return
        setMessages(prev => {
          if (prev.some(existing => existing.id === message.id)) return prev
          return [...prev, message]
        })
      }),
      host.claudeChannel.onStatus((payload: unknown) => {
        if (!isRecord(payload) || payload.sessionId !== sessionId) return
        if (typeof payload.status === 'string') setStatus(payload.status as ClaudeChannelStatus)
        if (typeof payload.channelStatus === 'string') setChannelStatus(payload.channelStatus)
        if (payload.status === 'error' && typeof payload.error === 'string') setError(sanitizeTerminalText(payload.error))
      }),
    ]

    ;(async () => {
      try {
        setStatus('starting')
        setError(null)
        const detected = await host.claudeChannel.getCapabilities()
        if (cancelled || !isRecord(detected)) return
        const detectedCaps = detected as unknown as ClaudeChannelCapabilities
        setCapabilities(detectedCaps)
        const selected = controlsRef.current
        const options: Record<string, unknown> = { cwd, workspaceId }
        const sdkModel = sdkModelForClaudeSelection(selected.model)
        if (detectedCaps.supportsModel && sdkModel) options.model = sdkModel
        if (detectedCaps.supportsPermissionMode && selected.permissionMode) options.permissionMode = selected.permissionMode
        if (detectedCaps.supportsThinkingEffort && selected.effort) options.effort = selected.effort
        const compactWindow = autoCompactWindowForClaudeSelection(selected.model, settingsStore.getSettings().autoCompactWindow)
        if (detectedCaps.supportsCompactWindow && compactWindow) {
          options.autoCompactWindow = compactWindow
        }
        const result = await host.claudeChannel.startSession(sessionId, options)
        if (cancelled || !isRecord(result)) return
        const caps = isRecord(result.capabilities) ? result.capabilities as unknown as ClaudeChannelCapabilities : null
        if (caps) setCapabilities(caps)
        if (result.ok === false) {
          setStatus('error')
          setError(sanitizeTerminalText(typeof result.error === 'string' ? result.error : caps?.error || 'Claude Channel Agent failed to start.'))
          return
        }
        setStatus(typeof result.status === 'string' ? result.status as ClaudeChannelStatus : 'ready')
        setChannelStatus(typeof result.channelStatus === 'string' ? result.channelStatus : 'connected')
      } catch (err) {
        if (cancelled) return
        setStatus('error')
        setError(sanitizeTerminalText(err instanceof Error ? err.message : String(err)))
      }
    })()

    return () => {
      cancelled = true
      for (const unsub of unsubs) unsub?.()
      void host.claudeChannel.stopSession(sessionId).catch(() => {})
    }
  }, [cwd, isDebug, restartToken, sessionId, workspaceId])

  useEffect(() => {
    if (!isActive) return
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [isActive, messages.length])

  const visibleMessages = useMemo(() => messages.filter(message => {
    if (message.role === 'user') return showUserMsg
    if (message.role === 'assistant') return showAssistantMsg
    return true
  }), [messages, showAssistantMsg, showUserMsg])

  const send = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || isSending || status === 'error') return
    setInput('')
    setIsSending(true)
    setError(null)
    try {
      await host.claudeChannel.sendMessage(sessionId, prompt, `channel-user-${Date.now()}`)
    } catch (err) {
      setError(sanitizeTerminalText(err instanceof Error ? err.message : String(err)))
    } finally {
      setIsSending(false)
    }
  }, [input, isSending, sessionId, status])

  const stop = useCallback(async () => {
    await host.claudeChannel.stopSession(sessionId)
    setStatus('stopped')
    setChannelStatus('disconnected')
  }, [sessionId])

  const restart = useCallback(async () => {
    await host.claudeChannel.stopSession(sessionId).catch(() => {})
    setMessages([])
    setStatus('starting')
    setChannelStatus('connecting')
    setRestartToken(value => value + 1)
  }, [sessionId])

  const setControl = useCallback((key: keyof ClaudeChannelControls, value: string) => {
    setControls(prev => ({ ...prev, [key]: value }))
  }, [])

  const effortOptions = useMemo(() => includeCurrentOption(EFFORT_LEVELS, controls.effort), [controls.effort])
  const currentModelLabel = useMemo(() => displayNameForClaudeSelection(controls.model), [controls.model])
  const currentSdkModel = useMemo(() => sdkModelForClaudeSelection(controls.model) || controls.model, [controls.model])
  const modelOptions = useMemo(() => {
    const seen = new Set<string>()
    return CLAUDE_BUILTIN_MODELS
      .filter(model => {
        if (!model.value || seen.has(model.value)) return false
        seen.add(model.value)
        return true
      })
  }, [])

  const selectModel = useCallback((model: string) => {
    const normalized = normalizeClaudeModelSelection(model) || model
    setControl('model', normalized)
    workspaceStore.updateTerminalModel(sessionId, normalized)
    setShowModelList(false)
  }, [sessionId, setControl])

  const cyclePermissionMode = useCallback(() => {
    const idx = PERMISSION_MODES.indexOf(controls.permissionMode as typeof PERMISSION_MODES[number])
    const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]
    setControl('permissionMode', next)
  }, [controls.permissionMode, setControl])

  const canSend = isDebug && status !== 'error' && status !== 'stopped' && channelStatus === 'connected'
  const statusTitle = [
    `Channel: ${channelStatus}`,
    `Status: ${status}`,
    capabilities?.cliPath ? `Claude CLI: ${capabilities.cliPath}` : null,
    capabilities?.cliVersion ? `Claude ${capabilities.cliVersion}` : null,
  ].filter(Boolean).join('\n')

  return (
    <div
      className="claude-agent-panel claude-channel-panel"
      style={{ '--agent-color': '#f97316' } as CSSProperties}
    >
      <div className="claude-messages-shell">
        <div ref={listRef} className="claude-messages claude-timeline claude-channel-messages">
          {visibleMessages.length === 0 ? (
            <div className="tl-item">
              <div className="tl-dot dot-system" />
              <div className="tl-content claude-message-system">
                Channel messages will appear here after the Claude Code session starts.
              </div>
            </div>
          ) : visibleMessages.map(message => {
            const isUser = message.role === 'user'
            const dotClass = isUser ? 'dot-user' : message.role === 'assistant' ? 'dot-assistant' : 'dot-system'
            const contentClass = isUser ? 'claude-message-user' : message.role === 'assistant' ? 'claude-message-assistant' : 'claude-message-system'
            return (
              <div key={message.id} className={`tl-item claude-channel-message ${claudeChannelMessageClass(message.role)}`}>
                <div className={`tl-dot ${dotClass}`} />
                <div className={`tl-content ${contentClass}`}>
                  {message.text}
                  <span className="claude-msg-time">{formatChannelTimestamp(message.timestamp)}</span>
                </div>
              </div>
            )
          })}
          {error && (
            <div className="tl-item tl-item-system">
              <div className="tl-dot dot-error" />
              <div className="tl-content claude-message-system claude-channel-error-message">
                {error}
                <span className="claude-msg-time">{formatChannelTimestamp(Date.now())}</span>
              </div>
            </div>
          )}
          {status === 'running' && (
            <div className="tl-item">
              <div className="tl-dot dot-thinking" />
              <div className="tl-content claude-thinking">
                <span className="claude-thinking-text">Waiting for channel reply</span>
                <span className="claude-thinking-dots"><span>.</span><span>.</span><span>.</span></span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="claude-input-area claude-channel-input-area">
        <textarea
          className="claude-input claude-channel-input"
          value={input}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          disabled={!canSend}
          placeholder="Type a message... (Enter to send, Shift+Tab to switch mode)"
        />
        <div className="claude-input-footer">
          <div className="claude-input-controls">
            <span
              className={`claude-status-btn claude-mode-${controls.permissionMode}`}
              onClick={cyclePermissionMode}
              title={`Permission: ${controls.permissionMode} (click to cycle; restart applies to the channel session)`}
            >
              {PERMISSION_MODE_LABELS[controls.permissionMode] || controls.permissionMode}
            </span>
            {controls.model && (
              <span
                className="claude-status-btn"
                onClick={() => setShowModelList(true)}
                title={`Model: ${currentModelLabel}${currentSdkModel !== controls.model ? ` (${currentSdkModel})` : ''} (restart applies to the channel session)`}
              >
                {'</>'} {currentModelLabel}
              </span>
            )}
            <select
              className="claude-effort-select"
              value={controls.effort}
              onChange={event => setControl('effort', event.target.value)}
              title="Thinking effort (restart applies to the channel session)"
            >
              {effortOptions.map(level => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
            <span className="claude-status-btn claude-channel-status-btn" title={statusTitle}>
              channel {channelStatus}
            </span>
          </div>
          <div className="claude-input-actions">
            {status === 'running' ? (
              <button
                className="claude-send-btn claude-stop-btn"
                onClick={() => void stop()}
                title="Stop channel session"
              >
                ■
              </button>
            ) : (
            <button
              className="claude-send-btn"
              onClick={() => void send()}
              disabled={!input.trim() || isSending || !canSend}
              title={canSend ? 'Send' : 'Channel is not connected'}
            >
              ▶
            </button>
            )}
          </div>
        </div>
      </div>

      {showModelList && (
        <div className="claude-resume-card">
          <div className="claude-permission-title">Select a model</div>
          <div className="claude-resume-list">
            {modelOptions.map(model => (
              <div
                key={model.value}
                className={`claude-resume-item${model.value === controls.model ? ' active' : ''}`}
                onClick={() => selectModel(model.value)}
              >
                <div className="claude-resume-item-header">
                  <span className="claude-resume-item-id">{model.displayName}</span>
                </div>
                <div className="claude-resume-item-preview">{model.description}</div>
              </div>
            ))}
          </div>
          <div className="claude-permission-hint">Restart applies model changes to the channel session. Esc to cancel.</div>
        </div>
      )}

      <div className="claude-statusline-bar attached">
        <div className="claude-statusline">
          <div className="claude-statusline-left">
            <span className="claude-statusline-item" title={`Panel: ${sessionId}`}>{sessionId.slice(0, 8)}</span>
            {controls.effort && <span className="claude-statusline-item" title={`effort: ${controls.effort}`}>{controls.effort}</span>}
            <span className="claude-statusline-item" title={statusTitle}>{channelStatus}</span>
            <span className="claude-statusline-item claude-statusline-clickable" onClick={restart} title="Restart channel session">restart</span>
          </div>
          <div className="claude-statusline-right">
            <span className="claude-statusline-item">channel</span>
            {capabilities?.cliVersion && <span className="claude-statusline-item">Claude {capabilities.cliVersion}</span>}
          </div>
        </div>
      </div>
    </div>
  )
})
