// Shared frame vocabulary for the Claude Channel Agent path.
//
// Both the BAT channel MCP server (spawned by Claude Code) and the sidecar
// bridge (claude-channel-runtime.mjs) speak this vocabulary so the renderer
// receives one consistent event shape per kind regardless of which BAT tool
// Claude chose. Phase A wires the structure; Phase B will align the emitted
// event names with claude-send.mjs's `claude:*` contract.

export const FRAME_KINDS = Object.freeze({
  ASSISTANT: 'assistant',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result',
  THINKING: 'thinking',
  USAGE: 'usage',
  RESULT: 'result',
  STATUS: 'status',
  ERROR: 'error',
})

export const FRAME_KIND_LIST = Object.freeze(Object.values(FRAME_KINDS))

const SUB_EVENT_NAMES = Object.freeze({
  [FRAME_KINDS.ASSISTANT]: 'assistant',
  [FRAME_KINDS.TOOL_USE]: 'tool-use',
  [FRAME_KINDS.TOOL_RESULT]: 'tool-result',
  [FRAME_KINDS.THINKING]: 'thinking',
  [FRAME_KINDS.USAGE]: 'usage',
  [FRAME_KINDS.RESULT]: 'result',
  [FRAME_KINDS.STATUS]: 'status-frame',
  [FRAME_KINDS.ERROR]: 'error-frame',
})

export function subEventNameFor(kind) {
  return SUB_EVENT_NAMES[kind] || null
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function asOptionalString(value) {
  return typeof value === 'string' ? value : undefined
}

function asOptionalBoolean(value) {
  return typeof value === 'boolean' ? value : undefined
}

function asOptionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function normalizeContent(value) {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value
  return value
}

// normalizeFrame returns a sanitized {kind, payload, meta} or null if the
// frame is invalid. Defensive because frames originate from arbitrary tool
// arguments Claude produced.
export function normalizeFrame(input) {
  const obj = asPlainObject(input)
  if (!obj) return null
  const kind = asString(obj.kind).toLowerCase()
  if (!kind || !SUB_EVENT_NAMES[kind]) return null
  const payload = asPlainObject(obj.payload) || {}
  const meta = asPlainObject(obj.meta) || {}
  const normalized = normalizePayload(kind, payload)
  if (!normalized) return null
  return { kind, payload: normalized, meta }
}

function normalizePayload(kind, payload) {
  switch (kind) {
    case FRAME_KINDS.ASSISTANT:
      return normalizeAssistantPayload(payload)
    case FRAME_KINDS.TOOL_USE:
      return normalizeToolUsePayload(payload)
    case FRAME_KINDS.TOOL_RESULT:
      return normalizeToolResultPayload(payload)
    case FRAME_KINDS.THINKING:
      return normalizeThinkingPayload(payload)
    case FRAME_KINDS.USAGE:
      return normalizeUsagePayload(payload)
    case FRAME_KINDS.RESULT:
      return normalizeResultPayload(payload)
    case FRAME_KINDS.STATUS:
      return normalizeStatusPayload(payload)
    case FRAME_KINDS.ERROR:
      return normalizeErrorPayload(payload)
    default:
      return null
  }
}

function normalizeAssistantPayload(payload) {
  const text = asString(payload.text)
  const status = asString(payload.status) || 'final'
  if (status !== 'partial' && status !== 'final') return null
  return {
    id: asOptionalString(payload.id),
    text,
    status,
  }
}

function normalizeToolUsePayload(payload) {
  const id = asString(payload.id) || asString(payload.tool_use_id)
  const name = asString(payload.name)
  if (!id || !name) return null
  const input = payload.input == null ? null : payload.input
  return {
    id,
    name,
    input,
  }
}

function normalizeToolResultPayload(payload) {
  const toolUseId = asString(payload.tool_use_id) || asString(payload.id)
  if (!toolUseId) return null
  const content = normalizeContent(payload.content)
  return {
    tool_use_id: toolUseId,
    content,
    is_error: asOptionalBoolean(payload.is_error) ?? false,
  }
}

function normalizeThinkingPayload(payload) {
  const text = asString(payload.text)
  if (!text) return null
  const status = asString(payload.status) || 'final'
  return {
    id: asOptionalString(payload.id),
    text,
    status: status === 'partial' ? 'partial' : 'final',
  }
}

function normalizeUsagePayload(payload) {
  return {
    input_tokens: asOptionalNumber(payload.input_tokens),
    output_tokens: asOptionalNumber(payload.output_tokens),
    cache_read_input_tokens: asOptionalNumber(payload.cache_read_input_tokens),
    cache_creation_input_tokens: asOptionalNumber(payload.cache_creation_input_tokens),
    model: asOptionalString(payload.model),
    cost_usd: asOptionalNumber(payload.cost_usd),
  }
}

function normalizeResultPayload(payload) {
  const status = asString(payload.status) || 'success'
  return {
    status: status === 'error' ? 'error' : 'success',
    stop_reason: asOptionalString(payload.stop_reason),
    error: asOptionalString(payload.error),
  }
}

function normalizeStatusPayload(payload) {
  const state = asString(payload.state)
  if (!state) return null
  return {
    state,
    message: asOptionalString(payload.message),
  }
}

function normalizeErrorPayload(payload) {
  const message = asString(payload.message)
  if (!message) return null
  return {
    message,
    code: asOptionalString(payload.code),
  }
}

// Shorthand helpers used by the bridge so common tool calls (the dedicated
// tools bat_assistant/bat_tool_use/bat_tool_result) can produce a uniform
// {kind, payload} envelope without each callsite repeating the structure.
export function assistantFrame(args = {}) {
  return normalizeFrame({ kind: FRAME_KINDS.ASSISTANT, payload: args })
}

export function toolUseFrame(args = {}) {
  return normalizeFrame({ kind: FRAME_KINDS.TOOL_USE, payload: args })
}

export function toolResultFrame(args = {}) {
  return normalizeFrame({ kind: FRAME_KINDS.TOOL_RESULT, payload: args })
}

// Legacy adapter: bat_reply{ text, status } → assistant frame.
export function frameFromLegacyReply(args = {}) {
  return assistantFrame({
    text: args.text,
    status: args.status === 'partial' ? 'partial' : 'final',
  })
}

// Metadata helpers — pull BAT routing metadata out of arbitrary args.
export function extractBatMeta(args = {}) {
  const meta = {}
  if (typeof args.bat_session_id === 'string') meta.bat_session_id = args.bat_session_id
  if (typeof args.bat_message_id === 'string') meta.bat_message_id = args.bat_message_id
  return meta
}
