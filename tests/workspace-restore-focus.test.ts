import * as assert from 'node:assert/strict'

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

;(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: (async <T>(cmd: string) => {
      if (cmd === 'workspace_save') return true as T
      if (cmd === 'app_set_dock_badge') return undefined as T
      throw new Error(`unexpected invoke: ${cmd}`)
    }) satisfies TauriInvoke,
  },
}

type TestWorkspaceStore = {
  applySerializedData(data: string, options?: { preserveActiveSelection?: boolean }): void
}

const nProfileRestoreSnapshot = {
  workspaces: [
    {
      id: 'n-app',
      name: 'app',
      folderPath: '/Users/tonyqwang/clones/nueip/app',
      createdAt: 1,
    },
    {
      id: 'n-game',
      name: 'GameTranslate',
      folderPath: '/Users/tonyqwang/clones/game/GameTranslate',
      createdAt: 2,
      focusedTerminalId: 'missing-terminal-from-previous-save',
    },
  ],
  activeWorkspaceId: 'n-app',
  activeTerminalId: null,
  terminals: [
    {
      id: 'n-claude',
      workspaceId: 'n-app',
      type: 'terminal',
      agentPreset: 'claude-code',
      title: 'Claude Agent',
      cwd: '/Users/tonyqwang/clones/nueip/app',
    },
    {
      id: 'n-shell',
      workspaceId: 'n-app',
      type: 'terminal',
      title: 'New Terminal',
      cwd: '/Users/tonyqwang/clones/nueip/app',
    },
    {
      id: 'n-codex',
      workspaceId: 'n-app',
      type: 'terminal',
      agentPreset: 'codex-agent',
      title: 'Codex Agent',
      cwd: '/Users/tonyqwang/clones/nueip/app',
    },
    {
      id: 'game-claude',
      workspaceId: 'n-game',
      type: 'terminal',
      agentPreset: 'claude-code',
      title: 'Claude Agent',
      cwd: '/Users/tonyqwang/clones/game/GameTranslate',
    },
  ],
}

async function main() {
  const { workspaceStore } = await import('../renderer/src/stores/workspace-store.ts')
  const testStore = workspaceStore as unknown as TestWorkspaceStore

  testStore.applySerializedData(JSON.stringify(nProfileRestoreSnapshot))
  let state = workspaceStore.getState()

  assert.equal(state.activeWorkspaceId, 'n-app')
  assert.equal(
    state.focusedTerminalId,
    'n-claude',
    'n-like profile restore should focus the first terminal in the active workspace when persisted focus is missing',
  )
  assert.equal(
    state.activeTerminalId,
    'n-claude',
    'activeTerminalId should be repaired together with focusedTerminalId so the main panel has a render target',
  )
  assert.ok(
    state.terminals.some(t => t.id === state.focusedTerminalId && t.workspaceId === state.activeWorkspaceId),
    'focusedTerminalId must point at a terminal inside the active workspace',
  )

  workspaceStore.setActiveWorkspace('n-game')
  state = workspaceStore.getState()

  assert.equal(state.activeWorkspaceId, 'n-game')
  assert.equal(
    state.focusedTerminalId,
    'game-claude',
    'switching to a workspace with stale saved focus should fallback to its first terminal',
  )
  assert.equal(
    state.activeTerminalId,
    'game-claude',
    'workspace switching should keep activeTerminalId synchronized with focusedTerminalId',
  )

  workspaceStore.setFocusedTerminal('n-shell')
  state = workspaceStore.getState()

  assert.equal(
    state.activeWorkspaceId,
    'n-app',
    'focusing a terminal should activate its workspace instead of leaving a hidden active terminal',
  )
  assert.equal(state.focusedTerminalId, 'n-shell')
  assert.equal(
    state.activeTerminalId,
    'n-shell',
    'manual focus should update activeTerminalId so persisted snapshots do not save a stale/null active terminal',
  )

  testStore.applySerializedData(JSON.stringify({
    ...nProfileRestoreSnapshot,
    activeWorkspaceId: 'n-app',
    activeTerminalId: 'deleted-terminal',
    workspaces: nProfileRestoreSnapshot.workspaces.map(workspace =>
      workspace.id === 'n-app'
        ? { ...workspace, focusedTerminalId: 'deleted-terminal' }
        : workspace
    ),
  }))
  state = workspaceStore.getState()

  assert.equal(
    state.focusedTerminalId,
    'n-claude',
    'stale activeTerminalId and stale focusedTerminalId should not leave restored focus null',
  )
  assert.equal(state.activeTerminalId, 'n-claude')

  console.log('workspace restore focus regression: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
