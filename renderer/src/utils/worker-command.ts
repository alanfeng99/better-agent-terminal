export type WorkerCommandAction = 'start' | 'stop' | 'restart' | 'reload' | 'clear' | 'status'

export interface WorkerCommandRequest {
  requestId: string
  workspaceId?: string
  target: string
  action: WorkerCommandAction
}

export interface WorkerCommandResult {
  requestId: string
  terminalId: string
  procfilePath: string
  handled: boolean
  message: string
  statuses?: Array<{ name: string; status: string; command: string }>
  error?: string
}

const ACTION_ALIASES: Record<string, WorkerCommandAction> = {
  start: 'start',
  stop: 'stop',
  end: 'stop',
  kill: 'stop',
  restart: 'restart',
  reload: 'reload',
  refresh: 'reload',
  clear: 'clear',
  status: 'status',
  list: 'status',
  ls: 'status',
}

export function parseWorkerSlashCommand(input: string): WorkerCommandRequest | null {
  const trimmed = input.trim()
  if (trimmed !== '/worker' && !trimmed.startsWith('/worker ')) return null
  const args = trimmed.slice('/worker'.length).trim().split(/\s+/).filter(Boolean)
  let target = 'all'
  let action: WorkerCommandAction = 'status'

  if (args.length === 1) {
    const maybeAction = ACTION_ALIASES[args[0].toLowerCase()]
    if (maybeAction) {
      action = maybeAction
    } else {
      target = args[0]
      action = 'status'
    }
  } else if (args.length >= 2) {
    const firstAction = ACTION_ALIASES[args[0].toLowerCase()]
    const lastAction = ACTION_ALIASES[args[args.length - 1].toLowerCase()]
    if (firstAction) {
      action = firstAction
      target = args.slice(1).join(' ')
    } else if (lastAction) {
      action = lastAction
      target = args.slice(0, -1).join(' ')
    } else {
      target = args.join(' ')
      action = 'status'
    }
  }

  return {
    requestId: `worker-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    target: target || 'all',
    action,
  }
}

export async function dispatchWorkerCommand(
  command: WorkerCommandRequest,
  workspaceId?: string,
  timeoutMs = 2500,
): Promise<string> {
  const request: WorkerCommandRequest = { ...command, workspaceId }
  const results: WorkerCommandResult[] = []
  return new Promise(resolve => {
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<WorkerCommandResult>).detail
      if (!detail || detail.requestId !== request.requestId) return
      results.push(detail)
    }
    window.addEventListener('bat-worker-command-result', onResult as EventListener)
    window.dispatchEvent(new CustomEvent('bat-worker-command', { detail: request }))
    window.setTimeout(() => {
      window.removeEventListener('bat-worker-command-result', onResult as EventListener)
      resolve(formatWorkerCommandResults(request, results))
    }, timeoutMs)
  })
}

function formatWorkerCommandResults(request: WorkerCommandRequest, results: WorkerCommandResult[]): string {
  const handled = results.filter(result => result.handled)
  if (handled.length === 0) {
    return 'No matching worker panel is open in this workspace.'
  }
  if (request.action === 'status') {
    return handled.flatMap(result => {
      const name = result.procfilePath.split(/[\\/]/).pop() || 'Procfile'
      const statuses = result.statuses?.length
        ? result.statuses.map(status => `- ${status.name}: ${status.status} (${status.command})`)
        : ['- No worker processes loaded.']
      return [`${name}:`, ...statuses]
    }).join('\n')
  }
  return handled.map(result => result.error ? `Error: ${result.error}` : result.message).join('\n')
}
