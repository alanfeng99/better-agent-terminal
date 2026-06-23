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

async function main() {
  const { workspaceStore } = await import('../renderer/src/stores/workspace-store.ts')

  ;(workspaceStore as unknown as {
    applySerializedData(data: string): void
  }).applySerializedData(JSON.stringify({
    workspaces: [
      { id: 'ws-a', name: 'A', folderPath: '/a', createdAt: 1 },
      { id: 'ws-b', name: 'B', folderPath: '/b', createdAt: 2 },
    ],
    activeWorkspaceId: 'ws-a',
    terminals: [
      { id: 'a1', workspaceId: 'ws-a', type: 'terminal', title: 'A1', cwd: '/a' },
      { id: 'b1', workspaceId: 'ws-b', type: 'terminal', title: 'B1', cwd: '/b' },
      { id: 'a2', workspaceId: 'ws-a', type: 'terminal', title: 'A2', cwd: '/a' },
      { id: 'b2', workspaceId: 'ws-b', type: 'terminal', title: 'B2', cwd: '/b' },
    ],
  }))

  workspaceStore.reorderTerminals(['a2', 'a1'])

  assert.deepEqual(
    workspaceStore.getState().terminals.map(t => t.id),
    ['a2', 'b1', 'a1', 'b2'],
    'reordering one workspace should preserve other workspace terminal slots',
  )
  assert.deepEqual(
    workspaceStore.getWorkspaceTerminals('ws-a').map(t => t.id),
    ['a2', 'a1'],
  )

  console.log('workspace-reorder: passed')
}

main()
