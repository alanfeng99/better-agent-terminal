import * as assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOTS = [
  'renderer/src/App.tsx',
  'renderer/src/components',
  'renderer/src/stores',
]

const CLAUDE_CALL_PATTERN = /\bhost\.claude\.([A-Za-z0-9_]+)/g
const DIRECT_KEY_PATTERN = /\bkey\s*===\s*['"]([A-Za-z0-9_]+)['"]/g
const OBJECT_KEY_PATTERN = /^\s*([A-Za-z0-9_]+):\s*['"]claude[_:]/gm

async function collectFiles(path: string): Promise<string[]> {
  const info = await stat(path)
  if (info.isFile()) return /\.(tsx?|jsx?)$/.test(path) ? [path] : []
  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => collectFiles(join(path, entry.name))))
  return nested.flat()
}

function collectMatches(source: string, pattern: RegExp): Set<string> {
  const values = new Set<string>()
  for (const match of source.matchAll(pattern)) {
    values.add(match[1])
  }
  return values
}

function extractClaudeAdapterBlock(hostSource: string): string {
  const start = hostSource.indexOf('claude: new Proxy')
  const end = hostSource.indexOf('worktree: new Proxy', start)
  assert.ok(start >= 0, 'Could not find Tauri claude adapter block')
  assert.ok(end > start, 'Could not find end of Tauri claude adapter block')
  return hostSource.slice(start, end)
}

async function main() {
  const files = (await Promise.all(ROOTS.map(collectFiles))).flat()
  const used = new Map<string, Set<string>>()

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const methods = collectMatches(source, CLAUDE_CALL_PATTERN)
    if (methods.size > 0) used.set(relative(process.cwd(), file), methods)
  }

  const hostSource = await readFile('renderer/src/host-api.ts', 'utf8')
  const claudeAdapterSource = extractClaudeAdapterBlock(hostSource)
  const routed = new Set([
    ...collectMatches(claudeAdapterSource, DIRECT_KEY_PATTERN),
    ...collectMatches(claudeAdapterSource, OBJECT_KEY_PATTERN),
  ])

  const missing: string[] = []
  for (const [file, methods] of used) {
    for (const method of methods) {
      if (!routed.has(method)) missing.push(`${file}: host.claude.${method}`)
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Tauri host-api must explicitly route renderer-used host.claude.* methods instead of falling through to permissive no-op:\n${missing.join('\n')}`,
  )

  console.log(`host claude coverage: passed (${used.size} files, ${routed.size} routed methods)`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
