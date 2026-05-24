import * as assert from 'assert'

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let settingsPayload: Record<string, unknown> = { defaultAgent: 'claude-channel' }

;(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: (async <T>(cmd: string) => {
      if (cmd === 'settings_load') return JSON.stringify(settingsPayload) as T
      if (cmd === 'workspace_save') return true as T
      if (cmd === 'app_set_dock_badge') return undefined as T
      throw new Error(`unexpected invoke: ${cmd}`)
    }) satisfies TauriInvoke,
  },
  batAppAPI: {
    debug: { isDebugMode: false },
  },
  location: { search: '' },
}

async function main() {
  const { getVisiblePresets } = await import('../renderer/src/types/agent-presets.ts')
  const { settingsStore } = await import('../renderer/src/stores/settings-store.ts')
  const { workspaceStore } = await import('../renderer/src/stores/workspace-store.ts')

  assert.equal(
    getVisiblePresets().some(preset => preset.id === 'claude-channel'),
    false,
    'Claude Channel Agent should be hidden when debug mode is false',
  )

  await settingsStore.load()
  assert.equal(
    settingsStore.getSettings().defaultAgent,
    'claude-code',
    'debug-only defaultAgent=claude-channel should be ignored when debug mode is false',
  )

  const debugOnlyWorkspaceState = JSON.stringify({
    workspaces: [
      {
        id: 'ws-debug',
        name: 'Project',
        folderPath: 'C:/project',
        createdAt: 1,
        defaultAgent: 'claude-channel',
      },
    ],
    activeWorkspaceId: 'ws-debug',
    terminals: [
      {
        id: 'term-debug',
        workspaceId: 'ws-debug',
        type: 'terminal',
        agentPreset: 'claude-channel',
        title: 'Claude Channel Agent',
        cwd: 'C:/project',
      },
    ],
  })

  ;(workspaceStore as unknown as {
    applySerializedData(data: string): void
  }).applySerializedData(debugOnlyWorkspaceState)

  const debugHiddenState = workspaceStore.getState()
  assert.equal(
    debugHiddenState.workspaces[0]?.defaultAgent,
    undefined,
    'debug-only workspace defaultAgent should be ignored when debug mode is false',
  )
  assert.equal(
    debugHiddenState.terminals[0]?.agentPreset,
    undefined,
    'debug-only persisted terminal agentPreset should be ignored when debug mode is false',
  )
  assert.equal(
    debugHiddenState.terminals[0]?.title,
    'Terminal',
    'debug-only persisted terminal title should not expose Claude Channel Agent when debug mode is false',
  )

  ;((globalThis as { window?: { batAppAPI?: { debug?: { isDebugMode?: boolean } } } }).window!.batAppAPI!.debug!).isDebugMode = true
  ;((globalThis as { window?: { location?: { search?: string } } }).window!.location!).search = '?BAT_DEBUG=1'
  settingsPayload = { defaultAgent: 'claude-channel' }
  await settingsStore.load()
  assert.equal(
    settingsStore.getSettings().defaultAgent,
    'claude-channel',
    'debug-only defaultAgent=claude-channel should be accepted when debug mode is true',
  )

  console.log('agent preset debug gate: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
