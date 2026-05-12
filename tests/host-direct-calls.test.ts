import * as assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOTS = [
  'src/App.tsx',
  'src/components',
  'src/stores',
]

const DIRECT_HOST_PATTERN = /\bwindow\.batAppAPI\b/

async function collectFiles(path: string): Promise<string[]> {
  const info = await stat(path)
  if (info.isFile()) return /\.(tsx?|jsx?)$/.test(path) ? [path] : []
  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => collectFiles(join(path, entry.name))))
  return nested.flat()
}

async function main() {
  const files = (await Promise.all(ROOTS.map(collectFiles))).flat()
  const offenders: string[] = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    if (DIRECT_HOST_PATTERN.test(source)) {
      offenders.push(relative(process.cwd(), file))
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Renderer UI/store files must call host.* instead of window.batAppAPI directly:\n${offenders.join('\n')}`,
  )
  console.log('host direct calls: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
