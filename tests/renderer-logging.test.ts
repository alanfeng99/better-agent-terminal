import * as assert from 'assert'
import { readFile } from 'fs/promises'

async function assertNoRendererConsoleLog(file: string) {
  const source = await readFile(file, 'utf8')
  assert.equal(
    source.includes('console.log('),
    false,
    `${file} should use host.debug.log for renderer logs`,
  )
}

async function main() {
  await assertNoRendererConsoleLog('src/components/ClaudeAgentPanel.tsx')
  await assertNoRendererConsoleLog('src/components/CodexAgentPanel.tsx')

  const codexSource = await readFile('src/components/CodexAgentPanel.tsx', 'utf8')
  assert.equal(
    codexSource.includes('const tag = `[Codex:${sessionId.slice(0, 8)}]`'),
    true,
    'Codex IPC subscription logs should be tagged as Codex',
  )

  console.log('renderer logging: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
