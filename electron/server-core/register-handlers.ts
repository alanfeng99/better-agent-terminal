import path from 'path'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import os from 'os'
import { exec as execCallback, execFile as execFileCallback } from 'child_process'
import { promisify } from 'util'
import { logger } from '../logger'

// Sync child_process calls (execSync/execFileSync) block Node's event loop.
// In Electron the renderer is a separate process, but in headless bat-server
// the WebSocket loop shares this event loop — a slow git command would freeze
// the entire server. Always use these async variants for shelling out.
const execAsync = promisify(execCallback)
const execFileAsync = promisify(execFileCallback)
import { isSensitivePath } from '../path-guard'
import { registerHandler } from '../remote/handler-registry'
import { broadcastHub } from '../remote/broadcast-hub'
import { snippetDb, type CreateSnippetInput } from '../snippet-db'
import { accountManager } from '../account-manager'
import { worktreeManager } from '../worktree-manager'
import { ClaudeAgentManager } from '../claude-agent-manager'
import { CodexAgentManager } from '../codex-agent-manager'
import { hasOpenAIKey, setOpenAIKey, clearOpenAIKey } from '../openai-agent/api-key'
import { detectCx } from '../semantic-navigation'
import type { WindowRegistry } from '../window-registry'
import type { ProfileManager } from '../profile-manager'
import type { EffortLevel, CreatePtyOptions } from '../../src/types'
import { AGENT_PRESETS } from '../../src/types/agent-presets'
import type { PtyManager } from '../pty-manager'
import { getDataDir } from './data-dir'

// On Linux, prefer the variant matching the current libc. npm may install
// both musl and glibc optionalDependencies in some setups; picking the wrong
// binary (e.g. musl on Ubuntu) crashes at exec. Detect glibc via node's
// process.report; fall back to glibc-first ordering if detection fails
// (matches the pre-regression behavior for typical desktop Linux).
function linuxClaudeArchCandidates(): string[] {
  const arch = process.arch
  let isGlibc: boolean | null = null
  try {
    const report = (process as unknown as { report?: { getReport: () => { header?: { glibcVersionRuntime?: string } } } }).report
    const header = report?.getReport()?.header
    if (header && 'glibcVersionRuntime' in header) {
      isGlibc = !!header.glibcVersionRuntime
    }
  } catch { /* ignore */ }
  if (isGlibc === false) return [`linux-${arch}-musl`, `linux-${arch}`]
  return [`linux-${arch}`, `linux-${arch}-musl`]
}

function getPosixAutoShell(): string {
  if (process.env.SHELL && fsSync.existsSync(process.env.SHELL)) {
    return process.env.SHELL
  }
  if (process.platform === 'darwin') {
    return '/bin/zsh'
  }
  if (fsSync.existsSync('/bin/bash')) {
    return '/bin/bash'
  }
  return '/bin/sh'
}

export interface ProxiedHandlersDeps {
  getPtyManager: () => PtyManager | null
  getClaudeManager: () => ClaudeAgentManager | null
  getCodexManager: () => CodexAgentManager | null
  sessionManagerMap: Map<string, 'claude' | 'codex'>
  windowRegistry: WindowRegistry
  profileManager: ProfileManager
}

export function registerProxiedHandlers(deps: ProxiedHandlersDeps): void {
  const {
    getPtyManager,
    getClaudeManager,
    getCodexManager,
    sessionManagerMap,
    windowRegistry,
    profileManager,
  } = deps

  const MESSAGE_ARCHIVE_DIR = path.join(getDataDir(), 'message-archives')

  // PTY
  registerHandler('pty:create', (_ctx, options: unknown) => getPtyManager()?.create(options as CreatePtyOptions))
  registerHandler('pty:write', (_ctx, id: string, data: string) => getPtyManager()?.write(id, data))
  registerHandler('pty:resize', (_ctx, id: string, cols: number, rows: number) => {
    logger.log(`[resize] pty:resize id=${id} cols=${cols} rows=${rows}`)
    return getPtyManager()?.resize(id, cols, rows)
  })
  registerHandler('pty:kill', (_ctx, id: string) => getPtyManager()?.kill(id))
  registerHandler('pty:restart', (_ctx, id: string, cwd: string, shellPath?: string) => getPtyManager()?.restart(id, cwd, shellPath))
  registerHandler('pty:get-cwd', (_ctx, id: string) => getPtyManager()?.getCwd(id))

  // Workspace persistence — save/load from window registry entry
  registerHandler('workspace:save', async (ctx, data: string) => {
    if (!ctx.windowId) return false
    const parsed = JSON.parse(data)
    const entry = await windowRegistry.getEntry(ctx.windowId)
    if (!entry) return false
    entry.workspaces = parsed.workspaces || []
    entry.activeWorkspaceId = parsed.activeWorkspaceId || null
    entry.activeGroup = parsed.activeGroup || null
    entry.terminals = parsed.terminals || []
    entry.activeTerminalId = parsed.activeTerminalId || null
    entry.lastActiveAt = Date.now()
    await windowRegistry.saveEntry(entry)
    // Also persist to profile snapshot so force-quit doesn't lose state
    if (entry.profileId) {
      profileManager.save(entry.profileId).catch(() => { /* ignore */ })
    }
    broadcastHub.broadcast('workspace:reload', JSON.stringify({
      workspaces: entry.workspaces,
      activeWorkspaceId: entry.activeWorkspaceId,
      activeGroup: entry.activeGroup,
      terminals: entry.terminals,
      activeTerminalId: entry.activeTerminalId,
    }))
    return true
  })
  registerHandler('workspace:load', async (ctx) => {
    if (!ctx.windowId) return null
    const entry = await windowRegistry.getEntry(ctx.windowId)
    if (!entry) return null
    return JSON.stringify({
      workspaces: entry.workspaces,
      activeWorkspaceId: entry.activeWorkspaceId,
      activeGroup: entry.activeGroup,
      terminals: entry.terminals,
      activeTerminalId: entry.activeTerminalId,
    })
  })

  // Settings persistence
  registerHandler('settings:save', async (_ctx, data: string) => {
    const configPath = path.join(getDataDir(), 'settings.json')
    await fs.writeFile(configPath, data, 'utf-8')
    return true
  })
  registerHandler('settings:load', async (_ctx) => {
    const configPath = path.join(getDataDir(), 'settings.json')
    try { return await fs.readFile(configPath, 'utf-8') } catch { return null }
  })
  registerHandler('settings:detect-cx', () => detectCx())
  registerHandler('settings:clear-terminal-history', async () => {
    const historyDir = path.join(getDataDir(), 'terminal-history')
    try {
      const entries = await fs.readdir(historyDir)
      for (const entry of entries) {
        if (entry === '.zsh-wrapper') continue
        await fs.rm(path.join(historyDir, entry), { recursive: true, force: true })
      }
      return true
    } catch {
      return true
    }
  })
  const shellPathCache = new Map<string, string>()
  registerHandler('settings:get-shell-path', (_ctx, shellType: string) => {
    const cached = shellPathCache.get(shellType)
    if (cached) return cached

    let result: string
    if (process.platform === 'darwin' || process.platform === 'linux') {
      if (shellType === 'auto') result = getPosixAutoShell()
      else if (shellType === 'zsh') result = '/bin/zsh'
      else if (shellType === 'bash') {
        if (fsSync.existsSync('/opt/homebrew/bin/bash')) result = '/opt/homebrew/bin/bash'
        else if (fsSync.existsSync('/usr/local/bin/bash')) result = '/usr/local/bin/bash'
        else result = '/bin/bash'
      }
      else if (shellType === 'sh') result = '/bin/sh'
      else if (shellType === 'pwsh' || shellType === 'powershell' || shellType === 'cmd') result = getPosixAutoShell()
      else result = shellType
    } else {
      if (shellType === 'auto' || shellType === 'pwsh') {
        const pwshPaths = [
          'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
          process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\pwsh.exe'
        ]
        let found = ''
        for (const p of pwshPaths) { if (fsSync.existsSync(p)) { found = p; break } }
        if (found) result = found
        else if (shellType === 'pwsh') result = 'pwsh.exe'
        else if (shellType === 'auto' || shellType === 'powershell') result = 'powershell.exe'
        else if (shellType === 'cmd') result = 'cmd.exe'
        else result = shellType
      }
      else if (shellType === 'powershell') result = 'powershell.exe'
      else if (shellType === 'cmd') result = 'cmd.exe'
      else result = shellType
    }

    shellPathCache.set(shellType, result)
    return result
  })

  // Get bundled Claude CLI path for claude-cli preset.
  // Returns the agent presets this host knows about. The client uses this to
  // filter its own UI so a remote host running an older BAT version doesn't
  // show presets it can't actually handle. Local mode answers the same way as
  // remote, so the client doesn't need to branch on connection state.
  registerHandler('agent:list-presets', () => AGENT_PRESETS.map(p => p.id))

  // Since claude-code v2.1.113, the package ships a native binary placed by
  // postinstall from a per-platform optionalDependency. install.cjs writes
  // it to bin/claude.exe on EVERY platform (the .exe is literal filename on
  // Unix). Platform packages still hold the unsuffixed name on Unix.
  registerHandler('claude:get-cli-path', () => {
    const platformPkgBin = process.platform === 'win32' ? 'claude.exe' : 'claude'
    const archKey = process.platform === 'linux'
      ? linuxClaudeArchCandidates()
      : [`${process.platform}-${process.arch}`]

    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    if (resourcesPath) {
      for (const key of archKey) {
        const packagedPath = path.join(
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
    for (const spec of candidates) {
      try {
        let resolved = require.resolve(spec)
        if (resolved.includes('app.asar') && !resolved.includes('app.asar.unpacked')) {
          resolved = resolved.replace('app.asar', 'app.asar.unpacked')
        }
        return resolved
      } catch { /* try next */ }
    }
    return ''
  })

  // Session manager dispatcher: routes to Claude / Codex manager based on agentPreset.
  // OpenAI Direct is retired; legacy openai-agent requests are normalized to Codex.
  function getManager(sessionId: string): ClaudeAgentManager | CodexAgentManager | null {
    const type = sessionManagerMap.get(sessionId)
    if (type === 'codex') return getCodexManager()
    return getClaudeManager()
  }

  // Claude Agent SDK
  registerHandler('claude:start-session', async (ctx, sessionId: string, options: { cwd: string; prompt?: string; permissionMode?: string; model?: string; effort?: string; apiVersion?: 'v1' | 'v2'; useWorktree?: boolean; worktreePath?: string; worktreeBranch?: string; autoCompactWindow?: number; agentPreset?: string; codexSandboxMode?: string; codexApprovalPolicy?: string }) => {
    const ownerProfileId = ctx.windowId ? (await windowRegistry.getEntry(ctx.windowId))?.profileId ?? null : null
    const startOptions = { ...options, ownerProfileId }
    if (options.agentPreset === 'codex-agent' || options.agentPreset === 'codex-agent-worktree' || options.agentPreset === 'openai-agent') {
      sessionManagerMap.set(sessionId, 'codex')
      return getCodexManager()?.startSession(sessionId, { ...startOptions, agentPreset: 'codex-agent' })
    }
    sessionManagerMap.set(sessionId, 'claude')
    return getClaudeManager()?.startSession(sessionId, startOptions)
  })
  registerHandler('claude:send-message', (_ctx, sessionId: string, prompt: string, images?: string[], autoCompactWindow?: number | null) => {
    const mgr = getManager(sessionId)
    if (mgr instanceof ClaudeAgentManager) return mgr.sendMessage(sessionId, prompt, images, autoCompactWindow)
    return mgr?.sendMessage(sessionId, prompt, images)
  })
  registerHandler('claude:stop-session', (_ctx, sessionId: string) => getManager(sessionId)?.stopSession(sessionId))
  registerHandler('claude:abort-session', (_ctx, sessionId: string) => getManager(sessionId)?.abortSession(sessionId))
  registerHandler('claude:set-permission-mode', (_ctx, sessionId: string, mode: string) => getManager(sessionId)?.setPermissionMode(sessionId, mode as import('@anthropic-ai/claude-agent-sdk').PermissionMode))
  registerHandler('claude:set-codex-sandbox-mode', (_ctx, sessionId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access') => {
    const mgr = getManager(sessionId)
    return (mgr as CodexAgentManager)?.setSandboxMode?.(sessionId, mode) ?? false
  })
  registerHandler('claude:set-codex-approval-policy', (_ctx, sessionId: string, policy: 'untrusted' | 'on-request' | 'never') => {
    const mgr = getManager(sessionId)
    return (mgr as CodexAgentManager)?.setApprovalPolicy?.(sessionId, policy) ?? false
  })
  registerHandler('claude:set-model', (_ctx, sessionId: string, model: string, autoCompactWindow?: number) => {
    const mgr = getManager(sessionId)
    if (mgr instanceof ClaudeAgentManager) return mgr.setModel(sessionId, model, autoCompactWindow)
    return (mgr as CodexAgentManager)?.setModel(sessionId, model)
  })
  registerHandler('claude:set-effort', (_ctx, sessionId: string, effort: string) => getManager(sessionId)?.setEffort(sessionId, effort as EffortLevel))
  registerHandler('claude:reset-session', (_ctx, sessionId: string) => getManager(sessionId)?.resetSession(sessionId))
  registerHandler('claude:set-auto-continue', (_ctx, sessionId: string, opts: { enabled: boolean; max?: number; prompt?: string }) => {
    const mgr = getManager(sessionId)
    if (mgr instanceof ClaudeAgentManager) return mgr.setAutoContinue(sessionId, opts)
    return false
  })
  registerHandler('claude:get-auto-continue', (_ctx, sessionId: string) => {
    const mgr = getManager(sessionId)
    if (mgr instanceof ClaudeAgentManager) return mgr.getAutoContinue(sessionId)
    return null
  })
  registerHandler('claude:get-supported-models', (_ctx, sessionId: string) => getManager(sessionId)?.getSupportedModels(sessionId))
  registerHandler('claude:get-account-info', (_ctx, sessionId: string) => getManager(sessionId)?.getAccountInfo(sessionId))
  registerHandler('claude:get-supported-commands', (_ctx, sessionId: string) => getManager(sessionId)?.getSupportedCommands(sessionId))
  registerHandler('claude:get-supported-agents', (_ctx, sessionId: string) => getManager(sessionId)?.getSupportedAgents(sessionId))
  registerHandler('claude:get-worktree-status', (_ctx, sessionId: string) => getManager(sessionId)?.getWorktreeStatus(sessionId))
  registerHandler('claude:cleanup-worktree', (_ctx, sessionId: string, deleteBranch: boolean) => getManager(sessionId)?.cleanupWorktree(sessionId, deleteBranch))
  // Standalone worktree operations (for claude-cli preset, not tied to SDK session)
  registerHandler('worktree:create', async (_ctx, sessionId: string, cwd: string) => {
    try {
      const info = await worktreeManager.createWorktree(sessionId, cwd)
      return { success: true, ...info }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  registerHandler('worktree:remove', async (_ctx, sessionId: string, deleteBranch: boolean) => {
    try {
      await worktreeManager.removeWorktree(sessionId, deleteBranch)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  registerHandler('worktree:status', async (_ctx, sessionId: string) => {
    return worktreeManager.getWorktreeStatus(sessionId)
  })
  registerHandler('worktree:merge', async (_ctx, sessionId: string, strategy: 'merge' | 'cherry-pick') => {
    return worktreeManager.mergeWorktree(sessionId, strategy)
  })
  registerHandler('worktree:rehydrate', (_ctx, sessionId: string, cwd: string, worktreePath: string, branchName: string) => {
    worktreeManager.rehydrate(sessionId, cwd, worktreePath, branchName)
    return { success: true }
  })

  // claude auth login — open browser-based login flow
  registerHandler('claude:auth-login', async () => {
    const { execFile } = await import('child_process')
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      execFile('claude', ['auth', 'login'], { timeout: 60000 }, (err) => {
        if (err) {
          logger.error('[auth-login]', err)
          resolve({ success: false, error: err.message })
        } else {
          resolve({ success: true })
        }
      })
    })
  })

  // claude auth status — get current auth info
  registerHandler('claude:auth-status', async () => {
    const { execFile } = await import('child_process')
    return new Promise<{ loggedIn: boolean; email?: string; subscriptionType?: string; authMethod?: string } | null>((resolve) => {
      execFile('claude', ['auth', 'status'], { timeout: 10000 }, (err, stdout) => {
        if (err) {
          logger.error('[auth-status]', err)
          resolve(null)
        } else {
          try {
            resolve(JSON.parse(stdout))
          } catch {
            resolve(null)
          }
        }
      })
    })
  })

  // claude auth logout
  registerHandler('claude:auth-logout', async () => {
    const { execFile } = await import('child_process')
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      execFile('claude', ['auth', 'logout'], { timeout: 10000 }, (err) => {
        if (err) {
          logger.error('[auth-logout]', err)
          resolve({ success: false, error: err.message })
        } else {
          resolve({ success: true })
        }
      })
    })
  })

  // Claude account management
  registerHandler('claude:account-list', async () => {
    await accountManager.load()
    return {
      accounts: accountManager.getAccounts(),
      activeAccountId: accountManager.getActiveAccountId(),
      switchWarningShown: accountManager.isSwitchWarningShown(),
    }
  })

  registerHandler('claude:account-import-current', async () => {
    await accountManager.load()
    const account = await accountManager.importCurrentAccount()
    return account
  })

  registerHandler('claude:account-login-new', async () => {
    await accountManager.load()
    return accountManager.loginNewAccount()
  })

  registerHandler('claude:account-switch', async (_ctx, accountId: string) => {
    await accountManager.load()
    return accountManager.switchAccount(accountId)
  })

  registerHandler('claude:account-remove', async (_ctx, accountId: string) => {
    await accountManager.load()
    return accountManager.removeAccount(accountId)
  })

  registerHandler('claude:account-mark-warning-shown', async () => {
    await accountManager.load()
    await accountManager.markSwitchWarningShown()
    return true
  })

  // Scan .claude/commands/ directories for skill files
  registerHandler('claude:scan-skills', async (_ctx, cwd: string) => {
    const fsMod = await import('fs')
    const pathMod = await import('path')
    const results: { name: string; description: string; scope: 'project' | 'global' }[] = []
    const homePath = os.homedir()
    const dirs: { dir: string; scope: 'project' | 'global' }[] = [
      { dir: pathMod.join(cwd, '.claude', 'commands'), scope: 'project' },
      { dir: pathMod.join(homePath, '.claude', 'commands'), scope: 'global' },
    ]
    for (const { dir, scope } of dirs) {
      try {
        if (!fsMod.existsSync(dir)) continue
        const files = fsMod.readdirSync(dir).filter((f: string) => f.endsWith('.md'))
        for (const file of files) {
          const name = file.replace(/\.md$/, '')
          try {
            const content = fsMod.readFileSync(pathMod.join(dir, file), 'utf-8')
            const firstLine = content.split('\n').find((l: string) => l.trim()) || ''
            const description = firstLine.replace(/^#\s*/, '').trim()
            results.push({ name, description, scope })
          } catch {
            results.push({ name, description: '', scope })
          }
        }
      } catch { /* directory doesn't exist or not readable */ }
    }
    return results
  })
  registerHandler('claude:get-session-state', (_ctx, sessionId: string) => getManager(sessionId)?.getSessionState(sessionId) ?? null)
  registerHandler('claude:get-session-meta', (_ctx, sessionId: string) => getManager(sessionId)?.getSessionMeta(sessionId))
  registerHandler('claude:get-context-usage', (_ctx, sessionId: string) => getManager(sessionId)?.getContextUsage(sessionId))
  registerHandler('claude:resolve-permission', (_ctx, sessionId: string, toolUseId: string, result: { behavior: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[]; message?: string; dontAskAgain?: boolean }) => getManager(sessionId)?.resolvePermission(sessionId, toolUseId, result))
  registerHandler('claude:resolve-ask-user', (_ctx, sessionId: string, toolUseId: string, answers: Record<string, string>) => getManager(sessionId)?.resolveAskUser(sessionId, toolUseId, answers))
  registerHandler('claude:list-sessions', (_ctx, cwd: string, agentKind?: 'claude' | 'codex') => {
    if (agentKind === 'codex') return getCodexManager()?.listSessions(cwd) ?? []
    return getClaudeManager()?.listSessions(cwd) ?? []
  })
  registerHandler('openai:list-sessions', () => [])
  registerHandler('openai:get-api-key-status', async () => ({ hasKey: await hasOpenAIKey() }))
  registerHandler('openai:set-api-key', async (_ctx, key: string) => { await setOpenAIKey(key); return true })
  registerHandler('openai:clear-api-key', async () => { await clearOpenAIKey(); return true })
  registerHandler('openai:compact-now', () => false)
  registerHandler('claude:resume-session', async (ctx, sessionId: string, sdkSessionId: string, cwd: string, model?: string, apiVersion?: 'v1' | 'v2', useWorktree?: boolean, worktreePath?: string, worktreeBranch?: string, agentPreset?: string, codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access', codexApprovalPolicy?: 'untrusted' | 'on-request' | 'never', permissionMode?: string, effort?: string) => {
    const ownerProfileId = ctx.windowId ? (await windowRegistry.getEntry(ctx.windowId))?.profileId ?? null : null
    const explicitType: 'claude' | 'codex' =
      (agentPreset === 'codex-agent' || agentPreset === 'codex-agent-worktree' || agentPreset === 'openai-agent') ? 'codex' : 'claude'
    const type = agentPreset ? explicitType : (sessionManagerMap.get(sessionId) || 'claude')
    sessionManagerMap.set(sessionId, type)
    if (type === 'codex') {
      return getCodexManager()?.resumeSession(
        sessionId,
        sdkSessionId,
        cwd,
        model,
        codexSandboxMode,
        codexApprovalPolicy,
        useWorktree,
        worktreePath,
        worktreeBranch,
        ownerProfileId
      )
    }
    return getClaudeManager()?.resumeSession(sessionId, sdkSessionId, cwd, model, apiVersion, useWorktree, worktreePath, worktreeBranch, ownerProfileId)
  })
  registerHandler('claude:fork-session', (_ctx, sessionId: string) => getManager(sessionId)?.forkSession(sessionId))
  registerHandler('claude:rewind-to-prompt', (_ctx, sessionId: string, promptIndex: number) => {
    const mgr = getManager(sessionId)
    if (!mgr || !('rewindToPrompt' in mgr)) return { error: 'Rewind not supported for this session type' }
    return (mgr as { rewindToPrompt: (sid: string, idx: number) => Promise<unknown> }).rewindToPrompt(sessionId, promptIndex)
  })
  registerHandler('claude:stop-task', (_ctx, sessionId: string, taskId: string) => getManager(sessionId)?.stopTask(sessionId, taskId))
  registerHandler('claude:rest-session', (_ctx, sessionId: string) => getManager(sessionId)?.restSession(sessionId))
  registerHandler('claude:wake-session', (_ctx, sessionId: string) => getManager(sessionId)?.wakeSession(sessionId))
  registerHandler('claude:is-resting', (_ctx, sessionId: string) => getManager(sessionId)?.isResting(sessionId) ?? false)
  registerHandler('claude:fetch-subagent-messages', (_ctx, sessionId: string, agentToolUseId: string) => getManager(sessionId)?.fetchSubagentMessages(sessionId, agentToolUseId) ?? [])

  // Message archiving
  registerHandler('claude:archive-messages', async (_ctx, sessionId: string, messages: unknown[]) => {
    await fs.mkdir(MESSAGE_ARCHIVE_DIR, { recursive: true })
    const filePath = path.join(MESSAGE_ARCHIVE_DIR, `${sessionId}.jsonl`)
    const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    await fs.appendFile(filePath, lines, 'utf-8')
    return true
  })
  registerHandler('claude:load-archived', async (_ctx, sessionId: string, offset: number, limit: number) => {
    const filePath = path.join(MESSAGE_ARCHIVE_DIR, `${sessionId}.jsonl`)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      const total = lines.length
      const end = total - offset
      const start = Math.max(0, end - limit)
      if (end <= 0) return { messages: [], total, hasMore: false }
      const slice = lines.slice(start, end)
      return { messages: slice.map(l => JSON.parse(l)), total, hasMore: start > 0 }
    } catch { return { messages: [], total: 0, hasMore: false } }
  })
  registerHandler('claude:clear-archive', async (_ctx, sessionId: string) => {
    const filePath = path.join(MESSAGE_ARCHIVE_DIR, `${sessionId}.jsonl`)
    try { await fs.unlink(filePath) } catch { /* ignore */ }
    return true
  })


  // Git
  registerHandler('git:get-github-url', async (_ctx, folderPath: string) => {
    try {
      const { stdout } = await execAsync('git remote get-url origin', { cwd: folderPath, encoding: 'utf-8', timeout: 3000 })
      const remote = stdout.trim()
      const sshMatch = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/)
      if (sshMatch) return `https://github.com/${sshMatch[1]}`
      const httpsMatch = remote.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/)
      if (httpsMatch) return `https://github.com/${httpsMatch[1]}`
      return null
    } catch { return null }
  })
  registerHandler('git:branch', async (_ctx, cwd: string) => {
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 3000 })
      return stdout.trim() || null
    } catch { return null }
  })
  registerHandler('git:log', async (_ctx, cwd: string, count: number = 50) => {
    try {
      const safeCount = Math.max(1, Math.min(Math.floor(Number(count)) || 50, 500))
      const { stdout } = await execFileAsync('git', ['log', `--pretty=format:%H||%an||%ai||%s`, '-n', String(safeCount)], { cwd, encoding: 'utf-8', timeout: 5000 })
      const raw = stdout.trim()
      if (!raw) return []
      return raw.split('\n').map(line => {
        const parts = line.split('||')
        return { hash: parts[0], author: parts[1], date: parts[2], message: parts.slice(3).join('||') }
      })
    } catch { return [] }
  })
  registerHandler('git:diff', async (_ctx, cwd: string, commitHash?: string, filePath?: string) => {
    try {
      const args = commitHash && commitHash !== 'working'
        ? ['diff', `${commitHash}~1..${commitHash}`]
        : ['diff', 'HEAD']
      if (filePath) args.push('--', filePath)
      const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 * 5 })
      return stdout
    } catch { return '' }
  })
  registerHandler('git:diff-files', async (_ctx, cwd: string, commitHash?: string) => {
    try {
      const args = commitHash && commitHash !== 'working'
        ? ['diff', '--name-status', `${commitHash}~1..${commitHash}`]
        : ['diff', '--name-status', 'HEAD']
      const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8', timeout: 5000 })
      if (!stdout.trim()) return []
      return stdout.trim().split('\n').map(line => {
        const tab = line.indexOf('\t')
        return { status: tab > 0 ? line.substring(0, tab).trim() : line.charAt(0), file: tab > 0 ? line.substring(tab + 1) : line.substring(2) }
      })
    } catch { return [] }
  })
  registerHandler('git:getRoot', async (_ctx, cwd: string) => {
    try {
      const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8', timeout: 5000 })
      return stdout.trim()
    } catch { return null }
  })
  registerHandler('git:status', async (_ctx, cwd: string) => {
    try {
      const { stdout } = await execAsync('git status --porcelain -uall', { cwd, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 * 5 })
      if (!stdout.trim()) return []
      return stdout.split('\n').filter(line => line.trim()).map(line => ({ status: line.substring(0, 2).trim(), file: line.substring(3) }))
    } catch { return [] }
  })

  // GitHub CLI (gh)
  registerHandler('github:check-cli', async (_ctx) => {
    try {
      await execAsync('gh --version', { encoding: 'utf-8', timeout: 5000 })
      try {
        // gh auth status exits non-zero if ANY account has issues, even if the active account is fine.
        // Use gh auth token which only checks the active account and returns 0 if authenticated.
        await execAsync('gh auth token', { encoding: 'utf-8', timeout: 5000 })
        return { installed: true, authenticated: true }
      } catch {
        return { installed: true, authenticated: false }
      }
    } catch {
      return { installed: false, authenticated: false }
    }
  })
  registerHandler('github:pr-list', async (_ctx, cwd: string) => {
    try {
      const { stdout } = await execAsync('gh pr list --json number,title,state,author,createdAt,updatedAt,labels,headRefName,isDraft --limit 50', { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 5 * 1024 * 1024 })
      return JSON.parse(stdout)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  registerHandler('github:issue-list', async (_ctx, cwd: string) => {
    try {
      const { stdout } = await execAsync('gh issue list --json number,title,state,author,createdAt,updatedAt,labels --limit 50', { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 5 * 1024 * 1024 })
      return JSON.parse(stdout)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  registerHandler('github:pr-view', async (_ctx, cwd: string, number: number) => {
    try {
      const { stdout } = await execAsync(`gh pr view ${number} --json number,title,state,author,body,comments,reviews,createdAt,headRefName,baseRefName,additions,deletions,files`, { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 5 * 1024 * 1024 })
      return JSON.parse(stdout)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  registerHandler('github:issue-view', async (_ctx, cwd: string, number: number) => {
    try {
      const { stdout } = await execAsync(`gh issue view ${number} --json number,title,state,author,body,comments,createdAt,labels`, { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 5 * 1024 * 1024 })
      return JSON.parse(stdout)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  registerHandler('github:pr-comment', async (_ctx, cwd: string, number: number, body: string) => {
    try {
      await execFileAsync('gh', ['pr', 'comment', String(number), '--body', body], { cwd, encoding: 'utf-8', timeout: 15000 })
      return { success: true }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  registerHandler('github:issue-comment', async (_ctx, cwd: string, number: number, body: string) => {
    try {
      await execFileAsync('gh', ['issue', 'comment', String(number), '--body', body], { cwd, encoding: 'utf-8', timeout: 15000 })
      return { success: true }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  // File system
  // File watcher for auto-refresh
  const fileWatchers = new Map<string, ReturnType<typeof fsSync.watch>>()
  registerHandler('fs:watch', (_ctx, _dirPath: string) => {
    if (fileWatchers.has(_dirPath)) return true
    const abs = path.resolve(_dirPath)
    if (isSensitivePath(abs)) return false
    try {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      const watcher = fsSync.watch(abs, { recursive: true }, () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          broadcastHub.broadcast('fs:changed', abs)
        }, 500)
      })
      watcher.on('error', () => {
        fileWatchers.delete(_dirPath)
      })
      fileWatchers.set(_dirPath, watcher)
      return true
    } catch { return false }
  })
  registerHandler('fs:unwatch', (_ctx, _dirPath: string) => {
    const watcher = fileWatchers.get(_dirPath)
    if (watcher) {
      watcher.close()
      fileWatchers.delete(_dirPath)
    }
    return true
  })

  registerHandler('fs:readdir', async (_ctx, dirPath: string) => {
    const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.cache', '__pycache__', '.DS_Store'])
    try {
      const abs = path.resolve(dirPath)
      if (isSensitivePath(abs)) return []
      const entries = await fs.readdir(abs, { withFileTypes: true })
      return entries
        .filter(e => !IGNORED.has(e.name))
        .filter(e => !isSensitivePath(path.join(abs, e.name)))
        .sort((a, b) => { if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1; return a.name.localeCompare(b.name) })
        .map(e => ({ name: e.name, path: path.join(abs, e.name), isDirectory: e.isDirectory() }))
    } catch { return [] }
  })
  registerHandler('fs:readFile', async (_ctx, filePath: string) => {
    try {
      const abs = path.resolve(filePath)
      if (isSensitivePath(abs)) return { error: 'Access denied (sensitive path)' }
      const stat = await fs.stat(abs)
      if (stat.size > 512 * 1024) return { error: 'File too large', size: stat.size }
      const content = await fs.readFile(abs, 'utf-8')
      return { content }
    } catch { return { error: 'Failed to read file' } }
  })
  registerHandler('fs:resolve-path-links', async (_ctx, cwd: string, rawPaths: string[]) => {
    const TEXT_EXTS = new Set([
      'ts', 'tsx', 'js', 'jsx', 'json', 'jsonl', 'css', 'scss', 'less', 'html', 'htm',
      'md', 'mdx', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
      'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'csproj', 'sln',
      'slnx', 'fs', 'fsproj', 'vue', 'svelte', 'sql', 'graphql', 'log',
    ])
    const unique = Array.from(new Set((rawPaths || []).filter(p => typeof p === 'string' && p.length <= 500))).slice(0, 200)
    const cwdAbs = cwd ? path.resolve(cwd) : ''
    const parseRaw = (raw: string) => {
      const cleaned = raw.replace(/^[`'"(<\[]+|[`'"),.;>\]]+$/g, '')
      const lineMatch = cleaned.match(/^(.*?):(\d+)(?::(\d+))?$/)
      if (!lineMatch) return { cleaned, pathText: cleaned, line: undefined, column: undefined }
      return {
        cleaned,
        pathText: lineMatch[1],
        line: Number(lineMatch[2]),
        column: lineMatch[3] ? Number(lineMatch[3]) : undefined,
      }
    }
    const results: { rawPath: string; path: string; exists: boolean; line?: number; column?: number }[] = []
    for (const raw of unique) {
      try {
        const parsed = parseRaw(raw)
        const ext = path.extname(parsed.pathText).slice(1).toLowerCase()
        if (!TEXT_EXTS.has(ext)) continue
        const isAbs = path.isAbsolute(parsed.pathText) || /^[A-Za-z]:[\\/]/.test(parsed.pathText)
        if (!isAbs && !cwdAbs) continue
        const abs = path.resolve(isAbs ? parsed.pathText : path.join(cwdAbs, parsed.pathText))
        if (isSensitivePath(abs)) continue
        const stat = await fs.stat(abs).catch(() => null)
        if (!stat?.isFile()) continue
        results.push({ rawPath: parsed.cleaned, path: abs, exists: true, line: parsed.line, column: parsed.column })
      } catch { /* ignore invalid candidate */ }
    }
    return results
  })
  registerHandler('fs:home', () => os.homedir())

  registerHandler('image:read-as-data-url', async (_ctx, filePath: string) => {
    const abs = path.resolve(filePath)
    if (isSensitivePath(abs)) throw new Error('Access denied (sensitive path)')
    const ext = path.extname(abs).toLowerCase()
    const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
    const mime = mimeMap[ext] || 'image/png'
    const stat = await fs.stat(abs)
    if (stat.size > 10 * 1024 * 1024) throw new Error(`Image too large (${Math.round(stat.size / 1024)}KB)`)
    const data = await fs.readFile(abs)
    return `data:${mime};base64,${data.toString('base64')}`
  })

  registerHandler('fs:quick-locations', async () => {
    const home = os.homedir()
    const items: { name: string; path: string; kind: 'home' | 'drive' | 'volume' | 'root' }[] = [
      { name: 'Home', path: home, kind: 'home' },
    ]
    if (process.platform === 'win32') {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const root = `${letter}:\\`
        try {
          await fs.access(root)
          items.push({ name: `${letter}:`, path: root, kind: 'drive' })
        } catch { /* drive not present */ }
      }
    } else {
      items.push({ name: '/', path: '/', kind: 'root' })
      if (process.platform === 'darwin') {
        try {
          const mounts = await fs.readdir('/Volumes', { withFileTypes: true })
          for (const m of mounts) {
            if (m.isDirectory() || m.isSymbolicLink()) {
              items.push({ name: m.name, path: `/Volumes/${m.name}`, kind: 'volume' })
            }
          }
        } catch { /* no /Volumes */ }
      }
    }
    return items
  })

  registerHandler('fs:list-dirs', async (_ctx, dirPath: string, includeHidden: boolean) => {
    try {
      let expanded = dirPath
      if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
        expanded = expanded === '~' ? os.homedir() : path.join(os.homedir(), expanded.slice(2))
      }
      const abs = path.resolve(expanded)
      if (isSensitivePath(abs)) return { error: 'Access denied (sensitive path)' }
      const entries = await fs.readdir(abs, { withFileTypes: true })
      const filtered = entries
        .filter(e => e.isDirectory())
        .filter(e => includeHidden || !e.name.startsWith('.'))
        .filter(e => !isSensitivePath(path.join(abs, e.name)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(e => ({ name: e.name, path: path.join(abs, e.name) }))
      const parent = path.dirname(abs)
      return {
        current: abs,
        parent: parent === abs ? null : parent,
        entries: filtered,
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  registerHandler('fs:mkdir', async (_ctx, parentPath: string, name: string) => {
    try {
      const trimmed = (name ?? '').trim()
      if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
        return { error: 'Invalid folder name' }
      }
      const abs = path.resolve(parentPath)
      if (isSensitivePath(abs)) return { error: 'Access denied (sensitive path)' }
      const target = path.join(abs, trimmed)
      await fs.mkdir(target, { recursive: false })
      return { path: target }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  registerHandler('fs:delete-path', async (_ctx, targetPath: string) => {
    try {
      const abs = path.resolve(targetPath)
      if (isSensitivePath(abs)) return { error: 'Access denied (sensitive path)' }
      const stat = await fs.lstat(abs)
      if (!stat.isDirectory()) return { error: 'Only directories can be deleted here' }
      await fs.rm(abs, { recursive: true, force: false })
      return { path: abs }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  registerHandler('fs:search', async (_ctx, dirPath: string, query: string) => {
    const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.cache', '__pycache__', '.DS_Store', 'release'])
    const results: { name: string; path: string; isDirectory: boolean }[] = []
    const lowerQuery = query.toLowerCase()
    async function walk(dir: string, depth: number) {
      if (depth > 8 || results.length >= 100) return
      if (isSensitivePath(dir)) return
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const e of entries) {
          if (results.length >= 100) return
          if (IGNORED.has(e.name)) continue
          const fullPath = path.join(dir, e.name)
          if (isSensitivePath(fullPath)) continue
          if (e.name.toLowerCase().includes(lowerQuery)) results.push({ name: e.name, path: fullPath, isDirectory: e.isDirectory() })
          if (e.isDirectory()) await walk(fullPath, depth + 1)
        }
      } catch { /* skip */ }
    }
    await walk(path.resolve(dirPath), 0)
    return results.sort((a, b) => { if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1; return a.name.localeCompare(b.name) })
  })

  // Snippets
  registerHandler('snippet:getAll', (_ctx) => snippetDb.getAll())
  registerHandler('snippet:getById', (_ctx, id: number) => snippetDb.getById(id))
  registerHandler('snippet:create', (_ctx, input: CreateSnippetInput) => snippetDb.create(input))
  registerHandler('snippet:update', (_ctx, id: number, updates: Partial<CreateSnippetInput>) => snippetDb.update(id, updates))
  registerHandler('snippet:delete', (_ctx, id: number) => snippetDb.delete(id))
  registerHandler('snippet:toggleFavorite', (_ctx, id: number) => snippetDb.toggleFavorite(id))
  registerHandler('snippet:search', (_ctx, query: string) => snippetDb.search(query))
  registerHandler('snippet:getCategories', (_ctx) => snippetDb.getCategories())
  registerHandler('snippet:getFavorites', (_ctx) => snippetDb.getFavorites())
  registerHandler('snippet:getByWorkspace', (_ctx, workspaceId?: string) => snippetDb.getByWorkspace(workspaceId))

  // Profile (subset exposed to remote clients)
  registerHandler('profile:list', async (ctx) => {
    const result = await profileManager.list()
    if (!ctx.isRemote) return result
    return {
      ...result,
      profiles: result.profiles.map(({ remoteToken: _remoteToken, ...profile }) => profile),
    }
  })
  registerHandler('profile:load', (_ctx, profileId: string) => profileManager.load(profileId))
  registerHandler('profile:load-snapshot', (_ctx, profileId: string) => profileManager.loadSnapshot(profileId))
  registerHandler('profile:get-active-ids', (_ctx) => profileManager.getActiveProfileIds())
  registerHandler('profile:activate', (_ctx, profileId: string) => profileManager.activateProfile(profileId))
  registerHandler('profile:deactivate', (_ctx, profileId: string) => profileManager.deactivateProfile(profileId))
}
