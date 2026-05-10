import * as assert from 'assert'
import { readFile } from 'fs/promises'

async function main() {
  const source = await readFile('src/components/CodexAgentPanel.tsx', 'utf8')

  assert.equal(
    source.includes('!isCodexSession && showResumeList'),
    false,
    'Codex resume list must not be gated behind !isCodexSession',
  )
  assert.equal(
    source.includes('{showResumeList && ('),
    true,
    'Codex resume list should render when /resume opens showResumeList',
  )

  console.log('Codex panel regression: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
