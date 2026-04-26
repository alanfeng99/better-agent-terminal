import type { ClaudeToolCall } from '../../src/types/claude-agent'

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function parseJsonValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return value
  if (!['{', '[', '"'].includes(trimmed[0])) return value
  try { return JSON.parse(trimmed) } catch { return value }
}

function textFromContentBlocks(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const texts = value
      .map(item => {
        const record = item && typeof item === 'object' ? item as Record<string, unknown> : undefined
        if (record?.type === 'text' && typeof record.text === 'string') return record.text
        if (record?.type === 'summary_text' && typeof record.text === 'string') return record.text
        if (record?.content !== undefined) return textFromContentBlocks(record.content)
        if (record?.summary !== undefined) return textFromContentBlocks(record.summary)
        if (typeof item === 'string') return item
        return undefined
      })
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
    return texts.length > 0 ? texts.join('\n\n') : undefined
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.content !== undefined) return textFromContentBlocks(record.content)
    if (typeof record.text === 'string') return record.text
  }
  return undefined
}

export function extractReasoningTextFromResponseItem(payload: Record<string, unknown>): string {
  if (payload.type !== 'reasoning' && payload.type !== 'agent_reasoning' && payload.type !== 'reasoning_summary' && payload.type !== 'thinking') {
    return ''
  }
  const text = textFromContentBlocks(payload.text)
    ?? textFromContentBlocks(payload.content)
    ?? textFromContentBlocks(payload.summary)
  return text?.trim() || ''
}

function formatObjectTextMap(value: unknown): string | undefined {
  const parsed = typeof value === 'string' ? parseJsonValue(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) return undefined
  if (!entries.every(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null)) return undefined
  return entries.map(([key, v]) => `${key}:\n${String(v ?? '')}`).join('\n\n')
}

export function normalizeToolResult(value: unknown): string {
  const contentText = textFromContentBlocks(value)
  if (contentText !== undefined) return formatObjectTextMap(contentText) ?? contentText
  const objectText = formatObjectTextMap(value)
  if (objectText !== undefined) return objectText
  if (typeof value === 'string') return value
  return JSON.stringify(value ?? '')
}

function parseFunctionArguments(payload: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseJsonRecord(payload.arguments ?? payload.input)
  if (parsed) return parsed
  if (typeof payload.input === 'string') return { input: payload.input }
  if (typeof payload.arguments === 'string') return { input: payload.arguments }
  return {}
}

function toolNameForResponseItem(name: string): string {
  if (name === 'shell_command') return 'Bash'
  if (name === 'apply_patch') return 'ApplyPatch'
  if (name === 'update_plan') return 'TodoWrite'
  if (name === 'view_image') return 'ViewImage'
  return name || 'Tool'
}

function toolInputForResponseItem(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'shell_command') {
    return {
      command: typeof args.command === 'string' ? args.command : String(args.input ?? ''),
      ...(typeof args.workdir === 'string' ? { workdir: args.workdir } : {}),
      ...(typeof args.timeout_ms === 'number' ? { timeoutMs: args.timeout_ms } : {}),
    }
  }
  if (name === 'apply_patch') {
    return { patch: typeof args.input === 'string' ? args.input : JSON.stringify(args, null, 2) }
  }
  if (name === 'update_plan') {
    const plan = Array.isArray(args.plan) ? args.plan : []
    return {
      todos: plan.map(item => {
        const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
        return {
          content: String(record.step ?? ''),
          status: String(record.status ?? 'pending'),
        }
      }),
    }
  }
  return args
}

export function buildToolCallFromResponseItem(sessionId: string, payload: Record<string, unknown>, timestamp: number): ClaudeToolCall | null {
  const callId = String(payload.call_id || payload.id || '')
  const name = String(payload.name || '')
  if (!callId || !name) return null
  const args = parseFunctionArguments(payload)
  return {
    id: callId,
    sessionId,
    toolName: toolNameForResponseItem(name),
    input: toolInputForResponseItem(name, args),
    status: 'running',
    timestamp,
  }
}

export function resultFromResponseItemOutput(payload: Record<string, unknown>): { result: string; status: 'completed' | 'error' } {
  const rawOutput = typeof payload.output === 'string' ? payload.output : normalizeToolResult(payload.output)
  const parsed = parseJsonRecord(rawOutput)
  const outputText = parsed?.output !== undefined ? normalizeToolResult(parsed.output) : rawOutput
  const metadata = parsed?.metadata && typeof parsed.metadata === 'object' ? parsed.metadata as Record<string, unknown> : undefined
  const exitCode = typeof metadata?.exit_code === 'number'
    ? metadata.exit_code
    : /^Exit code:\s*(-?\d+)/m.exec(outputText)?.[1]
  const status = exitCode !== undefined && Number(exitCode) !== 0 ? 'error' : 'completed'
  return { result: outputText.slice(0, 8000), status }
}
