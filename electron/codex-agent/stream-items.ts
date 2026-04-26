import type { ClaudeMessage, ClaudeToolCall } from '../../src/types/claude-agent'
import { stringifyCodexError } from './errors'
import { extractReasoningTextFromResponseItem, normalizeToolResult } from './response-items'

export interface CodexStreamItemState {
  currentAssistantText: string
  currentThinkingText: string
  currentThinkingByItemId: Record<string, string>
  currentItemId: string
}

export interface CodexStreamItemSink {
  addMessage: (msg: ClaudeMessage) => void
  addToolCall: (tool: ClaudeToolCall) => void
  updateToolCall: (toolId: string, updates: Partial<ClaudeToolCall>) => void
  hasToolCall: (toolId: string) => boolean
  sendStream: (data: { text?: string; thinking?: string }) => void
  sendError: (message: string) => void
}

function normalizeTodoItems(items: Array<Record<string, unknown>> | undefined): Array<{ content: string; status: string }> {
  if (!items) return []
  return items
    .map(item => {
      const content = String(item.content ?? item.text ?? item.description ?? '').trim()
      const rawStatus = String(item.status ?? '').trim()
      const status = rawStatus || (item.completed === true ? 'completed' : 'pending')
      return { content, status }
    })
    .filter(item => item.content)
}

function normalizeWebSearchInput(item: Record<string, unknown>): Record<string, unknown> {
  const action = item?.action as Record<string, unknown> | undefined
  const actionQueries = Array.isArray(action?.queries)
    ? action.queries.map(q => String(q).trim()).filter(Boolean)
    : []
  const query = String(item?.query ?? action?.query ?? actionQueries[0] ?? '').trim()
  const actionType = typeof action?.type === 'string' ? action.type : ''
  const input: Record<string, unknown> = {}
  if (query) input.query = query
  if (actionQueries.length > 0) input.queries = actionQueries
  if (actionType && actionType !== 'search') input.action = actionType
  return input
}

function isThinkingItemType(itemType: string | undefined): boolean {
  return itemType === 'reasoning'
    || itemType === 'agent_reasoning'
    || itemType === 'reasoning_summary'
    || itemType === 'thinking'
}

export function appendThinkingFromItem(item: Record<string, unknown>, state: CodexStreamItemState, sink: CodexStreamItemSink): void {
  const itemId = String(item.id || state.currentItemId || `thinking-${Date.now()}`)
  const text = extractReasoningTextFromResponseItem(item)
  if (!text) return

  const previous = state.currentThinkingByItemId[itemId] || ''
  let delta = ''
  let nextItemText = text
  if (!previous) {
    delta = state.currentThinkingText ? `\n\n${text}` : text
  } else if (text.startsWith(previous)) {
    delta = text.slice(previous.length)
  } else if (text !== previous) {
    delta = `\n\n${text}`
    nextItemText = `${previous}\n\n${text}`
  }
  if (!delta) return

  state.currentThinkingByItemId[itemId] = nextItemText
  state.currentThinkingText += delta
  sink.sendStream({ thinking: delta })
}

export function handleItemStarted(sessionId: string, item: Record<string, unknown>, state: CodexStreamItemState, sink: CodexStreamItemSink): void {
  const itemType = item?.type as string
  state.currentItemId = (item?.id as string) || `item-${Date.now()}`

  if (itemType === 'agent_message') {
    state.currentAssistantText = ''
    state.currentThinkingText = ''
    state.currentThinkingByItemId = {}
  } else if (isThinkingItemType(itemType)) {
    appendThinkingFromItem(item, state, sink)
  } else if (itemType === 'command_execution') {
    const command = (item?.command as string) || (item?.input as string) || ''
    sink.addToolCall({
      id: state.currentItemId,
      sessionId,
      toolName: 'Bash',
      input: { command },
      status: 'running',
      timestamp: Date.now(),
    })
  } else if (itemType === 'file_change') {
    const changes = item?.changes as Array<Record<string, unknown>> | undefined
    const filePath = changes?.[0]?.path as string || ''
    sink.addToolCall({
      id: state.currentItemId,
      sessionId,
      toolName: 'Edit',
      input: { file_path: filePath },
      status: 'running',
      timestamp: Date.now(),
    })
  } else if (itemType === 'mcp_tool_call') {
    const server = (item?.server as string) || ''
    const tool = (item?.tool as string) || 'MCP'
    sink.addToolCall({
      id: state.currentItemId,
      sessionId,
      toolName: server ? `${server}/${tool}` : tool,
      input: (item?.arguments as Record<string, unknown>) || {},
      status: 'running',
      timestamp: Date.now(),
    })
  } else if (itemType === 'web_search') {
    sink.addToolCall({
      id: state.currentItemId,
      sessionId,
      toolName: 'WebSearch',
      input: normalizeWebSearchInput(item),
      status: 'running',
      timestamp: Date.now(),
    })
  } else if (itemType === 'todo_list') {
    const items = item?.items as Array<Record<string, unknown>> | undefined
    sink.addToolCall({
      id: state.currentItemId,
      sessionId,
      toolName: 'TodoWrite',
      input: { todos: normalizeTodoItems(items) },
      status: 'running',
      timestamp: Date.now(),
    })
  }
}

export function handleItemUpdated(sessionId: string, item: Record<string, unknown>, state: CodexStreamItemState, sink: CodexStreamItemSink): void {
  const itemType = item?.type as string
  const itemId = (item?.id as string) || state.currentItemId

  if (itemType === 'agent_message') {
    const text = (item?.text as string) || (item?.content as string) || ''
    if (text && text.length > state.currentAssistantText.length) {
      const delta = text.slice(state.currentAssistantText.length)
      state.currentAssistantText = text
      sink.sendStream({ text: delta })
    }
  } else if (isThinkingItemType(itemType)) {
    appendThinkingFromItem(item, state, sink)
  } else if (itemType === 'command_execution') {
    const command = (item?.command as string) || (item?.input as string) || ''
    if (!sink.hasToolCall(itemId)) {
      sink.addToolCall({
        id: itemId,
        sessionId,
        toolName: 'Bash',
        input: { command },
        status: 'running',
        timestamp: Date.now(),
      })
    }
    const output = (item?.aggregated_output as string) || (item?.output as string) || ''
    const status = (item?.status as string) === 'failed'
      ? 'error'
      : (item?.status as string) === 'completed'
        ? 'completed'
        : 'running'
    sink.updateToolCall(itemId, {
      input: { command },
      status: status as 'running' | 'completed' | 'error',
      ...(output ? { result: output } : {}),
    })
  } else if (itemType === 'file_change') {
    const changes = item?.changes as Array<Record<string, unknown>> | undefined
    const filePath = (changes?.[0]?.path as string) || ''
    if (!sink.hasToolCall(itemId)) {
      sink.addToolCall({
        id: itemId,
        sessionId,
        toolName: 'Edit',
        input: { file_path: filePath },
        status: 'running',
        timestamp: Date.now(),
      })
    }
    sink.updateToolCall(itemId, {
      input: { file_path: filePath },
      status: (item?.status as string) === 'failed' ? 'error' : 'running',
    })
  } else if (itemType === 'mcp_tool_call') {
    const server = (item?.server as string) || ''
    const tool = (item?.tool as string) || 'MCP'
    const displayName = server ? `${server}/${tool}` : tool
    if (!sink.hasToolCall(itemId)) {
      sink.addToolCall({
        id: itemId,
        sessionId,
        toolName: displayName,
        input: (item?.arguments as Record<string, unknown>) || {},
        status: 'running',
        timestamp: Date.now(),
      })
    }
    sink.updateToolCall(itemId, {
      input: (item?.arguments as Record<string, unknown>) || {},
      status: (item?.status as string) === 'failed' ? 'error' : 'running',
    })
  } else if (itemType === 'web_search') {
    const input = normalizeWebSearchInput(item)
    if (!sink.hasToolCall(itemId)) {
      sink.addToolCall({
        id: itemId,
        sessionId,
        toolName: 'WebSearch',
        input,
        status: 'running',
        timestamp: Date.now(),
      })
    }
    sink.updateToolCall(itemId, {
      input,
      status: 'running',
    })
  } else if (itemType === 'todo_list') {
    const items = item?.items as Array<Record<string, unknown>> | undefined
    if (!sink.hasToolCall(itemId)) {
      sink.addToolCall({
        id: itemId,
        sessionId,
        toolName: 'TodoWrite',
        input: { todos: normalizeTodoItems(items) },
        status: 'running',
        timestamp: Date.now(),
      })
    }
    sink.updateToolCall(itemId, {
      input: { todos: normalizeTodoItems(items) },
      status: 'running',
    })
  }
}

export function handleItemCompleted(sessionId: string, item: Record<string, unknown>, state: CodexStreamItemState, sink: CodexStreamItemSink): void {
  const itemType = item?.type as string
  const itemId = (item?.id as string) || state.currentItemId

  if (itemType === 'agent_message') {
    const text = (item?.text as string) || (item?.content as string) || state.currentAssistantText
    sink.addMessage({
      id: `msg-${Date.now()}`,
      sessionId,
      role: 'assistant',
      content: text,
      thinking: state.currentThinkingText || undefined,
      timestamp: Date.now(),
    })
    state.currentAssistantText = ''
    state.currentThinkingText = ''
    state.currentThinkingByItemId = {}
  } else if (isThinkingItemType(itemType)) {
    appendThinkingFromItem(item, state, sink)
  } else if (itemType === 'command_execution') {
    const output = (item?.aggregated_output as string) || (item?.output as string) || (item?.result as string) || ''
    const status = (item?.status as string) === 'failed' ? 'error' : 'completed'
    const exitCode = typeof item?.exit_code === 'number' ? item.exit_code as number : undefined
    if (!sink.hasToolCall(itemId)) {
      sink.addToolCall({
        id: itemId,
        sessionId,
        toolName: 'Bash',
        input: { command: (item?.command as string) || '' },
        status: 'running',
        timestamp: Date.now(),
      })
    }
    const result = status === 'error' && exitCode !== undefined
      ? `[exit ${exitCode}]\n${output}`
      : output
    sink.updateToolCall(itemId, {
      status: status as 'completed' | 'error',
      result,
    })
  } else if (itemType === 'file_change') {
    const changes = item?.changes as Array<Record<string, unknown>> | undefined
    const diff = changes?.map(c => c.diff || `${c.kind}: ${c.path}`).join('\n') || 'File changed'
    const filePath = (changes?.[0]?.path as string) || ''
    if (!sink.hasToolCall(itemId)) {
      sink.addToolCall({
        id: itemId,
        sessionId,
        toolName: 'Edit',
        input: { file_path: filePath },
        status: 'running',
        timestamp: Date.now(),
      })
    }
    sink.updateToolCall(itemId, {
      status: (item?.status as string) === 'failed' ? 'error' : 'completed',
      result: diff as string,
    })
  } else if (itemType === 'mcp_tool_call') {
    const status = (item?.status as string) === 'failed' ? 'error' : 'completed'
    const server = (item?.server as string) || ''
    const tool = (item?.tool as string) || 'MCP'
    const displayName = server ? `${server}/${tool}` : tool
    const errObj = item?.error as { message?: string } | undefined
    const result = status === 'error'
      ? (errObj?.message || JSON.stringify(item?.error ?? 'MCP call failed'))
      : (item?.result !== undefined ? normalizeToolResult(item.result) : '')
    if (!sink.hasToolCall(itemId)) {
      sink.addToolCall({
        id: itemId,
        sessionId,
        toolName: displayName,
        input: (item?.arguments as Record<string, unknown>) || {},
        status: 'running',
        timestamp: Date.now(),
      })
    }
    sink.updateToolCall(itemId, {
      status: status as 'completed' | 'error',
      result,
    })
  } else if (itemType === 'web_search') {
    const input = normalizeWebSearchInput(item)
    if (!sink.hasToolCall(itemId)) {
      sink.addToolCall({
        id: itemId,
        sessionId,
        toolName: 'WebSearch',
        input,
        status: 'running',
        timestamp: Date.now(),
      })
    }
    sink.updateToolCall(itemId, {
      input,
      status: 'completed',
      result: input.query ? `Search completed: ${String(input.query)}` : 'Search completed',
    })
  } else if (itemType === 'todo_list') {
    const items = item?.items as Array<Record<string, unknown>> | undefined
    const todos = normalizeTodoItems(items)
    const summary = todos.map(t => `${t.status === 'completed' ? '[x]' : '[ ]'} ${t.content}`).join('\n') || 'Todo list updated'
    if (!sink.hasToolCall(itemId)) {
      sink.addToolCall({
        id: itemId,
        sessionId,
        toolName: 'TodoWrite',
        input: { todos },
        status: 'running',
        timestamp: Date.now(),
      })
    }
    sink.updateToolCall(itemId, {
      input: { todos },
      status: 'completed',
      result: summary,
    })
  } else if (itemType === 'error') {
    sink.sendError(stringifyCodexError(item?.message ?? item?.error))
  }
}
