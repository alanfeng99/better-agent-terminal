import { createReadStream, promises as fs } from 'fs'
import os from 'os'
import * as path from 'path'
import * as readline from 'readline'
import type { ClaudeToolCall } from '../../src/types/claude-agent'
import type { SessionSummary } from '../claude-agent-manager'
import { logger } from '../logger'
import { getCachedDateHint, getCachedLogPath, setCachedLogPath } from './log-cache'
import { buildToolCallFromResponseItem, extractReasoningTextFromResponseItem, resultFromResponseItemOutput } from './response-items'
import type { HistoryItem } from './types'

export function getCodexSessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions')
}

async function listSubdirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => b.localeCompare(a))
}

async function findMatchInDay(dayPath: string, threadId: string): Promise<string | null> {
  const files = await fs.readdir(dayPath, { withFileTypes: true }).catch(() => [])
  const match = files.find(entry => entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith('.jsonl'))
  return match ? path.join(dayPath, match.name) : null
}

export async function findSessionLogForThread(threadId: string): Promise<string | null> {
  const cached = await getCachedLogPath(threadId)
  if (cached) return cached

  const root = getCodexSessionsRoot()
  const hint = await getCachedDateHint(threadId)

  if (hint?.year && hint?.month && hint?.day) {
    const probe = path.join(root, hint.year, hint.month, hint.day)
    const direct = await findMatchInDay(probe, threadId)
    if (direct) {
      await setCachedLogPath(threadId, direct)
      return direct
    }
  }

  const years = await listSubdirs(root)
  const monthsByYear = await Promise.all(years.map(async y => ({ y, months: await listSubdirs(path.join(root, y)) })))
  const dayPaths: string[] = []
  await Promise.all(
    monthsByYear.flatMap(({ y, months }) => months.map(async m => {
      const monthPath = path.join(root, y, m)
      const days = await listSubdirs(monthPath)
      for (const d of days) dayPaths.push(path.join(monthPath, d))
    }))
  )
  dayPaths.sort((a, b) => b.localeCompare(a))

  const found = await new Promise<string | null>(resolve => {
    let pending = dayPaths.length
    let done = false
    if (pending === 0) return resolve(null)
    for (const dayPath of dayPaths) {
      findMatchInDay(dayPath, threadId).then(match => {
        if (done) return
        if (match) {
          done = true
          resolve(match)
          return
        }
        pending--
        if (pending === 0 && !done) {
          done = true
          resolve(null)
        }
      }).catch(() => {
        if (done) return
        pending--
        if (pending === 0 && !done) {
          done = true
          resolve(null)
        }
      })
    }
  })

  if (found) await setCachedLogPath(threadId, found)
  return found
}

export async function* iterateJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (line.trim()) yield line
    }
  } finally {
    rl.close()
    stream.destroy()
  }
}

export async function readModelFromSessionLog(threadId: string): Promise<string | undefined> {
  const sessionLogPath = await findSessionLogForThread(threadId)
  if (!sessionLogPath) return undefined

  try {
    for await (const line of iterateJsonlLines(sessionLogPath)) {
      try {
        const entry = JSON.parse(line) as {
          type?: string
          payload?: {
            model?: string
            collaboration_mode?: { settings?: { model?: string } }
          }
        }
        if (entry.type === 'turn_context') {
          const model = entry.payload?.model || entry.payload?.collaboration_mode?.settings?.model
          if (model) return model
        }
      } catch {
        // Ignore malformed log lines and keep scanning.
      }
    }
  } catch {
    // Stream errors fall through to undefined.
  }

  return undefined
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now()
  const ts = Date.parse(value)
  return Number.isNaN(ts) ? Date.now() : ts
}

export async function loadSessionHistoryItems(sessionId: string, threadId: string): Promise<{ items: HistoryItem[]; sessionLogPath: string | null; durationMs: number }> {
  const startedAt = Date.now()
  const sessionLogPath = await findSessionLogForThread(threadId)
  if (!sessionLogPath) {
    return { items: [], sessionLogPath: null, durationMs: Date.now() - startedAt }
  }

  const items: HistoryItem[] = []
  const toolIndexById = new Map<string, number>()
  let pendingThinkingText = ''

  try {
    for await (const line of iterateJsonlLines(sessionLogPath)) {
      try {
        const entry = JSON.parse(line) as {
          timestamp?: string
          type?: string
          payload?: Record<string, unknown>
        }
        if (entry.type === 'response_item' && entry.payload) {
          const ts = parseTimestamp(entry.timestamp)
          const payloadType = entry.payload.type
          if (payloadType === 'reasoning' || payloadType === 'agent_reasoning' || payloadType === 'reasoning_summary' || payloadType === 'thinking') {
            const thinkingText = extractReasoningTextFromResponseItem(entry.payload)
            if (thinkingText) pendingThinkingText += pendingThinkingText ? `\n\n${thinkingText}` : thinkingText
          } else if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
            const toolCall = buildToolCallFromResponseItem(sessionId, entry.payload, ts)
            if (toolCall) {
              const existingIndex = toolIndexById.get(toolCall.id)
              if (existingIndex !== undefined) {
                items[existingIndex] = { ...(items[existingIndex] as ClaudeToolCall), ...toolCall }
              } else {
                toolIndexById.set(toolCall.id, items.length)
                items.push(toolCall)
              }
            }
          } else if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
            const callId = String(entry.payload.call_id || entry.payload.id || '')
            if (callId) {
              const result = resultFromResponseItemOutput(entry.payload)
              const existingIndex = toolIndexById.get(callId)
              if (existingIndex !== undefined) {
                items[existingIndex] = { ...(items[existingIndex] as ClaudeToolCall), ...result }
              } else {
                toolIndexById.set(callId, items.length)
                items.push({
                  id: callId,
                  sessionId,
                  toolName: 'Tool',
                  input: {},
                  status: result.status,
                  result: result.result,
                  timestamp: ts,
                })
              }
            }
          }
          continue
        }

        if (entry.type !== 'event_msg' || !entry.payload) continue

        const ts = parseTimestamp(entry.timestamp)
        const eventType = entry.payload.type
        if (typeof eventType !== 'string') continue

        if (eventType === 'user_message') {
          const message = entry.payload.message
          if (typeof message === 'string' && message.trim()) {
            items.push({
              id: `hist-user-${items.length}`,
              sessionId,
              role: 'user',
              content: message,
              timestamp: ts,
            })
          }
          continue
        }

        if (eventType === 'agent_message') {
          const message = entry.payload.message
          if (typeof message === 'string' && message.trim()) {
            const last = items[items.length - 1]
            if (last && !('toolName' in last) && last.role === 'assistant') {
              last.content = `${last.content.trimEnd()}\n\n${message.trimStart()}`
              if (pendingThinkingText) {
                last.thinking = [last.thinking, pendingThinkingText].filter(Boolean).join('\n\n')
              }
              last.timestamp = ts
            } else {
              items.push({
              id: `hist-assistant-${items.length}`,
              sessionId,
              role: 'assistant',
              content: message,
              ...(pendingThinkingText ? { thinking: pendingThinkingText } : {}),
              timestamp: ts,
              })
            }
            pendingThinkingText = ''
          }
          continue
        }

        if (eventType === 'exec_command_end') {
          const toolId = String(entry.payload.call_id || `hist-bash-${items.length}`)
          const cmd = Array.isArray(entry.payload.command)
            ? entry.payload.command.map(part => String(part)).join(' ')
            : ''
          const aggregatedOutput = typeof entry.payload.aggregated_output === 'string'
            ? entry.payload.aggregated_output
            : ''
          const stderr = typeof entry.payload.stderr === 'string' ? entry.payload.stderr : ''
          const stdout = typeof entry.payload.stdout === 'string' ? entry.payload.stdout : ''
          const result = aggregatedOutput || stdout || stderr
          items.push({
            id: toolId,
            sessionId,
            toolName: 'Bash',
            input: { command: cmd },
            status: entry.payload.exit_code === 0 ? 'completed' : 'error',
            ...(result ? { result: result.slice(0, 4000) } : {}),
            timestamp: ts,
          })
          toolIndexById.set(toolId, items.length - 1)
          continue
        }

        if (eventType === 'patch_apply_end') {
          const toolId = String(entry.payload.call_id || `hist-edit-${items.length}`)
          const changes = entry.payload.changes
          const changedFiles = changes && typeof changes === 'object'
            ? Object.keys(changes as Record<string, unknown>)
            : []
          const stdout = typeof entry.payload.stdout === 'string' ? entry.payload.stdout : ''
          const stderr = typeof entry.payload.stderr === 'string' ? entry.payload.stderr : ''
          const summary = stdout || stderr || (changedFiles.length > 0 ? changedFiles.join('\n') : 'Patch applied')
          items.push({
            id: toolId,
            sessionId,
            toolName: 'Edit',
            input: { files: changedFiles },
            status: entry.payload.success === false ? 'error' : 'completed',
            result: summary.slice(0, 4000),
            timestamp: ts,
          })
          toolIndexById.set(toolId, items.length - 1)
        }
      } catch {
        // Ignore malformed log lines and keep scanning.
      }
    }
  } catch (err) {
    logger.error(`[codex:${sessionId.slice(0, 8)}] Failed to stream session log:`, err)
  }

  return { items, sessionLogPath, durationMs: Date.now() - startedAt }
}

export async function listCodexSessionSummaries(): Promise<SessionSummary[]> {
  const root = getCodexSessionsRoot()
  const results: SessionSummary[] = []

  const yearDirs = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const yearDir of yearDirs.filter(e => e.isDirectory())) {
    const yearPath = path.join(root, yearDir.name)
    const monthDirs = await fs.readdir(yearPath, { withFileTypes: true }).catch(() => [])
    for (const monthDir of monthDirs.filter(e => e.isDirectory())) {
      const monthPath = path.join(yearPath, monthDir.name)
      const dayDirs = await fs.readdir(monthPath, { withFileTypes: true }).catch(() => [])
      for (const dayDir of dayDirs.filter(e => e.isDirectory())) {
        const dayPath = path.join(monthPath, dayDir.name)
        const files = await fs.readdir(dayPath, { withFileTypes: true }).catch(() => [])
        for (const file of files.filter(e => e.isFile() && e.name.endsWith('.jsonl'))) {
          const filePath = path.join(dayPath, file.name)
          const threadId = file.name.replace(/\.jsonl$/, '')
          try {
            const stat = await fs.stat(filePath)
            const content = await fs.readFile(filePath, 'utf8').catch(() => '')
            let preview = ''
            for (const line of content.split('\n')) {
              if (!line.trim()) continue
              try {
                const entry = JSON.parse(line) as { type?: string; payload?: { input?: string; op?: { type?: string; content?: { type?: string; text?: string }[] } } }
                const input = entry.payload?.input || entry.payload?.op?.content?.find?.(c => c.type === 'input_text')?.text
                if (input && typeof input === 'string') {
                  preview = input.split('\n')[0].slice(0, 120)
                  break
                }
              } catch {
                // Skip malformed lines.
              }
            }
            results.push({
              sdkSessionId: threadId,
              timestamp: stat.mtimeMs,
              preview: preview || `(${threadId.slice(0, 8)}...)`,
              messageCount: 0,
            })
          } catch {
            // Skip unreadable files.
          }
        }
      }
    }
  }

  return results.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50)
}
