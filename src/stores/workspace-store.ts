import { host } from '../host-api'
import { v4 as uuidv4 } from 'uuid'
import type { Workspace, TerminalInstance, AppState } from '../types'
import { AgentPresetId, getAgentPreset } from '../types/agent-presets'
import { normalizeAgentParams } from '../types/agent-profiles'
import { clearPreviewCache } from '../components/TerminalThumbnail'
import { settingsStore } from './settings-store'

type Listener = () => void

function setHostDockBadge(count: number): void {
  void host.app.setDockBadge(count).catch(() => {})
}

function normalizePersistedAgentPreset(value: unknown): AgentPresetId | undefined {
  if (value === 'openai-agent') return 'codex-agent'
  if (typeof value === 'string' && getAgentPreset(value)) return value as AgentPresetId
  return undefined
}

class WorkspaceStore {
  private state: AppState = {
    workspaces: [],
    activeWorkspaceId: null,
    terminals: [],
    activeTerminalId: null,
    focusedTerminalId: null
  }

  private activeGroup: string | null = null
  private windowId: string | null = null
  private listeners: Set<Listener> = new Set()

  // Usage polling removed — OAuth API calls to Anthropic have been removed.
  // Stubs kept so consumers don't break.
  get claudeUsage() { return null }
  get usageAccount() { return null }
  getUsagePacing() { return null }
  startUsagePolling() { /* no-op */ }
  refreshUsageNow() { /* no-op */ }

  getState(): AppState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(listener => listener())
  }

  // Workspace actions
  addWorkspace(name: string, folderPath: string): Workspace {
    const workspace: Workspace = {
      id: uuidv4(),
      name,
      folderPath,
      createdAt: Date.now()
    }

    this.state = {
      ...this.state,
      workspaces: [...this.state.workspaces, workspace],
      activeWorkspaceId: workspace.id
    }

    this.notify()
    return workspace
  }

  removeWorkspace(id: string): void {
    const terminals = this.state.terminals.filter(t => t.workspaceId !== id)
    const workspaces = this.state.workspaces.filter(w => w.id !== id)

    this.state = {
      ...this.state,
      workspaces,
      terminals,
      activeWorkspaceId: this.state.activeWorkspaceId === id
        ? (workspaces[0]?.id ?? null)
        : this.state.activeWorkspaceId
    }

    this.notify()
  }

  setActiveWorkspace(id: string): void {
    if (this.state.activeWorkspaceId === id) return

    // Persist current focus into the current workspace before switching
    const currentWsId = this.state.activeWorkspaceId
    const currentFocus = this.state.focusedTerminalId
    const updatedWorkspaces = this.state.workspaces.map(w =>
      w.id === currentWsId ? { ...w, focusedTerminalId: currentFocus ?? undefined } : w
    )

    // Restore focus for the target workspace (verify terminal still exists)
    const targetWs = updatedWorkspaces.find(w => w.id === id)
    const savedFocus = targetWs?.focusedTerminalId
    const restoredFocus = savedFocus && this.state.terminals.find(t => t.id === savedFocus && t.workspaceId === id)
      ? savedFocus
      : null

    this.state = {
      ...this.state,
      workspaces: updatedWorkspaces,
      activeWorkspaceId: id,
      focusedTerminalId: restoredFocus
    }

    this.notify()
    this.save()
  }

  renameWorkspace(id: string, alias: string): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, alias: alias.trim() || undefined } : w
      )
    }

    this.notify()
  }

  reorderWorkspaces(workspaceIds: string[]): void {
    const workspaceMap = new Map(this.state.workspaces.map(w => [w.id, w]))
    const reordered = workspaceIds
      .map(id => workspaceMap.get(id))
      .filter((w): w is Workspace => w !== undefined)

    this.state = {
      ...this.state,
      workspaces: reordered
    }

    this.notify()
    this.save()
  }

  // Workspace environment variables
  setWorkspaceEnvVars(id: string, envVars: import('../types').EnvVariable[]): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, envVars } : w
      )
    }
    this.notify()
    this.save()
  }

  addWorkspaceEnvVar(id: string, envVar: import('../types').EnvVariable): void {
    const workspace = this.state.workspaces.find(w => w.id === id)
    if (!workspace) return
    const envVars = [...(workspace.envVars || []), envVar]
    this.setWorkspaceEnvVars(id, envVars)
  }

  removeWorkspaceEnvVar(id: string, key: string): void {
    const workspace = this.state.workspaces.find(w => w.id === id)
    if (!workspace) return
    const envVars = (workspace.envVars || []).filter(e => e.key !== key)
    this.setWorkspaceEnvVars(id, envVars)
  }

  updateWorkspaceEnvVar(id: string, key: string, updates: Partial<import('../types').EnvVariable>): void {
    const workspace = this.state.workspaces.find(w => w.id === id)
    if (!workspace) return
    const envVars = (workspace.envVars || []).map(e =>
      e.key === key ? { ...e, ...updates } : e
    )
    this.setWorkspaceEnvVars(id, envVars)
  }

  // SDK session persistence — per terminal
  setTerminalSdkSessionId(terminalId: string, sdkSessionId: string | undefined): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, sdkSessionId } : t
      )
    }
    this.notify()
    this.save()
  }

  setTerminalWorktreeInfo(terminalId: string, worktreePath: string | undefined, worktreeBranch: string | undefined): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, worktreePath, worktreeBranch } : t
      )
    }
    this.notify()
    this.save()
  }

  setTerminalSessionMeta(terminalId: string, meta: { totalCost: number; inputTokens: number; outputTokens: number; durationMs: number; numTurns: number; contextWindow: number; cacheReadTokens?: number; cacheCreationTokens?: number }): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, sessionMeta: meta } : t
      )
    }
    // Don't notify — this is a background persistence update, no UI re-render needed
    this.save()
  }

  setTerminalProcfile(terminalId: string, procfilePath: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, procfilePath, title: `Worker: ${procfilePath.split('/').pop()}` } : t
      )
    }
    this.notify()
  }

  setTerminalPendingPrompt(terminalId: string, prompt: string, images?: string[]): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, pendingPrompt: prompt, pendingImages: images } : t
      )
    }
    this.notify()
  }

  // Legacy: also store on workspace for backwards compatibility
  setLastSdkSessionId(workspaceId: string, sdkSessionId: string): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === workspaceId ? { ...w, lastSdkSessionId: sdkSessionId } : w
      )
    }
    this.notify()
    this.save()
  }

  // Terminal actions
  addTerminal(workspaceId: string, agentPreset?: AgentPresetId): TerminalInstance {
    const workspace = this.state.workspaces.find(w => w.id === workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const existingTerminals = this.state.terminals.filter(
      t => t.workspaceId === workspaceId && !t.agentPreset
    )

    // Get agent preset info for title
    const preset = agentPreset ? getAgentPreset(agentPreset) : null
    const title = preset && preset.id !== 'none'
      ? preset.name
      : 'New Terminal'

    const terminal: TerminalInstance = {
      id: uuidv4(),
      workspaceId,
      type: 'terminal',
      agentPreset,
      title,
      cwd: workspace.folderPath,
      scrollbackBuffer: [],
      lastActivityTime: Date.now(),
      historyKey: uuidv4().replace(/-/g, '').slice(0, 12),
      agentParams: normalizeAgentParams(agentPreset),
    }

    // Auto-focus if it's an agent terminal or no current focus
    const shouldFocus = (agentPreset && agentPreset !== 'none') || !this.state.focusedTerminalId

    this.state = {
      ...this.state,
      terminals: [...this.state.terminals, terminal],
      focusedTerminalId: shouldFocus ? terminal.id : this.state.focusedTerminalId
    }

    this.notify()
    return terminal
  }

  removeTerminal(id: string): void {
    clearPreviewCache(id)
    const terminals = this.state.terminals.filter(t => t.id !== id)

    this.state = {
      ...this.state,
      terminals,
      focusedTerminalId: this.state.focusedTerminalId === id
        ? (terminals[0]?.id ?? null)
        : this.state.focusedTerminalId
    }

    this.notify()
  }

  switchTerminalApiVersion(id: string): 'claude-code' | 'claude-code-v2' | null {
    const terminal = this.state.terminals.find(t => t.id === id)
    if (!terminal) return null
    const newPreset = terminal.agentPreset === 'claude-code' ? 'claude-code-v2' as const : 'claude-code' as const
    const newTitle = newPreset === 'claude-code-v2' ? 'Claude Agent (V2)' : 'Claude Agent (V1)'
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, agentPreset: newPreset, title: newTitle } : t
      )
    }
    this.notify()
    return newPreset
  }

  renameTerminal(id: string, title: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, alias: title } : t
      )
    }

    this.notify()
    this.save()
  }

  setTerminalGeneratedTitle(id: string, title: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, title } : t
      )
    }

    this.notify()
  }

  setFocusedTerminal(id: string | null): void {
    if (this.state.focusedTerminalId === id) return

    this.state = {
      ...this.state,
      focusedTerminalId: id
    }

    this.notify()
  }

  updateTerminalCwd(id: string, cwd: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, cwd } : t
      )
    }

    this.notify()
  }

  updateTerminalModel(id: string, model: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, model } : t
      )
    }

    this.notify()
    this.save()
  }

  updateTerminalAgentParams(id: string, params: Record<string, string | number | boolean>): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? {
          ...t,
          agentParams: normalizeAgentParams(t.agentPreset, { ...(t.agentParams || {}), ...params }),
        } : t
      )
    }

    this.notify()
    this.save()
  }

  markAgentCommandSent(id: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, agentCommandSent: true } : t
      )
    }
    this.notify()
    this.save()
  }

  markHasUserInput(id: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, hasUserInput: true } : t
      )
    }
    this.notify()
    this.save()
  }

  appendScrollback(id: string, data: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, scrollbackBuffer: [...t.scrollbackBuffer, data] } : t
      )
    }
    // Don't notify for scrollback updates to avoid re-renders
  }

  clearScrollback(id: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, scrollbackBuffer: [] } : t
      )
    }

    this.notify()
  }

  reorderTerminals(terminalIds: string[]): void {
    const terminalMap = new Map(this.state.terminals.map(t => [t.id, t]))
    const reordered = terminalIds
      .map(id => terminalMap.get(id))
      .filter((t): t is TerminalInstance => t !== undefined)

    // Append any terminals not in the provided list (e.g. from other workspaces)
    for (const t of this.state.terminals) {
      if (!terminalIds.includes(t.id)) {
        reordered.push(t)
      }
    }

    this.state = {
      ...this.state,
      terminals: reordered
    }

    this.notify()
    this.save()
  }

  // Get terminals for current workspace
  getWorkspaceTerminals(workspaceId: string): TerminalInstance[] {
    return this.state.terminals.filter(t => t.workspaceId === workspaceId)
  }

  // Get agent terminal for workspace (first agent terminal, regardless of type)
  getAgentTerminal(workspaceId: string): TerminalInstance | undefined {
    return this.state.terminals.find(
      t => t.workspaceId === workspaceId && t.agentPreset && t.agentPreset !== 'none'
    )
  }

  // Legacy compatibility - alias for getAgentTerminal
  getClaudeCodeTerminal(workspaceId: string): TerminalInstance | undefined {
    return this.getAgentTerminal(workspaceId)
  }

  getRegularTerminals(workspaceId: string): TerminalInstance[] {
    return this.state.terminals.filter(
      t => t.workspaceId === workspaceId && (!t.agentPreset || t.agentPreset === 'none')
    )
  }

  // Group management
  getActiveGroup(): string | null {
    return this.activeGroup
  }

  setActiveGroup(group: string | null): void {
    this.activeGroup = group

    // Auto-select first workspace in the group if current is not visible
    if (group) {
      const visibleWorkspaces = this.state.workspaces.filter(w => w.group === group)
      const currentVisible = visibleWorkspaces.some(w => w.id === this.state.activeWorkspaceId)
      if (!currentVisible && visibleWorkspaces.length > 0) {
        this.state = {
          ...this.state,
          activeWorkspaceId: visibleWorkspaces[0].id,
          focusedTerminalId: null
        }
      } else {
        // Force new reference so React re-renders the sidebar filter
        this.state = { ...this.state }
      }
    } else {
      this.state = { ...this.state }
    }

    this.notify()
    this.save()
  }

  setWorkspaceGroup(id: string, group: string | undefined): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, group } : w
      )
    }
    this.notify()
    this.save()
  }

  setWorkspaceColor(id: string, color: string | undefined): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, color } : w
      )
    }
    this.notify()
    this.save()
  }

  getGroups(): string[] {
    const groups = new Set<string>()
    for (const w of this.state.workspaces) {
      if (w.group) groups.add(w.group)
    }
    return Array.from(groups).sort()
  }

  // Activity tracking
  private lastActivityNotify: number = 0
  private _savePromise: Promise<void> = Promise.resolve()
  private _savePending = false

  updateTerminalActivity(id: string): void {
    const now = Date.now()
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, lastActivityTime: now } : t
      )
    }
    // Throttle notifications to avoid excessive re-renders (max once per 500ms)
    if (now - this.lastActivityNotify > 500) {
      this.lastActivityNotify = now
      this.notify()
    }
  }

  setTerminalPendingAction(id: string, pending: boolean): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, hasPendingAction: pending } : t
      )
    }
    this.notify()
    this.updateDockBadge()
  }

  private updateDockBadge(): void {
    const settings = settingsStore.getSettings()
    if (settings.showDockBadge === false) return
    const count = this.state.terminals.filter(t => t.hasPendingAction).length
    setHostDockBadge(count)
  }

  getWorkspaceLastActivity(workspaceId: string): number | null {
    const terminals = this.getWorkspaceTerminals(workspaceId)
    const lastActivities = terminals
      .map(t => t.lastActivityTime)
      .filter((time): time is number => time !== undefined)

    return lastActivities.length > 0 ? Math.max(...lastActivities) : null
  }

  // Window identity for cross-window drag
  setWindowId(id: string): void { this.windowId = id }
  getWindowId(): string | null { return this.windowId }

  listenForReload(): () => void {
    return host.workspace.onReload((data?: string) => {
      if (data) {
        this.applySerializedData(data, { preserveActiveSelection: true })
        return
      }
      this.load()
    })
  }

  // Persistence — serialized to prevent concurrent writes from corrupting the file
  async save(): Promise<void> {
    // If a save is already queued, skip — the queued save will capture the latest state
    if (this._savePending) return
    this._savePending = true

    // Wait for any in-flight save to finish, then perform ours
    this._savePromise = this._savePromise.then(async () => {
      this._savePending = false
      const savedTerminals = this.state.terminals.map(t => ({
        id: t.id,
        workspaceId: t.workspaceId,
        type: t.type,
        agentPreset: t.agentPreset,
        title: t.title,
        alias: t.alias,
        cwd: t.cwd,
        sdkSessionId: t.sdkSessionId,
        model: t.model,
        agentParams: t.agentParams,
        sessionMeta: t.sessionMeta,
        procfilePath: t.procfilePath,
      }))
      // Persist current focus into the active workspace at save time
      const wsWithFocus = this.state.workspaces.map(w =>
        w.id === this.state.activeWorkspaceId && this.state.focusedTerminalId
          ? { ...w, focusedTerminalId: this.state.focusedTerminalId }
          : w
      )
      const data = JSON.stringify({
        workspaces: wsWithFocus,
        activeWorkspaceId: this.state.activeWorkspaceId,
        activeGroup: this.activeGroup,
        terminals: savedTerminals,
        activeTerminalId: this.state.activeTerminalId,
      })
      await host.workspace.save(data)
    }).catch(e => {
      console.error('Failed to save workspace data:', e)
    })

    return this._savePromise
  }

  async load(): Promise<void> {
    const data = await host.workspace.load()
    if (data) {
      this.applySerializedData(data)
    }
  }

  private applySerializedData(data: string, options?: { preserveActiveSelection?: boolean }): void {
    try {
      const parsed = JSON.parse(data)
      // Restore terminals with empty runtime fields
      const workspaces: Workspace[] = (parsed.workspaces || []).map((w: Workspace) => ({
        ...w,
        defaultAgent: normalizePersistedAgentPreset(w.defaultAgent),
      }))
      const workspaceMap = new Map(workspaces.map((w: Workspace) => [w.id, w]))
      const terminals = (parsed.terminals || []).map((t: Partial<TerminalInstance>): TerminalInstance | null => {
        const ws = t.workspaceId ? workspaceMap.get(t.workspaceId) : undefined
        if (!ws?.folderPath) {
          host.debug.log?.(`[workspace-store] Warning: terminal ${t.id} has no valid workspace, skipping`)
          return null
        }
        const cwd = ws.folderPath
        // For agent terminals, always derive title from preset to fix any persisted corruption
        const agentPreset = normalizePersistedAgentPreset(t.agentPreset)
        const presetTitle = agentPreset && agentPreset !== 'none'
          ? (getAgentPreset(agentPreset)?.name || t.title || 'Terminal')
          : (t.title || 'Terminal')
        return {
          id: t.id || '',
          workspaceId: t.workspaceId || '',
          type: 'terminal' as const,
          agentPreset,
          title: presetTitle,
          alias: t.alias,
          cwd,
          sdkSessionId: t.sdkSessionId,
          model: t.model,
          agentParams: normalizeAgentParams(agentPreset, t.agentParams),
          sessionMeta: t.sessionMeta,
          procfilePath: t.procfilePath,
          scrollbackBuffer: [],
          pid: undefined,
        }
      }).filter((t: TerminalInstance | null): t is TerminalInstance => t !== null)
      const currentActiveWorkspaceId = this.state.activeWorkspaceId
      const shouldPreserveActive = !!options?.preserveActiveSelection
        && !!currentActiveWorkspaceId
        && workspaces.some((w: Workspace) => w.id === currentActiveWorkspaceId)
      const activeWorkspaceId = shouldPreserveActive
        ? currentActiveWorkspaceId
        : parsed.activeWorkspaceId || null

      // Restore last focused terminal for the active workspace
      const activeWs = workspaces.find((w: Workspace) => w.id === activeWorkspaceId)
      const savedFocusId = activeWs?.focusedTerminalId
      const focusCandidate = shouldPreserveActive
        ? this.state.focusedTerminalId || savedFocusId
        : savedFocusId
      const restoredFocus = focusCandidate && terminals.find(
        (t: TerminalInstance) => t.id === focusCandidate && t.workspaceId === activeWorkspaceId
      ) ? focusCandidate : null

      this.state = {
        ...this.state,
        workspaces,
        activeWorkspaceId,
        terminals,
        activeTerminalId: parsed.activeTerminalId || null,
        focusedTerminalId: restoredFocus,
      }
      this.activeGroup = parsed.activeGroup || null
      this.notify()
    } catch (e) {
      host.debug.log?.(`Failed to parse workspace data: ${e}`)
      console.error('Failed to parse workspace data:', e)
    }
  }
}

export const workspaceStore = new WorkspaceStore()

import { createSelectorHook } from './use-store'
export const useWorkspace = createSelectorHook<AppState>({
  subscribe: (l) => workspaceStore.subscribe(l),
  getState: () => workspaceStore.getState(),
})
