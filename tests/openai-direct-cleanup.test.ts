import * as assert from 'assert'
import { readFile } from 'fs/promises'

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

;(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: (async <T>(cmd: string) => {
      if (cmd === 'settings_load') {
        return JSON.stringify({ defaultAgent: 'openai-agent' }) as T
      }
      if (cmd === 'workspace_save') return true as T
      if (cmd === 'app_set_dock_badge') return undefined as T
      throw new Error(`unexpected invoke: ${cmd}`)
    }) satisfies TauriInvoke,
  },
}

async function main() {
  const { AGENT_PRESETS, getVisiblePresets } = await import('../src/types/agent-presets.ts')
  const { settingsStore } = await import('../src/stores/settings-store.ts')
  const { workspaceStore } = await import('../src/stores/workspace-store.ts')

  assert.equal(
    AGENT_PRESETS.some(preset => preset.id === 'openai-agent'),
    false,
    'OpenAI Direct preset must not be registered',
  )
  assert.equal(
    getVisiblePresets().some(preset => preset.id === 'openai-agent'),
    false,
    'OpenAI Direct preset must not be visible',
  )

  await settingsStore.load()
  assert.equal(
    settingsStore.getSettings().defaultAgent,
    'codex-agent',
    'legacy defaultAgent=openai-agent should migrate to codex-agent',
  )

  const legacyWorkspaceState = JSON.stringify({
    workspaces: [
      {
        id: 'ws-1',
        name: 'Project',
        folderPath: 'C:/project',
        createdAt: 1,
        defaultAgent: 'openai-agent',
      },
    ],
    activeWorkspaceId: 'ws-1',
    terminals: [
      {
        id: 'term-1',
        workspaceId: 'ws-1',
        type: 'terminal',
        agentPreset: 'openai-agent',
        title: 'OpenAI Direct',
        cwd: 'C:/project',
      },
    ],
  })

  ;(workspaceStore as unknown as {
    applySerializedData(data: string): void
  }).applySerializedData(legacyWorkspaceState)

  const state = workspaceStore.getState()
  assert.equal(state.workspaces[0]?.defaultAgent, 'codex-agent')
  assert.equal(state.terminals[0]?.agentPreset, 'codex-agent')
  assert.equal(state.terminals[0]?.title, 'Codex Agent')

  const mainSource = await readFile('electron/main.ts', 'utf8')
  const handlerSource = await readFile('electron/server-core/register-handlers.ts', 'utf8')
  assert.equal(
    mainSource.includes('OpenAIAgentManager'),
    false,
    'Electron main must not initialize the retired OpenAI Direct manager',
  )
  assert.equal(
    handlerSource.includes('getOpenAIManager'),
    false,
    'Electron handlers must not route sessions to OpenAI Direct manager',
  )
  assert.equal(
    handlerSource.includes("sessionManagerMap.set(sessionId, 'openai')"),
    false,
    'legacy openai-agent sessions must not be assigned OpenAI Direct ownership',
  )

  console.log('OpenAI Direct cleanup migration: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
