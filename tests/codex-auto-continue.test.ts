import * as assert from 'assert'
import { shouldAutoContinueAfterTurnEnd } from '../renderer/src/components/CodexAgentPanel.helpers.ts'

assert.strictEqual(
  shouldAutoContinueAfterTurnEnd({ reason: 'completed' }),
  true,
  'completed turns should auto-continue'
)

assert.strictEqual(
  shouldAutoContinueAfterTurnEnd({
    reason: 'error',
    error: 'Codex: no response from model after 300s. Please try again.',
  }),
  true,
  'Codex idle timeout should auto-continue'
)

assert.strictEqual(
  shouldAutoContinueAfterTurnEnd({
    reason: 'error',
    error: 'Codex error: something else failed',
  }),
  false,
  'generic errors should not auto-continue'
)

assert.strictEqual(
  shouldAutoContinueAfterTurnEnd({ reason: 'aborted' }),
  false,
  'aborted turns should not auto-continue'
)

console.log('Codex auto-continue timeout support: passed')
