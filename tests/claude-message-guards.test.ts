import * as assert from 'node:assert/strict'
import { isClaudeMessage, isMessageItem, isToolCall } from '../renderer/src/types/claude-agent.ts'

const invalidArchiveItems: unknown[] = [
  null,
  undefined,
  'legacy string payload',
  42,
  false,
  [],
  { role: 'assistant' },
]

for (const item of invalidArchiveItems) {
  assert.equal(isToolCall(item), false)
  assert.equal(isClaudeMessage(item), false)
  assert.equal(isMessageItem(item), false)
}

const message = {
  id: 'm1',
  sessionId: 's1',
  role: 'assistant',
  content: 'hello',
  timestamp: 1,
}
assert.equal(isClaudeMessage(message), true)
assert.equal(isMessageItem(message), true)

const toolCall = {
  id: 't1',
  sessionId: 's1',
  toolName: 'Task',
  input: {},
  status: 'running',
  timestamp: 1,
}
assert.equal(isToolCall(toolCall), true)
assert.equal(isMessageItem(toolCall), true)

console.log('claude message guards regression: passed')
