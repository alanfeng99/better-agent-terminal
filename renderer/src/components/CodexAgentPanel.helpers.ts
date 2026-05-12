import type { MessageItem } from './CodexAgentPanel.types'
import { summarizeAskUserInput } from './AskUserQuestion.helpers'

export function shouldAutoContinueAfterTurnEnd(payload: { reason?: string; error?: string } | null | undefined): boolean {
  if (!payload) return false
  if (payload.reason === 'completed') return true
  if (payload.reason !== 'error') return false
  const error = payload.error || ''
  return /codex:\s*no response from model after \d+s\.\s*please try again\./i.test(error)
}

export function toolInputSummary(_toolName: string, input: Record<string, unknown>): string {
  const askUserSummary = summarizeAskUserInput(input)
  if (askUserSummary) return askUserSummary
  if (input.command) return String(input.command).slice(0, 80)
  if (input.file_path) return String(input.file_path)
  if (input.pattern) return String(input.pattern)
  if (input.query) return String(input.query).slice(0, 80)
  if (input.url) return String(input.url).slice(0, 80)
  if (input.prompt) return String(input.prompt).slice(0, 80)
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  return keys.slice(0, 2).map(k => `${k}: ${String(input[k]).slice(0, 40)}`).join(', ')
}

export function truncateMiddle(text: string, max = 220): string {
  if (text.length <= max) return text
  const head = Math.max(20, Math.floor(max * 0.65))
  const tail = Math.max(10, max - head - 3)
  return `${text.slice(0, head)}...${text.slice(-tail)}`
}

export function firstMeaningfulLine(text: string): string {
  return text.split(/\r?\n/).find(line => line.trim().length > 0)?.trim() || ''
}

export function formatContentSize(text: string): string {
  const lines = text ? text.split(/\r?\n/).length : 0
  const chars = text.length
  if (lines <= 1) return `${chars.toLocaleString()} chars`
  return `${lines.toLocaleString()} lines · ${chars.toLocaleString()} chars`
}

export function toolInputContent(input: Record<string, unknown>): string {
  if (input.command) return String(input.command)
  if (input.file_path) return String(input.file_path)
  if (input.pattern) return String(input.pattern)
  if (input.query) return String(input.query)
  if (input.url) return String(input.url)
  if (input.prompt) return String(input.prompt)
  return JSON.stringify(input, null, 2)
}

export function toolDescription(input: Record<string, unknown>): string | null {
  if (input.description) return String(input.description)
  return null
}

export function splitSystemReminders(text: string): { content: string; reminders: string[]; errors: string[] } {
  const reminders: string[] = []
  const errors: string[] = []
  let content = text.replace(/<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>/g, (_match, inner) => {
    reminders.push(inner.trim())
    return ''
  })
  content = content.replace(/<tool_use_error>\s*([\s\S]*?)\s*<\/tool_use_error>/g, (_match, inner) => {
    errors.push(inner.trim())
    return ''
  }).trim()
  return { content, reminders, errors }
}

export function parseContentBlocks(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return text
  try {
    const parsed = JSON.parse(trimmed)
    const extractTextBlocks = (value: unknown): string | null => {
      if (Array.isArray(value)) {
        const texts = value
          .filter((b: { type?: string; text?: string }) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b: { text: string }) => b.text)
        return texts.length > 0 ? texts.join('\n\n') : null
      }
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (record.content !== undefined) return extractTextBlocks(record.content)
        if (typeof record.text === 'string') return record.text
        const entries = Object.entries(record)
        if (entries.length > 0 && entries.every(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null)) {
          return entries.map(([key, v]) => `${key}:\n${String(v ?? '')}`).join('\n\n')
        }
      }
      return null
    }
    const extracted = extractTextBlocks(parsed)
    if (!extracted) return text
    return extracted.trim().startsWith('{') || extracted.trim().startsWith('[')
      ? parseContentBlocks(extracted)
      : extracted
  } catch {
    return text
  }
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (isToday) return time
  return d.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function formatFullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatElapsed(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function shouldShowTimeDivider(current: MessageItem, prevItem: MessageItem | undefined): boolean {
  if (!prevItem) return false
  const curTs = current.timestamp || 0
  const prevTs = prevItem.timestamp || 0
  if (!curTs || !prevTs) return false
  return (curTs - prevTs) > 30 * 60 * 1000
}
