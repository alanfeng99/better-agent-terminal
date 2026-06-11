// Debug helper: spawn interactive claude in a temp dir and dump stripped PTY
// output for N seconds. No hooks, no tailer — just see what the TUI shows.
// Usage: node node-sidecar/scripts/spike-debug-pty.mjs [seconds] [...extraArgs]

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const seconds = Number(process.argv[2] || 30)
const extraArgs = process.argv.slice(3)

const out = execSync('where claude', { encoding: 'utf8' })
const cliPath = out.split(/\r?\n/).find(l => l.trim())?.trim()
const pty = await import('@lydell/node-pty').then(m => (m.spawn ? m : m.default))

const sandbox = mkdtempSync(join(tmpdir(), 'bat-cli-dbg-'))
writeFileSync(join(sandbox, 'note.txt'), 'BAT_SPIKE_MAGIC_LINE_42\n')

function stripAnsi(v) {
  return String(v || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
}

const t0 = Date.now()
const args = ['--model', 'haiku', ...extraArgs]
console.log(`spawn: ${cliPath} ${args.join(' ')} (cwd=${sandbox})`)
const child = pty.spawn(cliPath, args, {
  cwd: sandbox, env: { ...process.env, NO_COLOR: '1' },
  name: 'xterm-256color', cols: 100, rows: 32,
})
child.onData(chunk => {
  const text = stripAnsi(chunk).replace(/\r/g, '')
  if (text.trim()) console.log(`--- [${Date.now() - t0}ms] ---\n${text}`)
})
child.onExit(e => { console.log(`EXIT code=${e.exitCode} at ${Date.now() - t0}ms`) })

setTimeout(() => {
  try { child.kill() } catch {}
  try { rmSync(sandbox, { recursive: true, force: true }) } catch {}
  process.exit(0)
}, seconds * 1000)
