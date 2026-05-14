import { useEffect, useRef } from 'react'
import { host } from '../host-api'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'
import type { EnvVariable, TerminalInstance } from '../types'
import type { AgentPresetId } from '../types/agent-presets'
import { TerminalPanel } from './TerminalPanel'

interface ClaudeCliPanelProps {
  terminal: TerminalInstance
  isActive: boolean
  onClose: (id: string) => void
  workspaceId?: string
}

interface ClaudeCliPrepareResult {
  sessionId: string
  launchMode: 'resume' | 'session'
  settingsPath: string
  cliPath?: string
}

interface WorktreeCreateResult {
  success?: boolean
  worktreePath?: string
  branchName?: string
  error?: string
}

const startedClaudeCliTokens = new Set<string>()

async function getShellFromSettings(): Promise<string | undefined> {
  const settings = settingsStore.getSettings()
  if (settings.shell === 'custom' && settings.customShellPath) {
    return settings.customShellPath
  }
  return host.settings.getShellPath(settings.shell)
}

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

function isPowerShellShell(shell?: string): boolean {
  return !!shell && /(?:^|[\\/])(pwsh|powershell)(?:\.exe)?$/i.test(shell)
}

function quoteArg(value: string, shell?: string): string {
  if (isPowerShellShell(shell)) {
    return `"${value.replace(/`/g, '``').replace(/"/g, '`"')}"`
  }
  return `"${value.replace(/"/g, '\\"')}"`
}

function buildClaudeCommand(
  cliPath: string,
  settingsPath: string,
  sessionId: string,
  launchMode: 'resume' | 'session',
  shell: string | undefined,
  allowBypassPermissions: boolean,
): string {
  const isLegacyJs = /\.js$/i.test(cliPath)
  const isPowerShell = isPowerShellShell(shell)
  const cmdParts: string[] = []
  if (isLegacyJs) {
    cmdParts.push('node', quoteArg(cliPath, shell))
  } else if (isPowerShell) {
    cmdParts.push('&', quoteArg(cliPath, shell))
  } else {
    cmdParts.push(quoteArg(cliPath, shell))
  }
  cmdParts.push('--settings', quoteArg(settingsPath, shell))
  cmdParts.push(launchMode === 'resume' ? '--resume' : '--session-id', quoteArg(sessionId, shell))
  if (allowBypassPermissions) {
    cmdParts.push('--dangerously-skip-permissions')
  }
  return cmdParts.join(' ')
}

function isClaudeCliPreset(value: TerminalInstance['agentPreset']): value is 'claude-cli' | 'claude-cli-worktree' {
  return value === 'claude-cli' || value === 'claude-cli-worktree'
}

export function ClaudeCliPanel({ terminal, isActive, onClose, workspaceId }: Readonly<ClaudeCliPanelProps>) {
  const startedTokenRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isClaudeCliPreset(terminal.agentPreset)) return
    const token = `${terminal.id}:${terminal.claudeCliRestartToken ?? 0}`
    if (startedTokenRef.current === token || startedClaudeCliTokens.has(token)) {
      startedTokenRef.current = token
      return
    }
    startedTokenRef.current = token
    let cancelled = false

    const start = async () => {
      const settings = settingsStore.getSettings()
      const workspace = workspaceStore.getState().workspaces.find(w => w.id === terminal.workspaceId)
      const shell = await getShellFromSettings()
      const customEnv = mergeEnvVars(settings.globalEnvVars, workspace?.envVars)
      const preset = terminal.agentPreset as AgentPresetId
      const isWorktree = preset === 'claude-cli-worktree'
      let effectiveCwd = terminal.worktreePath || terminal.cwd || workspace?.folderPath || ''

      if (isWorktree && !terminal.worktreePath) {
        const wtResult = await host.worktree.create(
          terminal.id,
          terminal.cwd || workspace?.folderPath || effectiveCwd,
          settings.worktreePnpmInstallEnabled === true,
        ) as WorktreeCreateResult
        if (cancelled) return
        if (!wtResult.success || !wtResult.worktreePath) {
          alert(wtResult.error || 'Failed to create Claude CLI worktree.')
          return
        }
        effectiveCwd = wtResult.worktreePath
        workspaceStore.updateTerminalCwd(terminal.id, wtResult.worktreePath)
        workspaceStore.setTerminalWorktreeInfo(terminal.id, wtResult.worktreePath, wtResult.branchName)
        workspaceStore.setTerminalGeneratedTitle(terminal.id, 'Claude CLI (worktree)')
      }

      const prepared = await host.claude.prepareCliSession(
        terminal.id,
        workspaceId || terminal.workspaceId,
        effectiveCwd,
        preset,
        terminal.claudeCliSessionId,
      ) as ClaudeCliPrepareResult
      if (cancelled) return

      workspaceStore.setTerminalClaudeCliSessionId(terminal.id, prepared.sessionId)
      try {
        await host.pty.create({
          id: terminal.id,
          cwd: effectiveCwd,
          type: 'terminal',
          agentPreset: preset,
          shell,
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

      const cliPath = prepared.cliPath || await host.claude.getCliPath()
      const command = buildClaudeCommand(
        String(cliPath),
        prepared.settingsPath,
        prepared.sessionId,
        prepared.launchMode,
        shell,
        settings.allowBypassPermissions,
      )
      window.setTimeout(() => {
        if (!cancelled) {
          startedClaudeCliTokens.add(token)
          host.pty.write(terminal.id, command + '\r')
        }
      }, 500)
    }

    void start().catch(err => {
      const message = err instanceof Error ? err.message : String(err)
      void host.debug.log(`[ClaudeCliPanel] failed to start ${terminal.id}: ${message}`).catch(() => {})
    })

    return () => {
      cancelled = true
    }
  }, [
    terminal.id,
    terminal.agentPreset,
    terminal.claudeCliRestartToken,
    terminal.claudeCliSessionId,
    terminal.cwd,
    terminal.historyKey,
    terminal.worktreePath,
    terminal.workspaceId,
    workspaceId,
  ])

  return (
    <TerminalPanel
      terminalId={terminal.id}
      isActive={isActive}
      onClose={onClose}
      agentPreset={terminal.agentPreset}
    />
  )
}
