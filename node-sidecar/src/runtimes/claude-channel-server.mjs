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
  'Messages from Better Agent Terminal arrive as <channel source="bat" ...> events; treat each as a user instruction for this Claude Code agent session.',
  'Better Agent Terminal observes your work directly through Claude Code hooks — you do NOT need to narrate tool calls, results, or progress back through any channel tool.',
  'Just respond normally; BAT receives assistant text, tool_use, and tool_result events via the hook bridge.',
  'The bat_assistant / bat_tool_use / bat_tool_result / bat_emit_frame / bat_reply tools remain available as a legacy fallback only — do not call them under normal operation.',
].join(' ')

const capabilities = {
  experimental: { 'claude/channel': {} },
  tools: {},
}

const FRAME_KINDS = ['assistant', 'tool_use', 'tool_result', 'thinking', 'usage', 'result', 'status', 'error']

const toolsResult = {
  tools: [
    {
      name: 'bat_assistant',
      description: 'Send an assistant text block back to Better Agent Terminal. Use for streamed (status:"partial") and final (status:"final") chunks of the visible response.',
      inputSchema: {
        type: 'object',
        properties: {
          bat_session_id: { type: 'string' },
          bat_message_id: { type: 'string' },
          text: { type: 'string' },
          status: { type: 'string', enum: ['partial', 'final'] },
        },
        required: ['text'],
        additionalProperties: true,
      },
    },
    {
      name: 'bat_tool_use',
      description: 'Announce a tool call to Better Agent Terminal BEFORE executing it. id and name are required; input is the JSON arguments you will pass.',
      inputSchema: {
        type: 'object',
        properties: {
          bat_session_id: { type: 'string' },
          bat_message_id: { type: 'string' },
          id: { type: 'string' },
          name: { type: 'string' },
          input: {},
        },
        required: ['id', 'name'],
        additionalProperties: true,
      },
    },
    {
      name: 'bat_tool_result',
      description: 'Report the result of a tool call to Better Agent Terminal. tool_use_id must match the id from the prior bat_tool_use.',
      inputSchema: {
        type: 'object',
        properties: {
          bat_session_id: { type: 'string' },
          bat_message_id: { type: 'string' },
          tool_use_id: { type: 'string' },
          content: {},
          is_error: { type: 'boolean' },
        },
        required: ['tool_use_id'],
        additionalProperties: true,
      },
    },
    {
      name: 'bat_emit_frame',
      description: 'Emit a structured BAT channel frame. kind ∈ {thinking, usage, result, status, error}. payload shape varies by kind: thinking{text,status?}; usage{input_tokens?,output_tokens?,cache_read_input_tokens?,cache_creation_input_tokens?,model?,cost_usd?}; result{status:"success"|"error",stop_reason?,error?}; status{state,message?}; error{message,code?}.',
      inputSchema: {
        type: 'object',
        properties: {
          bat_session_id: { type: 'string' },
          bat_message_id: { type: 'string' },
          kind: { type: 'string', enum: FRAME_KINDS },
          payload: { type: 'object' },
        },
        required: ['kind', 'payload'],
        additionalProperties: true,
      },
    },
    {
      name: 'bat_reply',
      description: 'Legacy. Send a final visible response back to Better Agent Terminal. Prefer bat_assistant + bat_emit_frame{kind:"result"}.',
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
    },
  ],
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

function pickMeta(args) {
  const meta = {}
  if (args && typeof args.bat_session_id === 'string') meta.bat_session_id = args.bat_session_id
  if (args && typeof args.bat_message_id === 'string') meta.bat_message_id = args.bat_message_id
  return meta
}

function stripMeta(args) {
  if (!args || typeof args !== 'object') return {}
  const copy = { ...args }
  delete copy.bat_session_id
  delete copy.bat_message_id
  return copy
}

async function postBridge(path, body) {
  const response = await fetch(new URL(path, bridgeUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error('BAT bridge ' + path + ' failed: HTTP ' + response.status)
  }
  return response
}

async function postFrame(kind, payload, meta) {
  await postBridge('/frame', { sessionId, kind, payload, meta })
}

async function handleToolCall(id, params) {
  const name = params?.name
  const args = params?.arguments || {}
  const meta = pickMeta(args)
  if (name === 'bat_assistant') {
    const text = typeof args.text === 'string' ? args.text : ''
    const status = args.status === 'partial' ? 'partial' : 'final'
    await postFrame('assistant', { text, status, id: typeof args.id === 'string' ? args.id : undefined }, meta)
    writeResult(id, { content: [{ type: 'text', text: 'Assistant frame delivered.' }] })
    return
  }
  if (name === 'bat_tool_use') {
    const payload = stripMeta(args)
    await postFrame('tool_use', payload, meta)
    writeResult(id, { content: [{ type: 'text', text: 'Tool use frame delivered.' }] })
    return
  }
  if (name === 'bat_tool_result') {
    const payload = stripMeta(args)
    await postFrame('tool_result', payload, meta)
    writeResult(id, { content: [{ type: 'text', text: 'Tool result frame delivered.' }] })
    return
  }
  if (name === 'bat_emit_frame') {
    const kind = typeof args.kind === 'string' ? args.kind : ''
    const payload = (args.payload && typeof args.payload === 'object') ? args.payload : {}
    if (!FRAME_KINDS.includes(kind)) {
      throw new Error('Unknown BAT frame kind: ' + kind)
    }
    await postFrame(kind, payload, meta)
    writeResult(id, { content: [{ type: 'text', text: 'Frame ' + kind + ' delivered.' }] })
    return
  }
  if (name === 'bat_reply') {
    await postBridge('/reply', { sessionId, ...args })
    writeResult(id, { content: [{ type: 'text', text: 'Delivered to Better Agent Terminal.' }] })
    return
  }
  throw new Error('Unknown BAT channel tool: ' + String(name))
}

async function notifyReady() {
  if (readySent) return
  readySent = true
  await postBridge('/ready', { sessionId })
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
