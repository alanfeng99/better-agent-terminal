import * as assert from 'node:assert/strict'
import {
  WORKSPACE_MOVE_MIME,
  WORKSPACE_MOVE_TTL_MS,
  createWorkspaceMovePayload,
  isWorkspaceMoveDropMatch,
  parseWorkspaceMovePayload,
  resolveWorkspaceMoveDrop,
  type WorkspaceMoveDataTransferLike,
} from '../renderer/src/utils/workspace-move-drag'

function dataTransfer(data: Record<string, string>): WorkspaceMoveDataTransferLike {
  return {
    getData(type: string) {
      return data[type] ?? ''
    },
  }
}

function assertMatch(
  result: ReturnType<typeof resolveWorkspaceMoveDrop>,
  expected: { workspaceId: string; sourceWindowId: string; source: string },
) {
  assert.equal(isWorkspaceMoveDropMatch(result), true)
  if (!isWorkspaceMoveDropMatch(result)) throw new Error('expected workspace move drop match')
  assert.equal(result.payload.workspaceId, expected.workspaceId)
  assert.equal(result.payload.sourceWindowId, expected.sourceWindowId)
  assert.equal(result.source, expected.source)
}

function assertMiss(
  result: ReturnType<typeof resolveWorkspaceMoveDrop>,
  reason: string,
) {
  assert.equal(isWorkspaceMoveDropMatch(result), false)
  if (isWorkspaceMoveDropMatch(result)) throw new Error('expected workspace move drop miss')
  assert.equal(result.reason, reason)
}

async function main() {
  const now = 1_000_000
  const payload = createWorkspaceMovePayload('ws-chewing', 'window-default', now)
  const encoded = JSON.stringify(payload)

  assert.deepEqual(parseWorkspaceMovePayload(encoded, now), payload)
  assert.equal(parseWorkspaceMovePayload('ws-chewing', now), null)
  assert.equal(
    parseWorkspaceMovePayload(JSON.stringify({ ...payload, timestamp: now - WORKSPACE_MOVE_TTL_MS - 1 }), now),
    null,
  )

  assertMatch(
    resolveWorkspaceMoveDrop(
      dataTransfer({ [WORKSPACE_MOVE_MIME]: encoded }),
      'window-n',
      null,
      now,
    ),
    { workspaceId: 'ws-chewing', sourceWindowId: 'window-default', source: 'custom-mime' },
  )

  assertMatch(
    resolveWorkspaceMoveDrop(
      dataTransfer({ 'text/plain': encoded }),
      'window-n',
      null,
      now,
    ),
    { workspaceId: 'ws-chewing', sourceWindowId: 'window-default', source: 'text-plain' },
  )

  assertMatch(
    resolveWorkspaceMoveDrop(
      dataTransfer({}),
      'window-n',
      payload,
      now,
    ),
    { workspaceId: 'ws-chewing', sourceWindowId: 'window-default', source: 'storage' },
  )

  assertMiss(
    resolveWorkspaceMoveDrop(dataTransfer({ [WORKSPACE_MOVE_MIME]: encoded }), 'window-default', null, now),
    'same-window',
  )
  assertMiss(
    resolveWorkspaceMoveDrop(dataTransfer({ [WORKSPACE_MOVE_MIME]: encoded }), null, null, now),
    'missing-target-window',
  )
  assertMiss(
    resolveWorkspaceMoveDrop(dataTransfer({ 'text/plain': 'ws-chewing' }), 'window-n', null, now),
    'missing-payload',
  )

  console.log('workspace-move-drag: passed')
}

main()
