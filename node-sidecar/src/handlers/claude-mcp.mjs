// Project-scoped MCP server detection + approval helpers.
//
// Background: Claude Code CLI (the binary the SDK spawns) reads
// `<cwd>/.mcp.json` for project MCP server declarations. By policy it
// won't auto-attach those servers — it waits for an explicit approval
// marker in one of the settings sources (`enableAllProjectMcpServers:
// true`, or `enabledMcpjsonServers: [...]` exhaustively listing every
// server in `.mcp.json`). In SDK mode there's no interactive
// approval prompt, so an unapproved `.mcp.json` is silently ignored.
//
// We surface that in the renderer:
//   - `claude.checkMcpJsonStatus(cwd)` reports {exists, approved, servers}
//   - `claude.enableAllProjectMcp(cwd)` flips the flag in
//     `<cwd>/.claude/settings.json`, preserving existing keys.
//
// The check reads three settings sources to mirror the SDK's
// settingSources: ['user','project','local'] resolution: user
// `~/.claude/settings.json`, project `<cwd>/.claude/settings.json`,
// local `<cwd>/.claude/settings.local.json`. Approval in ANY of them
// counts (the CLI ORs the merge result).

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { registerHandler } from '../lib/protocol.mjs'

async function readJsonSafe(path) {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Returns the array of mcpServers keys from `<cwd>/.mcp.json`, or
// null when the file is missing / malformed / has no mcpServers
// object. Callers treat null as "no .mcp.json" — we collapse all
// failure modes since the renderer can't act on the difference.
async function readMcpServerNames(cwd) {
  const parsed = await readJsonSafe(join(cwd, '.mcp.json'))
  if (!parsed || typeof parsed !== 'object') return null
  const servers = parsed.mcpServers
  if (!servers || typeof servers !== 'object') return null
  const names = Object.keys(servers)
  return names.length === 0 ? null : names
}

// True if `settings` (a parsed settings.json from any source) supplies
// approval for ALL of `serverNames`. Two ways to approve:
//   (a) `enableAllProjectMcpServers: true` — blanket approval
//   (b) `enabledMcpjsonServers: [...]` — exhaustive enumeration
// Partial coverage in (b) does NOT count — the CLI only attaches
// servers that are individually approved, so reporting approved=true
// when 1/3 servers are listed would mislead the user.
function isApprovedBy(settings, serverNames) {
  if (!settings || typeof settings !== 'object') return false
  if (settings.enableAllProjectMcpServers === true) return true
  const list = settings.enabledMcpjsonServers
  if (!Array.isArray(list)) return false
  return serverNames.every(name => list.includes(name))
}

registerHandler('claude.checkMcpJsonStatus', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) return { exists: false, approved: false, servers: [] }
  const servers = await readMcpServerNames(cwd)
  if (!servers) return { exists: false, approved: false, servers: [] }
  const sources = [
    join(homedir(), '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ]
  const settingsAll = await Promise.all(sources.map(readJsonSafe))
  const approved = settingsAll.some(s => isApprovedBy(s, servers))
  return { exists: true, approved, servers }
})

// Idempotent: writing an already-true flag is a no-op (changed:false).
// We mkdir the .claude/ dir on first write since a brand-new project
// won't have it yet. JSON.stringify(_, null, 2) matches what the
// Claude CLI writes when it self-initialises settings, so the diff
// stays clean.
registerHandler('claude.enableAllProjectMcp', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) throw new Error('claude.enableAllProjectMcp: missing cwd')
  const dir = join(cwd, '.claude')
  const path = join(dir, 'settings.json')
  await mkdir(dir, { recursive: true })
  const existing = (await readJsonSafe(path)) ?? {}
  if (existing.enableAllProjectMcpServers === true) {
    return { ok: true, changed: false, path }
  }
  existing.enableAllProjectMcpServers = true
  await writeFile(path, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  return { ok: true, changed: true, path }
})
