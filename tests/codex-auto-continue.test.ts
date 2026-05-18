import * as assert from 'assert'
import {
  buildCollapsedOutputPreview,
  shouldAutoContinueAfterTurnEnd,
  stringifyToolResult,
  summarizeShellCommand,
} from '../renderer/src/components/CodexAgentPanel.helpers.ts'

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

assert.strictEqual(
  summarizeShellCommand('/bin/zsh -lc "sed -n \'1,80p\' renderer/src/components/WorkspaceView.tsx && sed -n \'700,820p\' renderer/src/components/WorkspaceView.tsx"'),
  'read renderer/src/components/WorkspaceView.tsx:1-80 + read renderer/src/components/WorkspaceView.tsx:700-820',
  'shell read commands should get a file-range summary'
)

assert.deepStrictEqual(
  buildCollapsedOutputPreview('\n\nimport a\nconst b = 1\n\nfunction c() {}\nexport default c\nignored\n'),
  ['import a', 'const b = 1', 'function c() {}', 'export default c'],
  'collapsed output preview should show multiple meaningful lines'
)

assert.strictEqual(
  stringifyToolResult({ status: 'ok', count: 2 }),
  '{\n  "status": "ok",\n  "count": 2\n}',
  'object tool results should render as JSON instead of [object Object]'
)

console.log('Codex auto-continue timeout support: passed')
