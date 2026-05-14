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
  const { AGENT_PRESETS, getVisiblePresets } = await import('../renderer/src/types/agent-presets.ts')
  const { settingsStore } = await import('../renderer/src/stores/settings-store.ts')
  const { workspaceStore } = await import('../renderer/src/stores/workspace-store.ts')

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
  const debugPreset = {
    id: 'debug-only-test',
    name: 'Debug Only Test',
    icon: '*',
    color: '#999999',
    debug: true,
  }
  AGENT_PRESETS.push(debugPreset)
  try {
    ;((globalThis as { window?: { batAppAPI?: unknown } }).window ??= {}).batAppAPI = {
      debug: { isDebugMode: false },
    }
    assert.equal(
      getVisiblePresets().some(preset => preset.id === debugPreset.id),
      false,
      'debug-only presets should stay hidden when batAppAPI debug mode is false',
    )
    ;((globalThis as { window?: { batAppAPI?: { debug?: { isDebugMode?: boolean } } } }).window!.batAppAPI!.debug!).isDebugMode = true
    assert.equal(
      getVisiblePresets().some(preset => preset.id === debugPreset.id),
      true,
      'debug-only presets should use window.batAppAPI.debug.isDebugMode',
    )
  } finally {
    AGENT_PRESETS.pop()
    delete (globalThis as { window?: { batAppAPI?: unknown } }).window?.batAppAPI
  }

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

  const readmeSource = await readFile('README.md', 'utf8')

  for (const removedFile of [
    'electron',
    'electron/openai-agent-manager.ts',
    'electron/openai-agent/models.ts',
    'electron/openai-agent/persistence.ts',
    'electron/openai-agent/skills-scanner.ts',
    'electron/openai-agent/compaction.ts',
    'electron/openai-tools/registry.ts',
    'src-tauri/src/commands/openai.rs',
  ]) {
    await assert.rejects(
      readFile(removedFile, 'utf8'),
      undefined,
      `${removedFile} should be removed with OpenAI Direct runtime`,
    )
  }
  for (const staleDoc of [
    '### OpenAI Direct (debug)',
    'openai-agent-manager.ts',
    'OpenAIAgentPanel.tsx',
    'host.openai',
    '@ai-sdk/openai',
  ]) {
    assert.equal(
      readmeSource.includes(staleDoc),
      false,
      `README should not document removed OpenAI Direct artifact: ${staleDoc}`,
    )
  }

  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const removedDep of ['@ai-sdk/openai', 'ai', 'zod']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(pkg.dependencies ?? {}, removedDep),
      false,
      `${removedDep} should not remain as a direct dependency`,
    )
  }

  console.log('OpenAI Direct cleanup migration: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
