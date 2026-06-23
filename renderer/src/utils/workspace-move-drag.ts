export const WORKSPACE_MOVE_MIME = 'application/x-bat-workspace-move'
export const WORKSPACE_MOVE_STORAGE_KEY = 'bat-workspace-move-drag'
export const WORKSPACE_MOVE_TTL_MS = 30_000

export interface WorkspaceMovePayload {
  workspaceId: string
  sourceWindowId: string
  timestamp?: number
}

export type WorkspaceMovePayloadSource = 'custom-mime' | 'text-plain' | 'storage'

export interface WorkspaceMoveDropMatch {
  payload: WorkspaceMovePayload
  source: WorkspaceMovePayloadSource
}

export interface WorkspaceMoveDropMiss {
  reason:
    | 'missing-target-window'
    | 'missing-payload'
    | 'same-window'
}

export type WorkspaceMoveDropResult = WorkspaceMoveDropMatch | WorkspaceMoveDropMiss

export interface WorkspaceMoveDataTransferLike {
  getData(type: string): string
}

export interface WorkspaceMoveDataTransferTypesLike {
  types?: Iterable<string> | ArrayLike<string> | {
    contains?: (type: string) => boolean
  } | null
}

export function dataTransferHasType(
  dataTransfer: WorkspaceMoveDataTransferTypesLike,
  type: string,
): boolean {
  const types = dataTransfer.types
  if (!types) return false
  if (typeof (types as { contains?: unknown }).contains === 'function') {
    return (types as { contains: (value: string) => boolean }).contains(type)
  }
  try {
    return Array.from(types as Iterable<string> | ArrayLike<string>).includes(type)
  } catch {
    return false
  }
}

export function createWorkspaceMovePayload(
  workspaceId: string,
  sourceWindowId: string,
  now = Date.now(),
): WorkspaceMovePayload {
  return { workspaceId, sourceWindowId, timestamp: now }
}

export function parseWorkspaceMovePayload(
  raw: string | null | undefined,
  now = Date.now(),
): WorkspaceMovePayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceMovePayload>
    if (typeof parsed.workspaceId !== 'string' || !parsed.workspaceId) return null
    if (typeof parsed.sourceWindowId !== 'string' || !parsed.sourceWindowId) return null
    if (typeof parsed.timestamp === 'number' && now - parsed.timestamp > WORKSPACE_MOVE_TTL_MS) {
      return null
    }
    return {
      workspaceId: parsed.workspaceId,
      sourceWindowId: parsed.sourceWindowId,
      timestamp: parsed.timestamp,
    }
  } catch {
    return null
  }
}

export function resolveWorkspaceMoveDrop(
  dataTransfer: WorkspaceMoveDataTransferLike,
  targetWindowId: string | null | undefined,
  storedPayload?: WorkspaceMovePayload | null,
  now = Date.now(),
): WorkspaceMoveDropResult {
  if (!targetWindowId) return { reason: 'missing-target-window' }

  const candidates: Array<{ source: WorkspaceMovePayloadSource; payload: WorkspaceMovePayload | null }> = [
    {
      source: 'custom-mime',
      payload: parseWorkspaceMovePayload(dataTransfer.getData(WORKSPACE_MOVE_MIME), now),
    },
    {
      source: 'text-plain',
      payload: parseWorkspaceMovePayload(dataTransfer.getData('text/plain'), now),
    },
    {
      source: 'storage',
      payload: storedPayload ?? null,
    },
  ]
  const match = candidates.find(candidate => candidate.payload)
  if (!match?.payload) return { reason: 'missing-payload' }
  if (match.payload.sourceWindowId === targetWindowId) return { reason: 'same-window' }
  return { payload: match.payload, source: match.source }
}

export function isWorkspaceMoveDropMatch(
  result: WorkspaceMoveDropResult,
): result is WorkspaceMoveDropMatch {
  return 'payload' in result
}
