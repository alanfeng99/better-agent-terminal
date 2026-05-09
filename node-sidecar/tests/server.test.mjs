// Tests for the Node sidecar JSON-RPC server.
//
// Two layers:
//   - dispatch() is exercised in-process (no spawn) so we can assert on
//     handler logic without paying for a child Node startup per test.
//   - One end-to-end test spawns the server as a real child to verify
//     the line-delimited stdio protocol survives the round trip.
//
// Run with: pnpm exec node node-sidecar/tests/server.test.mjs

import * as assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = resolve(here, '..', 'src', 'server.mjs')

async function inProcess() {
  const mod = await import('../src/server.mjs')
  const { dispatch, handlers, registerHandler } = mod

  // ping echoes params and returns pid + ok flag.
  const pingReply = await dispatch({ jsonrpc: '2.0', id: 1, method: 'ping', params: { hi: 'there' } })
  assert.equal(pingReply.jsonrpc, '2.0')
  assert.equal(pingReply.id, 1)
  assert.equal(pingReply.result.ok, true)
  assert.deepEqual(pingReply.result.echo, { hi: 'there' })
  assert.equal(typeof pingReply.result.pid, 'number')

  // claude.authStatus shells out to `claude auth status`. Result is either
  // null (CLI missing / not logged in / parse error) or the parsed JSON
  // object — we accept both so the test passes regardless of the dev
  // machine's auth state.
  const auth = await dispatch({ jsonrpc: '2.0', id: 2, method: 'claude.authStatus' })
  assert.ok(auth.result === null || (typeof auth.result === 'object' && auth.result !== null),
    `unexpected authStatus shape: ${JSON.stringify(auth.result)}`)
  // claude.accountList reads the on-disk index. With BAT_SIDECAR_DATA_DIR
  // pointing nowhere it should return [] cleanly.
  const savedDataDir = process.env.BAT_SIDECAR_DATA_DIR
  process.env.BAT_SIDECAR_DATA_DIR = join(tmpdir(), `nonexistent-${Date.now()}`)
  try {
    const accounts = await dispatch({ jsonrpc: '2.0', id: 3, method: 'claude.accountList' })
    assert.deepEqual(accounts.result, [])
  } finally {
    if (savedDataDir === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
    else process.env.BAT_SIDECAR_DATA_DIR = savedDataDir
  }

  // Unknown methods produce a -32601 error and preserve the request id.
  const unknown = await dispatch({ jsonrpc: '2.0', id: 7, method: 'no.such.method' })
  assert.equal(unknown.error.code, -32601)
  assert.equal(unknown.id, 7)

  // Notifications (no id) get no response object back.
  const notif = await dispatch({ jsonrpc: '2.0', method: 'ping' })
  assert.equal(notif, null)

  // Handler that throws produces -32000 with the message verbatim.
  registerHandler('test.boom', async () => { throw new Error('kapow') })
  const boom = await dispatch({ jsonrpc: '2.0', id: 9, method: 'test.boom' })
  assert.equal(boom.error.code, -32000)
  assert.equal(boom.error.message, 'kapow')

  // Duplicate registration throws — protects us against accidental override.
  assert.throws(() => registerHandler('ping', () => 1), /already registered/)
  assert.ok(handlers.has('ping'))

  // Session lifecycle stubs validate sessionId and return ok.
  const start = await dispatch({ jsonrpc: '2.0', id: 100, method: 'claude.startSession', params: { sessionId: 's-1', options: { cwd: '/x' } } })
  assert.equal(start.result.ok, true)
  assert.equal(start.result.sessionId, 's-1')
  const stop = await dispatch({ jsonrpc: '2.0', id: 101, method: 'claude.stopSession', params: { sessionId: 's-1' } })
  assert.equal(stop.result.ok, true)
  assert.equal(stop.result.existed, true)
  // Stopping an unknown session returns existed=false rather than erroring.
  const stop2 = await dispatch({ jsonrpc: '2.0', id: 102, method: 'claude.stopSession', params: { sessionId: 'unknown' } })
  assert.equal(stop2.result.existed, false)
  // Missing sessionId rejects.
  const bad = await dispatch({ jsonrpc: '2.0', id: 103, method: 'claude.sendMessage', params: {} })
  assert.equal(bad.error.code, -32000)
  assert.match(bad.error.message, /missing sessionId/)

  // compareVersions semantics — pure helper, doesn't hit network.
  const { compareVersions } = mod
  assert.equal(compareVersions('1.2.3', '1.2.4'), true)
  assert.equal(compareVersions('1.2.3', '1.2.3'), false)
  assert.equal(compareVersions('1.2.3', '1.2.2'), false)
  assert.equal(compareVersions('v1.2.3', 'v1.2.4'), true)
  assert.equal(compareVersions('1.0', '1.0.1'), true)
  assert.equal(compareVersions('2.0.0', '1.99.99'), false)

  // findClaudeCliPath — point PATH at a temp dir containing a fake claude
  // binary and confirm the helper finds it. Cross-platform: on Windows we
  // create claude.cmd, elsewhere a plain `claude` file.
  const { findClaudeCliPath, listSessionsFallback } = mod
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'sidecar-bin-'))
  try {
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'claude.cmd' : 'claude'
    const exePath = join(fakeBinDir, exeName)
    writeFileSync(exePath, isWin ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = fakeBinDir
    try {
      const found = findClaudeCliPath()
      assert.equal(found, exePath)
    } finally {
      process.env.PATH = savedPath
    }
    // Empty PATH → returns null rather than throwing.
    const savedPath2 = process.env.PATH
    process.env.PATH = ''
    try {
      const found = findClaudeCliPath()
      assert.equal(found, null)
    } finally {
      process.env.PATH = savedPath2
    }
  } finally {
    rmSync(fakeBinDir, { recursive: true, force: true })
  }

  // listSessionsFallback — fabricate a fake ~/.claude/projects layout
  // by overriding HOME to a temp dir, write a JSONL session, and assert
  // the parsed shape matches the SessionSummary contract.
  const fakeHome = mkdtempSync(join(tmpdir(), 'sidecar-home-'))
  const cwd = '/test/project'
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const projectDir = join(fakeHome, '.claude', 'projects', encoded)
  mkdirSync(projectDir, { recursive: true })
  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: 'hello world from test' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } }),
    'malformed line should be skipped',
    JSON.stringify({ type: 'user', message: { content: 'second user msg' } }),
  ].join('\n') + '\n'
  writeFileSync(join(projectDir, 'sess-abc.jsonl'), jsonl)

  const savedHome = process.env.HOME
  const savedUserProfile = process.env.USERPROFILE
  // Node's os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
  // The helper captured CLAUDE_PROJECTS_DIR at module-load time so we
  // can't override after the fact — instead run the helper with a
  // forced cwd whose encoded form points at our fake home, then put
  // the file under the *real* expected location. We do that by writing
  // to the actual ~/.claude/projects under a unique cwd encoding so we
  // don't collide with real sessions, and clean up afterward.
  process.env.HOME = savedHome
  process.env.USERPROFILE = savedUserProfile
  try {
    // Use a unique cwd that maps to a directory we own, located under
    // the *real* CLAUDE_PROJECTS_DIR, so the helper finds it without
    // needing module re-init.
    const { homedir } = await import('node:os')
    const realProjectsBase = join(homedir(), '.claude', 'projects')
    const uniqueCwd = `/__sidecar_test__/${Date.now()}_${Math.random().toString(36).slice(2)}`
    const uniqueEncoded = uniqueCwd.replace(/[^a-zA-Z0-9]/g, '-')
    const realDir = join(realProjectsBase, uniqueEncoded)
    mkdirSync(realDir, { recursive: true })
    try {
      writeFileSync(join(realDir, 'sess-test.jsonl'), jsonl)
      const sessions = await listSessionsFallback(uniqueCwd)
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].sdkSessionId, 'sess-test')
      assert.equal(sessions[0].preview, 'hello world from test')
      assert.equal(sessions[0].messageCount, 3) // 3 valid lines, 1 skipped
      assert.equal(typeof sessions[0].timestamp, 'number')
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
    // Empty cwd → returns []
    const empty = await listSessionsFallback('')
    assert.deepEqual(empty, [])
    // Non-existent project dir → returns []
    const nonExistent = await listSessionsFallback('/this/does/not/exist/anywhere')
    assert.deepEqual(nonExistent, [])
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }

  // readAccountIndex — point BAT_SIDECAR_DATA_DIR at a temp dir, drop a
  // claude-accounts.json shaped like the Electron AccountManager writes,
  // confirm only public fields come back. Also covers the missing-file
  // and corrupt-file branches.
  const { resolveDataDir, readAccountIndex } = mod
  const savedDataDir2 = process.env.BAT_SIDECAR_DATA_DIR
  // Branch 1: env not set — resolveDataDir falls back to a platform default.
  delete process.env.BAT_SIDECAR_DATA_DIR
  const fallback = resolveDataDir()
  assert.ok(fallback.includes('better-agent-terminal') || fallback.includes('BetterAgentTerminal'),
    `unexpected fallback data dir: ${fallback}`)

  // Branch 2: env set, file missing → []
  const fakeData = mkdtempSync(join(tmpdir(), 'sidecar-data-'))
  try {
    process.env.BAT_SIDECAR_DATA_DIR = fakeData
    assert.equal(resolveDataDir(), fakeData)
    const empty = await readAccountIndex()
    assert.deepEqual(empty, [])

    // Branch 3: file exists with valid index — returns sanitized accounts.
    writeFileSync(join(fakeData, 'claude-accounts.json'), JSON.stringify({
      accounts: [
        { id: 'a1', email: 'a1@example.com', subscriptionType: 'pro', isDefault: true, createdAt: 1000, credentialSnapshot: 'should-be-stripped' },
        { id: 'a2', email: 'a2@example.com', isDefault: false, createdAt: 2000 },
        { id: '', email: 'no-id@example.com' }, // dropped — invalid
        { id: 'a3' }, // dropped — no email
      ],
      activeAccountId: 'a1',
      switchWarningShown: false,
    }))
    const accounts = await readAccountIndex()
    assert.equal(accounts.length, 2)
    assert.equal(accounts[0].id, 'a1')
    assert.equal(accounts[0].email, 'a1@example.com')
    assert.equal(accounts[0].isDefault, true)
    assert.equal(accounts[0].subscriptionType, 'pro')
    assert.equal('credentialSnapshot' in accounts[0], false, 'leaked private field')
    assert.equal(accounts[1].id, 'a2')
    assert.equal(accounts[1].isDefault, false)

    // Branch 4: corrupt file → []
    writeFileSync(join(fakeData, 'claude-accounts.json'), '{ this is not json')
    const corrupt = await readAccountIndex()
    assert.deepEqual(corrupt, [])
  } finally {
    rmSync(fakeData, { recursive: true, force: true })
    if (savedDataDir2 === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
    else process.env.BAT_SIDECAR_DATA_DIR = savedDataDir2
  }

  // listOpenAISessions — fabricate a fake openai-sessions tree under the
  // real ~/.better-agent-terminal/openai-sessions root with a unique date
  // path so we don't collide with real sessions. Clean up after.
  const { listOpenAISessions, OPENAI_SESSIONS_ROOT } = mod
  // Use a year far in the future so it sorts first and can't conflict
  // with a real session on disk.
  const fakeYear = '9999'
  const fakeDayDir = join(OPENAI_SESSIONS_ROOT, fakeYear, '01', '01')
  mkdirSync(fakeDayDir, { recursive: true })
  try {
    const sessId = `test-${Date.now()}`
    const file = join(fakeDayDir, `${sessId}.jsonl`)
    const lines = [
      JSON.stringify({ type: 'system', payload: { content: 'init' } }),
      JSON.stringify({ type: 'user', payload: { content: 'first user prompt\nsecond line ignored' } }),
      JSON.stringify({ type: 'assistant', payload: { content: 'reply' } }),
      '',
      'malformed-line',
    ]
    writeFileSync(file, lines.join('\n') + '\n')
    const sessions = await listOpenAISessions()
    const ours = sessions.find(s => s.sdkSessionId === sessId)
    assert.ok(ours, `expected fixture session in result; got ${sessions.length} sessions`)
    assert.equal(ours.preview, 'first user prompt')
    // 4 non-empty lines, but one is malformed JSON; impl counts them all
    // as message lines (matches Electron's behaviour) — assert >= 3.
    assert.ok(ours.messageCount >= 3, `unexpected count: ${ours.messageCount}`)
    assert.equal(typeof ours.timestamp, 'number')
  } finally {
    rmSync(join(OPENAI_SESSIONS_ROOT, fakeYear), { recursive: true, force: true })
  }

  // scanSkills — fabricate a project-scoped .claude/skills/ tree and
  // verify both top-level *.md and SKILL.md-in-subdir paths are picked
  // up, frontmatter is parsed, and dedup-by-name kicks in.
  const { scanSkills, parseSkillFrontmatter } = mod
  // parseSkillFrontmatter unit checks: empty input, no frontmatter, valid.
  assert.deepEqual(parseSkillFrontmatter(''), {})
  assert.deepEqual(parseSkillFrontmatter('# heading only'), {})
  assert.deepEqual(parseSkillFrontmatter('---\nname: foo\ndescription: "with quotes"\n---\nbody'),
    { name: 'foo', description: 'with quotes' })

  const fakeProject = mkdtempSync(join(tmpdir(), 'sidecar-skills-'))
  try {
    const skillsDir = join(fakeProject, '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    // Top-level .md skill
    writeFileSync(join(skillsDir, 'flat.md'),
      '---\nname: flat-skill\ndescription: a flat skill\n---\nbody here\n')
    // Subdir with SKILL.md
    const sub = join(skillsDir, 'nested')
    mkdirSync(sub)
    writeFileSync(join(sub, 'SKILL.md'),
      '# Nested\n\nNo frontmatter, fall back to first heading.\n')
    // Empty subdir without SKILL.md — silently skipped
    mkdirSync(join(skillsDir, 'empty'))

    const skills = await scanSkills(fakeProject)
    const byName = new Map(skills.map(s => [s.name, s]))
    assert.ok(byName.has('flat-skill'), 'missing flat-skill')
    assert.equal(byName.get('flat-skill').description, 'a flat skill')
    assert.equal(byName.get('flat-skill').scope, 'project')
    assert.ok(byName.has('nested'), 'missing nested skill')
    assert.equal(byName.get('nested').description, 'Nested')
  } finally {
    rmSync(fakeProject, { recursive: true, force: true })
  }

  // AGENT_PRESET_IDS in the sidecar must stay in sync with the
  // renderer-side AGENT_PRESETS constant. If this assertion fires,
  // someone added a preset to src/types/agent-presets.ts without
  // updating node-sidecar/src/server.mjs.
  const { AGENT_PRESET_IDS } = mod
  const presetsModule = await readFile(
    new URL('../../src/types/agent-presets.ts', import.meta.url), 'utf-8',
  )
  const idsFromTs = [...presetsModule.matchAll(/^\s*id:\s*'([^']+)'/gm)].map(m => m[1])
  assert.deepEqual(
    [...AGENT_PRESET_IDS].sort(),
    [...idsFromTs].sort(),
    `sidecar AGENT_PRESET_IDS drifted from src/types/agent-presets.ts (sidecar=${AGENT_PRESET_IDS}, ts=${idsFromTs})`,
  )

  // Round-trip the agent.listPresets handler so we know it actually
  // returns the static list rather than [] from a regression.
  const presetsReply = await dispatch({ jsonrpc: '2.0', id: 50, method: 'agent.listPresets' })
  assert.ok(Array.isArray(presetsReply.result))
  assert.ok(presetsReply.result.length > 0, 'agent.listPresets returned empty list')
  assert.ok(presetsReply.result.includes('claude-cli'))

  // worktree.* — full create/status/remove/rehydrate round trip against a
  // real ephemeral git repo. Skipped if `git` isn't on PATH.
  const { worktreeCreate, worktreeRemove, worktreeStatus, worktreeRehydrate, worktreeGetGitRoot, activeWorktrees } = mod
  const gitAvailable = await new Promise(r => {
    const cp = spawn('git', ['--version'], { stdio: 'ignore' })
    cp.on('error', () => r(false))
    cp.on('exit', code => r(code === 0))
  })
  if (gitAvailable) {
    const repo = mkdtempSync(join(tmpdir(), 'sidecar-wt-'))
    try {
      await new Promise((res, rej) => {
        const c = spawn('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
        c.on('exit', code => code === 0 ? res() : rej(new Error('git init failed')))
      })
      // Configure identity so commit works in CI shells without a global config.
      for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test']]) {
        await new Promise(r => { const c = spawn('git', ['config', k, v], { cwd: repo, stdio: 'ignore' }); c.on('exit', r) })
      }
      writeFileSync(join(repo, 'README.md'), '# fixture\n')
      await new Promise((res, rej) => {
        const c = spawn('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
        c.on('exit', code => code === 0 ? res() : rej(new Error('git add failed')))
      })
      await new Promise((res, rej) => {
        const c = spawn('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00', GIT_COMMITTER_DATE: '2024-01-01T00:00:00' } })
        c.on('exit', code => code === 0 ? res() : rej(new Error('git commit failed')))
      })

      // getGitRoot detection.
      const root = await worktreeGetGitRoot(repo)
      assert.ok(root, 'worktreeGetGitRoot returned null on real git repo')

      // Create + verify the worktree exists on disk and in the active map.
      const sessionId = `wt-test-${Date.now()}`
      const info = await worktreeCreate(sessionId, repo)
      assert.equal(info.sessionId, sessionId)
      assert.ok(info.worktreePath.includes('.bat-worktrees'))
      assert.ok(info.branchName.startsWith('bat/worktree-'))
      assert.ok(activeWorktrees.has(sessionId))
      const { existsSync, readFileSync } = await import('node:fs')
      assert.ok(existsSync(info.worktreePath))
      // .git/info/exclude has been updated.
      const excludeContent = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8')
      assert.ok(excludeContent.includes('/.bat-worktrees/'), 'exclude not updated')

      // status returns the expected shape (empty diff because nothing changed).
      const status = await worktreeStatus(sessionId)
      assert.ok(status, 'status returned null')
      assert.equal(status.branchName, info.branchName)
      assert.equal(status.worktreePath, info.worktreePath)
      assert.equal(status.sourceBranch, 'main')
      assert.equal(typeof status.diff, 'string')

      // status for unknown session is null.
      assert.equal(await worktreeStatus('does-not-exist'), null)

      // rehydrate same session id is idempotent (returns existing entry).
      const rehydrated = worktreeRehydrate(sessionId, repo, info.worktreePath, info.branchName)
      assert.equal(rehydrated.worktreePath, info.worktreePath)

      // remove + branch deletion.
      await worktreeRemove(sessionId, true)
      assert.equal(activeWorktrees.has(sessionId), false)
      assert.equal(existsSync(info.worktreePath), false, 'worktree path still exists after remove')

      // Rehydrate a brand-new session against the now-deleted path —
      // map gets an entry, source branch resolves async.
      const rehydrateNew = worktreeRehydrate('rehydrate-only', repo, info.worktreePath, 'feat/x')
      assert.equal(rehydrateNew.branchName, 'feat/x')
      assert.equal(rehydrateNew.sessionId, 'rehydrate-only')
      activeWorktrees.delete('rehydrate-only')
      // Let any in-flight async git lookups settle so Windows doesn't
      // EBUSY on the temp dir teardown.
      await new Promise(r => setTimeout(r, 200))
    } finally {
      // Retry rm a couple of times — git can leave handles open briefly
      // on Windows after fork/exec teardown.
      for (let i = 0; i < 5; i++) {
        try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); break }
        catch { await new Promise(r => setTimeout(r, 200)) }
      }
    }
  } else {
    console.log('worktree tests skipped: git not on PATH')
  }
}

// End-to-end: spawn `node server.mjs`, send a few requests, assert replies.
async function endToEnd() {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  // Capture stderr so a hidden crash surfaces if the test fails.
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })

  const replies = []
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    const trimmed = line.trim()
    if (!trimmed) return
    replies.push(JSON.parse(trimmed))
  })

  function send(req) {
    child.stdin.write(JSON.stringify(req) + '\n')
  }

  send({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 1 } })
  send({ jsonrpc: '2.0', id: 2, method: 'claude.authStatus' })
  send({ jsonrpc: '2.0', id: 3, method: 'no.such' })
  // Lifecycle pair: startSession then sendMessage. sendMessage triggers
  // two event notifications (claude:message + claude:turn-end), so the
  // total emission count from the server is 4 + 2 = 6 lines.
  send({ jsonrpc: '2.0', id: 4, method: 'claude.startSession', params: { sessionId: 'e2e-1', options: { cwd: '/' } } })
  send({ jsonrpc: '2.0', id: 5, method: 'claude.sendMessage', params: { sessionId: 'e2e-1', prompt: 'hi' } })

  // Poll until we see all 5 replies. Events go to a separate accumulator.
  const events = replies // alias for readability — we filter below
  const deadline = Date.now() + 5000
  while (replies.filter(r => r.id !== undefined).length < 5 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25))
  }
  // Give events a moment to flush, since the server emits them before the
  // sendMessage reply but they may interleave on Windows pipes.
  await new Promise(r => setTimeout(r, 100))

  child.stdin.end()
  await new Promise(r => child.once('close', r))

  const idReplies = events.filter(r => r.id !== undefined && r.id !== null)
  const eventNotifs = events.filter(r => typeof r.method === 'string' && r.method.startsWith('event:'))
  if (idReplies.length !== 5) {
    throw new Error(`sidecar e2e: expected 5 id-replies, got ${idReplies.length}; stderr=${stderr}`)
  }
  // The server dispatches handlers concurrently (rl.on('line', async ...)),
  // so responses are not guaranteed to arrive in request order. Index
  // by id, which is what a real client (the Rust bridge) does anyway.
  const byId = new Map(idReplies.map(r => [r.id, r]))
  assert.equal(byId.get(1).result.ok, true)
  assert.deepEqual(byId.get(1).result.echo, { x: 1 })
  // authStatus result is null OR a parsed CLI JSON object (depends on
  // whether the dev machine has `claude` on PATH and is logged in).
  const authResult = byId.get(2).result
  assert.ok(authResult === null || typeof authResult === 'object',
    `unexpected authStatus shape: ${JSON.stringify(authResult)}`)
  assert.equal(byId.get(3).error.code, -32601)
  assert.equal(byId.get(4).result.ok, true)
  assert.equal(byId.get(4).result.sessionId, 'e2e-1')
  assert.equal(byId.get(5).result.ok, true)

  // sendMessage must have produced both events.
  const eventNames = new Set(eventNotifs.map(e => e.method))
  assert.ok(eventNames.has('event:claude:message'), `expected event:claude:message, got ${[...eventNames]}`)
  assert.ok(eventNames.has('event:claude:turn-end'), `expected event:claude:turn-end, got ${[...eventNames]}`)
}

async function run() {
  await inProcess()
  await endToEnd()
  console.log('node-sidecar: passed')
}

run().catch(err => {
  console.error(err)
  process.exitCode = 1
})
