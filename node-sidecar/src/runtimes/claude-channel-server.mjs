import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function buildClaudeChannelServerSource() {
  return `#!/usr/bin/env node
const bridgeUrl = process.env.BAT_CHANNEL_BRIDGE_URL
const sessionId = process.env.BAT_CHANNEL_SESSION_ID

if (!bridgeUrl || !sessionId) {
  process.stderr.write('[bat-channel] BAT_CHANNEL_BRIDGE_URL and BAT_CHANNEL_SESSION_ID are required\\n')
  process.exit(2)
}

const instructions = [
  'Messages from Better Agent Terminal arrive as <channel source="bat" ...> events.',
  'Treat each BAT channel event as a user instruction for this Claude Code agent session.',
  'When you need to show a response in Better Agent Terminal, call the bat_reply tool.',
  'Include the bat_session_id and bat_message_id from the channel metadata when replying.',
].join(' ')

const capabilities = {
  experimental: { 'claude/channel': {} },
  tools: {},
}

const toolsResult = {
  tools: [{
    name: 'bat_reply',
    description: 'Send a visible response back to Better Agent Terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        bat_session_id: { type: 'string' },
        bat_message_id: { type: 'string' },
        text: { type: 'string' },
        status: { type: 'string', enum: ['partial', 'final', 'error'] },
      },
      required: ['bat_session_id', 'text'],
      additionalProperties: true,
    },
  }],
}

let initialized = false
let pollStarted = false
let readySent = false
let stdinBuffer = Buffer.alloc(0)

function writeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n')
  process.stdout.write(body)
}

function writeResult(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result })
}

function writeError(id, code, message) {
  writeFrame({ jsonrpc: '2.0', id, error: { code, message } })
}

function sendNotification(method, params) {
  writeFrame({ jsonrpc: '2.0', method, params })
}

async function handleToolCall(id, params) {
  const name = params?.name
  const args = params?.arguments || {}
  if (name !== 'bat_reply') {
    throw new Error('Unknown BAT channel tool: ' + String(name))
  }
  const response = await fetch(new URL('/reply', bridgeUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, ...args }),
  })
  if (!response.ok) {
    throw new Error('BAT reply bridge failed: HTTP ' + response.status)
  }
  writeResult(id, {
    content: [{ type: 'text', text: 'Delivered to Better Agent Terminal.' }],
  })
}

async function notifyReady() {
  if (readySent) return
  readySent = true
  const response = await fetch(new URL('/ready', bridgeUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
  if (!response.ok) {
    throw new Error('BAT ready bridge failed: HTTP ' + response.status)
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return
  const id = message.id
  const method = message.method
  const params = message.params || {}
  if (method === 'initialize') {
    writeResult(id, {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities,
      serverInfo: { name: 'bat', version: '0.0.1' },
      instructions,
    })
    return
  }
  if (method === 'notifications/initialized') {
    initialized = true
    await notifyReady()
    startPollLoop()
    return
  }
  if (method === 'ping') {
    writeResult(id, {})
    return
  }
  if (method === 'tools/list') {
    writeResult(id, toolsResult)
    return
  }
  if (method === 'tools/call') {
    await handleToolCall(id, params)
    return
  }
  if (id !== undefined && id !== null) {
    writeError(id, -32601, 'Method not found: ' + String(method))
  }
}

function drainFrames() {
  while (true) {
    const headerEnd = stdinBuffer.indexOf('\\r\\n\\r\\n')
    if (headerEnd < 0) return
    const header = stdinBuffer.slice(0, headerEnd).toString('utf8')
    const match = /content-length:\\s*(\\d+)/i.exec(header)
    if (!match) {
      process.stderr.write('[bat-channel] missing Content-Length header\\n')
      process.exit(3)
    }
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + length
    if (stdinBuffer.length < bodyEnd) return
    const body = stdinBuffer.slice(bodyStart, bodyEnd).toString('utf8')
    stdinBuffer = stdinBuffer.slice(bodyEnd)
    let message
    try {
      message = JSON.parse(body)
    } catch (err) {
      process.stderr.write('[bat-channel] invalid JSON-RPC frame: ' + (err instanceof Error ? err.message : String(err)) + '\\n')
      continue
    }
    void handleMessage(message).catch(err => {
      if (message?.id !== undefined && message?.id !== null) {
        writeError(message.id, -32000, err instanceof Error ? err.message : String(err))
      } else {
        process.stderr.write('[bat-channel] notification failed: ' + (err instanceof Error ? err.message : String(err)) + '\\n')
      }
    })
  }
}

async function pollOnce() {
  const url = new URL('/events', bridgeUrl)
  url.searchParams.set('sessionId', sessionId)
  const response = await fetch(url)
  if (response.status === 204) return
  if (!response.ok) {
    throw new Error('BAT event bridge failed: HTTP ' + response.status)
  }
  const event = await response.json()
  if (!initialized) return
  sendNotification('notifications/claude/channel', {
    content: String(event.content || ''),
    meta: event.meta || {},
  })
}

async function pollLoop() {
  while (true) {
    try {
      await pollOnce()
    } catch (err) {
      process.stderr.write('[bat-channel] poll failed: ' + (err instanceof Error ? err.message : String(err)) + '\\n')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

function startPollLoop() {
  if (pollStarted) return
  pollStarted = true
  void pollLoop()
}

process.stdin.on('data', chunk => {
  stdinBuffer = Buffer.concat([stdinBuffer, Buffer.from(chunk)])
  drainFrames()
})
process.stdin.on('end', () => process.exit(0))
`
}

export async function writeClaudeChannelServerScript(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const source = buildClaudeChannelServerSource()
  await writeFile(path, source, { mode: 0o700 })
  return path
}
