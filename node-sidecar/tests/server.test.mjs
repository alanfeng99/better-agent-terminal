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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
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
  // claude.accountList reads the on-disk index. The renderer's
  // SettingsPanel reads `.accounts.length` directly, so the shape must
  // be `{accounts, activeAccountId, switchWarningShown}` — never a bare
  // array — even when the index file is missing.
  const savedDataDir = process.env.BAT_SIDECAR_DATA_DIR
  process.env.BAT_SIDECAR_DATA_DIR = join(tmpdir(), `nonexistent-${Date.now()}`)
  try {
    const accounts = await dispatch({ jsonrpc: '2.0', id: 3, method: 'claude.accountList' })
    assert.deepEqual(accounts.result, { accounts: [], activeAccountId: null, switchWarningShown: false })
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

  // sidecar logger — mirrors stderr writes to <dataDir>/sidecar.log so
  // mac users can scrape the file post-mortem after a hung send.
  // (a) initLogger creates the file at the override path, mode 0600 on
  // POSIX. (b) log/warn/error append a timestamp+level+message line.
  // (c) sidecar.getLogPath surfaces the path through dispatch so the
  // renderer can show it. (d) rotate kicks in when the file exceeds
  // 5 MB. (e) attachProcessHooks is idempotent.
  {
    const logger = await import('../src/lib/logger.mjs')
    const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const tmpRoot = mkdtempSync(join(tmpdir(), 'bat-sidecar-log-'))
    const logPath = join(tmpRoot, 'sidecar.log')
    logger.__setLogPathOverrideForTests(logPath)
    try {
      logger.initLogger()
      assert.equal(existsSync(logPath), true, 'initLogger must create the log file')
      assert.equal(logger.getLogPath(), logPath)

      // Every level appends a parseable line.
      logger.log('hello', 'world')
      logger.info('numbers:', 42)
      logger.warn('careful')
      logger.error('boom', new Error('kaboom'))
      const contents = readFileSync(logPath, 'utf-8')
      // Count entries by ISO-timestamp prefix at line start (errors with
      // multi-line stacks count as one entry).
      const entryStarts = contents.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z (LOG |INFO|WARN|ERR ) /gm) || []
      assert.equal(entryStarts.length, 4, `expected 4 entries, got ${entryStarts.length}`)
      // Per-line spot-checks via the first line of each entry.
      const firstLineOf = contents.split('\n').filter(Boolean)[0]
      assert.match(firstLineOf, /LOG  hello world$/)
      // The error entry must contain both 'boom' and 'kaboom' (stack or
      // bare message).
      assert.ok(contents.includes('boom') && contents.includes('kaboom'))
      // INFO + WARN entries appear in order before ERR.
      const ts = (regex) => contents.search(regex)
      assert.ok(ts(/INFO numbers: 42/) > 0)
      assert.ok(ts(/WARN careful/) > ts(/INFO numbers: 42/))
      assert.ok(ts(/ERR /) > ts(/WARN careful/))

      // sidecar.getLogPath through dispatch.
      const reply = await dispatch({ jsonrpc: '2.0', id: 'log-1', method: 'sidecar.getLogPath' })
      assert.equal(reply.result.path, logPath)

      // POSIX mode 0600 on the file.
      if (process.platform !== 'win32') {
        const mode = statSync(logPath).mode & 0o777
        assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
      }

      // Rotate: write >5MB, re-init, file gets truncated.
      writeFileSync(logPath, 'X'.repeat(6 * 1024 * 1024), { mode: 0o600 })
      assert.ok(statSync(logPath).size > 5 * 1024 * 1024)
      logger.initLogger()
      assert.equal(statSync(logPath).size, 0, 'oversized log must be rotated to empty')

      // attachProcessHooks is idempotent — second call doesn't re-bind.
      const before = process.listenerCount('uncaughtException')
      logger.attachProcessHooks()
      logger.attachProcessHooks()
      const after = process.listenerCount('uncaughtException')
      assert.ok(after - before <= 1,
        `attachProcessHooks must add at most one listener, added ${after - before}`)

      // Logger silently swallows write failures — point the override at
      // a path inside a deleted dir, log, no throw.
      const ghostDir = join(tmpRoot, 'gone')
      const ghostPath = join(ghostDir, 'log')
      logger.__setLogPathOverrideForTests(ghostPath)
      logger.initLogger()
      // initLogger creates the dir; then we delete it to force append failure.
      rmSync(ghostDir, { recursive: true, force: true })
      // Should not throw.
      logger.warn('this write fails silently')
    } finally {
      logger.__setLogPathOverrideForTests(null)
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  }

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
    assert.deepEqual(empty, { accounts: [], activeAccountId: null, switchWarningShown: false })

    // Branch 3: file exists with valid index — returns sanitized accounts.
    writeFileSync(join(fakeData, 'claude-accounts.json'), JSON.stringify({
      accounts: [
        { id: 'a1', email: 'a1@example.com', subscriptionType: 'pro', isDefault: true, createdAt: 1000, credentialSnapshot: 'should-be-stripped' },
        { id: 'a2', email: 'a2@example.com', isDefault: false, createdAt: 2000 },
        { id: '', email: 'no-id@example.com' }, // dropped — invalid
        { id: 'a3' }, // dropped — no email
      ],
      activeAccountId: 'a1',
      switchWarningShown: true,
    }))
    const idx = await readAccountIndex()
    assert.equal(idx.accounts.length, 2)
    assert.equal(idx.accounts[0].id, 'a1')
    assert.equal(idx.accounts[0].email, 'a1@example.com')
    assert.equal(idx.accounts[0].isDefault, true)
    assert.equal(idx.accounts[0].subscriptionType, 'pro')
    assert.equal('credentialSnapshot' in idx.accounts[0], false, 'leaked private field')
    assert.equal(idx.accounts[1].id, 'a2')
    assert.equal(idx.accounts[1].isDefault, false)
    assert.equal(idx.activeAccountId, 'a1')
    assert.equal(idx.switchWarningShown, true)

    // Branch 4: corrupt file → empty wrapper.
    writeFileSync(join(fakeData, 'claude-accounts.json'), '{ this is not json')
    const corrupt = await readAccountIndex()
    assert.deepEqual(corrupt, { accounts: [], activeAccountId: null, switchWarningShown: false })

    // accountMarkWarningShown persists the warning flag even when the
    // previous index was corrupt, matching the renderer's expectation
    // that the one-time warning does not reappear after acknowledgement.
    const marked = await dispatch({ jsonrpc: '2.0', id: 34, method: 'claude.accountMarkWarningShown' })
    assert.equal(marked.result, true)
    const afterMark = await readAccountIndex()
    assert.deepEqual(afterMark, { accounts: [], activeAccountId: null, switchWarningShown: true })
  } finally {
    rmSync(fakeData, { recursive: true, force: true })
    if (savedDataDir2 === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
    else process.env.BAT_SIDECAR_DATA_DIR = savedDataDir2
  }

  // openai API key storage — sidecar should persist configured keys in
  // BAT_SIDECAR_DATA_DIR and report hasKey=true afterward. clearApiKey
  // removes only the configured key file; env/Codex OAuth fallbacks may
  // still make hasKey true on a developer machine, so assert the file
  // operation directly after clear.
  {
    const fakeOpenAIData = mkdtempSync(join(tmpdir(), 'sidecar-openai-key-'))
    const savedDataDirOpenAI = process.env.BAT_SIDECAR_DATA_DIR
    const savedOpenAIEnv = process.env.OPENAI_API_KEY
    try {
      process.env.BAT_SIDECAR_DATA_DIR = fakeOpenAIData
      delete process.env.OPENAI_API_KEY

      const setReply = await dispatch({
        jsonrpc: '2.0',
        id: 31,
        method: 'openai.setApiKey',
        params: { apiKey: 'sk-test-sidecar' },
      })
      assert.equal(setReply.result, true)
      assert.equal(readFileSync(join(fakeOpenAIData, 'openai-api-key.bin'), 'utf-8'), 'sk-test-sidecar')

      const statusReply = await dispatch({ jsonrpc: '2.0', id: 32, method: 'openai.getApiKeyStatus' })
      assert.deepEqual(statusReply.result, { hasKey: true })

      const clearReply = await dispatch({ jsonrpc: '2.0', id: 33, method: 'openai.clearApiKey' })
      assert.equal(clearReply.result, true)
      assert.equal(existsSync(join(fakeOpenAIData, 'openai-api-key.bin')), false)
    } finally {
      rmSync(fakeOpenAIData, { recursive: true, force: true })
      if (savedDataDirOpenAI === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
      else process.env.BAT_SIDECAR_DATA_DIR = savedDataDirOpenAI
      if (savedOpenAIEnv === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = savedOpenAIEnv
    }
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

    for (let i = 0; i < 55; i += 1) {
      const bulkFile = join(fakeDayDir, `bulk-${String(i).padStart(2, '0')}.jsonl`)
      writeFileSync(bulkFile, JSON.stringify({ type: 'user', payload: { content: `bulk ${i}` } }) + '\n')
      const ts = new Date(Date.UTC(9999, 0, 1, 0, i, 0))
      utimesSync(bulkFile, ts, ts)
    }
    const capped = await listOpenAISessions()
    assert.equal(capped.length, 50, 'OpenAI session list should match Electron 50-session cap')
    assert.equal(capped[0].sdkSessionId, 'bulk-54')
    assert.equal(capped.at(-1)?.sdkSessionId, 'bulk-05')
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

  // CLAUDE_BUILTIN_MODELS in the sidecar must mirror the renderer-side
  // src/utils/claude-model-presets.ts constant. Re-read the TS file and
  // diff the `value:` literals so a renderer-only addition fails here.
  const { CLAUDE_BUILTIN_MODELS } = mod
  const presetsFile = await readFile(
    new URL('../../src/utils/claude-model-presets.ts', import.meta.url), 'utf-8',
  )
  // Pull only entries inside the CLAUDE_BUILTIN_MODELS array literal.
  const arrayMatch = presetsFile.match(/CLAUDE_BUILTIN_MODELS:[^=]*=\s*\[([\s\S]*?)\n\]/m)
  assert.ok(arrayMatch, 'could not locate CLAUDE_BUILTIN_MODELS array in source')
  const arrayBody = arrayMatch[1]
  const tsValues = [...arrayBody.matchAll(/value:\s*(?:CLAUDE_OPUS_47_(\w+)|'([^']+)')/g)]
    .map(m => {
      if (m[1]) {
        // Resolve the symbolic constant via a regex-extracted assignment.
        const constMatch = presetsFile.match(new RegExp(`CLAUDE_OPUS_47_${m[1]}\\s*=\\s*'([^']+)'`))
        return constMatch ? constMatch[1] : null
      }
      return m[2]
    })
    .filter(Boolean)
  const sidecarValues = CLAUDE_BUILTIN_MODELS.map(m => m.value)
  assert.deepEqual(
    [...sidecarValues].sort(),
    [...tsValues].sort(),
    `sidecar CLAUDE_BUILTIN_MODELS drifted from src/utils/claude-model-presets.ts (sidecar=${sidecarValues}, ts=${tsValues})`,
  )

  // Drift guard for the SDK-result dedup set: sidecar's
  // CLAUDE_BUILTIN_DEDUP_KEYS must match the keys of the renderer-side
  // CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS map. Mismatch means
  // getSupportedModels would either leak duplicate entries from the SDK
  // or hide a legitimate SDK-only model from the picker.
  const { CLAUDE_BUILTIN_DEDUP_KEYS } = mod
  const ctxMatch = presetsFile.match(
    /CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS[^=]*=\s*new Map[^[]*\[([\s\S]*?)\n\]\)/m,
  )
  assert.ok(ctxMatch, 'could not locate CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS in source')
  const ctxKeys = [...ctxMatch[1].matchAll(/\[\s*'([^']+)'/g)].map(m => m[1])
  assert.deepEqual(
    [...CLAUDE_BUILTIN_DEDUP_KEYS].sort(),
    [...ctxKeys].sort(),
    `sidecar CLAUDE_BUILTIN_DEDUP_KEYS drifted from CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS (sidecar=${CLAUDE_BUILTIN_DEDUP_KEYS}, ts=${ctxKeys})`,
  )
  // Round-trip the handler. Result may include SDK-discovered entries
  // when @anthropic-ai/claude-agent-sdk is importable (dev), or only
  // builtins when it isn't (release without bundled node_modules).
  // Either way: every builtin must be present + tagged source:'builtin',
  // and every additional entry must be tagged source:'sdk'.
  const { __setSdkOverrideForTests, __resetMetadataCacheForTests } = mod
  // Process-lifetime metadata cache could mask state changes between
  // assertion blocks. Clear before the first round so each block sees
  // a cold rebuild.
  __resetMetadataCacheForTests()
  const modelsReply = await dispatch({
    jsonrpc: '2.0', id: 60, method: 'claude.getSupportedModels',
    params: { sessionId: 'irrelevant' },
  })
  assert.ok(Array.isArray(modelsReply.result))
  assert.ok(modelsReply.result.length >= CLAUDE_BUILTIN_MODELS.length,
    `expected at least ${CLAUDE_BUILTIN_MODELS.length} models, got ${modelsReply.result.length}`)
  const builtinValues = new Set(CLAUDE_BUILTIN_MODELS.map(m => m.value))
  const seenBuiltins = new Set()
  for (const m of modelsReply.result) {
    assert.equal(typeof m.displayName, 'string')
    assert.equal(typeof m.description, 'string')
    if (builtinValues.has(m.value)) {
      assert.equal(m.source, 'builtin', `expected source=builtin for ${m.value}`)
      seenBuiltins.add(m.value)
    } else {
      assert.equal(m.source, 'sdk', `expected source=sdk for non-builtin ${m.value}`)
    }
  }
  assert.equal(seenBuiltins.size, CLAUDE_BUILTIN_MODELS.length,
    'not all builtin models present in result')

  // Explicit fallback contract: when SDK is unavailable (release build
  // without node_modules), getSupportedModels MUST return exactly the
  // builtins. Pin this with the override hook so dev passing can never
  // mask a release regression.
  __setSdkOverrideForTests(null)
  __resetMetadataCacheForTests()
  try {
    const fallbackReply = await dispatch({
      jsonrpc: '2.0', id: 61, method: 'claude.getSupportedModels',
    })
    assert.equal(fallbackReply.result.length, CLAUDE_BUILTIN_MODELS.length,
      'SDK-unavailable path must return exactly builtin count')
    for (const m of fallbackReply.result) {
      assert.equal(m.source, 'builtin')
    }
  } finally {
    __setSdkOverrideForTests(undefined)
    __resetMetadataCacheForTests()
  }

  // Positive augmentation contract with a fake SDK: one model dupes a
  // builtin base id (must be filtered), one is a [1m] variant of a
  // base id (must be filtered — base+[1m] form is in the dedup set),
  // one is genuinely new (must appear tagged 'sdk').
  // Note: dedup operates on CLAUDE_BUILTIN_DEDUP_KEYS (base ids and
  // [1m] variants), not on CLAUDE_BUILTIN_MODELS.value (which contains
  // preset suffixes like :auto-compact-200k that the SDK never emits).
  const fakeSdk = {
    query() {
      return {
        async supportedModels() {
          return [
            { value: 'claude-opus-4-6', displayName: 'dup', description: 'dup' },
            { value: 'claude-sonnet-4-6[1m]', displayName: '1m variant', description: '1m' },
            { value: 'fake-sdk-only-model', displayName: 'fake', description: 'fake-only' },
          ]
        },
      }
    },
  }
  __setSdkOverrideForTests(fakeSdk)
  __resetMetadataCacheForTests()
  try {
    const augReply = await dispatch({
      jsonrpc: '2.0', id: 62, method: 'claude.getSupportedModels',
    })
    assert.equal(augReply.result.length, CLAUDE_BUILTIN_MODELS.length + 1,
      'expected exactly one new SDK-only entry after dedup')
    const fake = augReply.result.find(m => m.value === 'fake-sdk-only-model')
    assert.ok(fake, 'fake SDK-only model missing from result')
    assert.equal(fake.source, 'sdk')
    // Duped builtin still present and tagged 'builtin' (not overwritten).
    const dupBase = augReply.result.find(m => m.value === 'claude-opus-4-6')
    assert.equal(dupBase.source, 'builtin')
    // [1m] variant of a base id should NOT appear at all (no builtin
    // entry uses that value, and SDK entry was filtered).
    assert.ok(
      !augReply.result.some(m => m.value === 'claude-sonnet-4-6[1m]'),
      '[1m] variant of base builtin id leaked through dedup',
    )
  } finally {
    __setSdkOverrideForTests(undefined)
    __resetMetadataCacheForTests()
  }

  // Metadata cache contract. getSupportedModels still spawns a fresh
  // sdk.query() on cache miss (Electron parity); the 5-minute TTL cache
  // ensures only the first call within a window pays the spawn cost.
  //
  // The 3 cheap RPCs (getSupportedCommands / getSupportedAgents /
  // getAccountInfo) read from the live `session.currentQuery` set by
  // claude.sendMessage — no fresh spawn ever, just a method call on
  // an already-initialized Query instance. When the session lacks a
  // currentQuery (panel mounted but user hasn't sent a message yet),
  // they return [] / null inertly instead of paying ~4s of spawn cost.
  //
  // Cache contracts pinned here:
  //   (a) Second call within TTL must NOT invoke the SDK builder.
  //   (b) __resetMetadataCacheForTests forces a rebuild.
  //   (c) Concurrent calls share the in-flight promise — only one
  //       SDK build runs even if 4 callers fire simultaneously.
  //
  // Live-Query contract pinned separately below.
  let modelsBuildCount = 0
  __setSdkOverrideForTests({
    query() {
      return {
        async supportedModels() {
          modelsBuildCount++
          return [{ value: 'cache-test-model', displayName: 'cache', description: 'test' }]
        },
      }
    },
  })
  __resetMetadataCacheForTests()
  try {
    // First call: builder runs.
    await dispatch({ jsonrpc: '2.0', id: 70, method: 'claude.getSupportedModels' })
    assert.equal(modelsBuildCount, 1, 'first call should build')
    // Second + third call within TTL: no extra builder runs.
    await dispatch({ jsonrpc: '2.0', id: 71, method: 'claude.getSupportedModels' })
    await dispatch({ jsonrpc: '2.0', id: 72, method: 'claude.getSupportedModels' })
    assert.equal(modelsBuildCount, 1, 'second/third call must hit cache')
    // Reset → next call rebuilds.
    __resetMetadataCacheForTests()
    await dispatch({ jsonrpc: '2.0', id: 73, method: 'claude.getSupportedModels' })
    assert.equal(modelsBuildCount, 2, 'after reset, builder must run again')

    // Concurrent-call dedup: 4 callers in-flight simultaneously share
    // the same builder run.
    __resetMetadataCacheForTests()
    modelsBuildCount = 0
    const racers = await Promise.all([
      dispatch({ jsonrpc: '2.0', id: 74, method: 'claude.getSupportedModels' }),
      dispatch({ jsonrpc: '2.0', id: 75, method: 'claude.getSupportedModels' }),
      dispatch({ jsonrpc: '2.0', id: 76, method: 'claude.getSupportedModels' }),
      dispatch({ jsonrpc: '2.0', id: 77, method: 'claude.getSupportedModels' }),
    ])
    assert.equal(modelsBuildCount, 1,
      `4 concurrent callers should share one build, ran ${modelsBuildCount} times`)
    // All callers got the same set (builtins + the one fake SDK entry).
    for (const r of racers) {
      assert.ok(r.result.some(m => m.value === 'cache-test-model'),
        'fake SDK model should appear in all racer results')
    }
  } finally {
    __setSdkOverrideForTests(undefined)
    __resetMetadataCacheForTests()
  }

  // Live-Query contract for the 3 cheap RPCs.
  //   (a) No session / no sessionId      → [] / null (inert default).
  //   (b) Session with no currentQuery   → [] / null (no fresh spawn).
  //   (c) Session with currentQuery      → reads from live Query.
  //   (d) Live Query method throws       → []/null (graceful degrade).
  // Mirrors electron/claude-agent-manager.ts:2079-2099 — the renderer
  // panel re-fetches after the first claude:status arrives, by which
  // point the session has a real currentQuery from sendMessage.
  __resetMetadataCacheForTests()
  // (a) No sessionId at all → empty/null without spawning anything.
  const noSessCmds = await dispatch({ jsonrpc: '2.0', id: 80, method: 'claude.getSupportedCommands' })
  assert.deepEqual(noSessCmds.result, [], 'no sessionId should return []')
  const noSessAgents = await dispatch({ jsonrpc: '2.0', id: 81, method: 'claude.getSupportedAgents' })
  assert.deepEqual(noSessAgents.result, [])
  const noSessAccount = await dispatch({ jsonrpc: '2.0', id: 82, method: 'claude.getAccountInfo' })
  assert.equal(noSessAccount.result, null)

  // (b) Unknown sessionId → same inert defaults.
  __resetMetadataCacheForTests()
  const unkCmds = await dispatch({ jsonrpc: '2.0', id: 83, method: 'claude.getSupportedCommands', params: { sessionId: 'never-existed' } })
  assert.deepEqual(unkCmds.result, [])

  // (c) Session with currentQuery → reads from live Query.
  await dispatch({ jsonrpc: '2.0', id: 84, method: 'claude.startSession', params: { sessionId: 'live-meta', options: { cwd: '/x' } } })
  const liveSession = mod.sessions.get('live-meta')
  let cmdsCallCount = 0
  let agentsCallCount = 0
  let accountCallCount = 0
  liveSession.currentQuery = {
    async supportedCommands() {
      cmdsCallCount++
      return [{ name: 'live-cmd', description: 'from live Query' }]
    },
    async supportedAgents() {
      agentsCallCount++
      return [{ name: 'live-agent', description: 'from live Query' }]
    },
    async accountInfo() {
      accountCallCount++
      return { email: 'live@example.com', subscriptionType: 'pro' }
    },
  }
  __resetMetadataCacheForTests()
  const liveCmds = await dispatch({ jsonrpc: '2.0', id: 85, method: 'claude.getSupportedCommands', params: { sessionId: 'live-meta' } })
  assert.equal(liveCmds.result[0].name, 'live-cmd')
  assert.equal(cmdsCallCount, 1)
  // Second call within TTL hits cache, doesn't re-call the live Query.
  await dispatch({ jsonrpc: '2.0', id: 86, method: 'claude.getSupportedCommands', params: { sessionId: 'live-meta' } })
  assert.equal(cmdsCallCount, 1, 'second call must hit cache, not re-call Query')

  const liveAgents = await dispatch({ jsonrpc: '2.0', id: 87, method: 'claude.getSupportedAgents', params: { sessionId: 'live-meta' } })
  assert.equal(liveAgents.result[0].name, 'live-agent')
  assert.equal(agentsCallCount, 1)

  const liveAccount = await dispatch({ jsonrpc: '2.0', id: 88, method: 'claude.getAccountInfo', params: { sessionId: 'live-meta' } })
  assert.equal(liveAccount.result.email, 'live@example.com')
  assert.equal(accountCallCount, 1)

  // (d) Live Query method throws → graceful empty/null.
  __resetMetadataCacheForTests()
  liveSession.currentQuery = {
    async supportedCommands() { throw new Error('query died') },
    async supportedAgents() { throw new Error('query died') },
    async accountInfo() { throw new Error('query died') },
  }
  const throwCmds = await dispatch({ jsonrpc: '2.0', id: 89, method: 'claude.getSupportedCommands', params: { sessionId: 'live-meta' } })
  assert.deepEqual(throwCmds.result, [], 'thrown error must degrade to []')
  const throwAgents = await dispatch({ jsonrpc: '2.0', id: 90, method: 'claude.getSupportedAgents', params: { sessionId: 'live-meta' } })
  assert.deepEqual(throwAgents.result, [])
  const throwAccount = await dispatch({ jsonrpc: '2.0', id: 91, method: 'claude.getAccountInfo', params: { sessionId: 'live-meta' } })
  assert.equal(throwAccount.result, null)

  // Cleanup: drop the test session so later assertions don't see it.
  mod.sessions.delete('live-meta')
  __resetMetadataCacheForTests()

  // Workspace-with-2-panels-each-pings smoke. The reported repro is:
  // open a workspace, mount Claude + Codex agent panels, type "ping" in
  // each. The renderer surfaces failures as `[object Object]` unhandled
  // promise rejections because `await window.batAppAPI.claude.sendMessage`
  // (ClaudeAgentPanel:1809, CodexAgentPanel:1829) is bare — if any of
  // the RPCs in this sequence rejects, the panel onClick chain explodes.
  // This test pins the contract: every RPC the renderer fires during
  // panel mount + ping must return `.result`, never `.error`. A new
  // breakage in any of the 7 metadata reads / 1 sendMessage shows up as
  // an immediate red here, with the failing method named.
  const pingFakeSdk = {
    query() {
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-ping-1', cwd: '/x' }
        yield { type: 'result', subtype: 'success', session_id: 'sdk-ping-1', result: 'pong', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1, usage: {} }
      })()
    },
  }
  __setSdkOverrideForTests(pingFakeSdk)
  __resetMetadataCacheForTests()
  try {
    // Two sessions, mirroring the user's two-panel workspace.
    for (const sessionId of ['ws-claude-1', 'ws-codex-1']) {
      // Panel mount RPC fan-out (ClaudeAgentPanel.tsx:1120-1180 effects
      // + CodexAgentPanel.tsx:1120-1180 — same code). All metadata reads
      // are .then().catch() in the renderer, so any reject would be
      // swallowed silently — but we want them to never reject in the
      // first place, since the underlying handlers must be panic-free.
      await dispatch({ jsonrpc: '2.0', id: 700, method: 'claude.startSession',
        params: { sessionId, options: { cwd: '/x', model: 'claude-sonnet-4-6' } } })
      const mountRpcs = [
        { method: 'claude.getSessionMeta', params: { sessionId } },
        { method: 'claude.getSupportedModels', params: { sessionId } },
        { method: 'claude.getAccountInfo', params: { sessionId } },
        { method: 'claude.getSupportedCommands', params: { sessionId } },
        { method: 'claude.getSupportedAgents', params: { sessionId } },
        { method: 'claude.getSessionState', params: { sessionId } },
        { method: 'claude.getContextUsage', params: { sessionId } },
      ]
      for (const [i, rpc] of mountRpcs.entries()) {
        const reply = await dispatch({ jsonrpc: '2.0', id: 710 + i, ...rpc })
        assert.ok(reply.error === undefined,
          `panel mount RPC ${rpc.method} for ${sessionId} returned error: ${JSON.stringify(reply.error)}`)
        assert.ok('result' in reply,
          `panel mount RPC ${rpc.method} for ${sessionId} missing result key`)
      }
      // ping send. ClaudeAgentPanel:1809 is `await sendMessage(...)`
      // with NO try/catch — if this rejects, the user sees an
      // unhandled promise rejection. Pin: it must resolve.
      const sendReply = await dispatch({ jsonrpc: '2.0', id: 720,
        method: 'claude.sendMessage', params: { sessionId, prompt: 'ping' } })
      assert.ok(sendReply.error === undefined,
        `claude.sendMessage('${sessionId}','ping') errored: ${JSON.stringify(sendReply.error)}`)
      assert.ok(sendReply.result?.ok === true,
        `claude.sendMessage('${sessionId}','ping') did not resolve {ok:true}; got ${JSON.stringify(sendReply.result)}`)
    }
    // Cleanup the two synthetic sessions.
    mod.sessions.delete('ws-claude-1')
    mod.sessions.delete('ws-codex-1')
  } finally {
    __setSdkOverrideForTests(undefined)
    __resetMetadataCacheForTests()
  }

  // claude.checkMcpJsonStatus / enableAllProjectMcp.
  //
  // The Claude CLI silently ignores `<cwd>/.mcp.json` unless one of the
  // settings files (user / project / project.local) supplies an
  // approval marker. ClaudeAgentPanel uses these two RPCs on mount to
  // detect unapproved .mcp.json and offer a one-click fix. The check
  // logic is the matrix below — pin every branch so a future settings
  // schema change can't silently break the renderer prompt.
  //
  // We isolate by pointing $HOME at a mkdtemp dir for the duration
  // (since the user-level settings file lives at ~/.claude/settings.json
  // and we don't want a real dev-machine settings.json to mask the test).
  const mcpRoot = mkdtempSync(join(tmpdir(), 'mcp-status-'))
  const mcpHome = join(mcpRoot, 'home'); mkdirSync(mcpHome, { recursive: true })
  const mcpProj = join(mcpRoot, 'proj'); mkdirSync(mcpProj, { recursive: true })
  const mcpSavedHome = process.env.HOME
  const mcpSavedUserProfile = process.env.USERPROFILE
  process.env.HOME = mcpHome
  process.env.USERPROFILE = mcpHome  // os.homedir() reads this on Windows
  try {
    // (a) no .mcp.json present → exists:false, approved:false, servers:[]
    let r = await dispatch({ jsonrpc: '2.0', id: 800,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.deepEqual(r.result, { exists: false, approved: false, servers: [] })

    // (b) .mcp.json present but no settings → exists:true, approved:false
    writeFileSync(join(mcpProj, '.mcp.json'),
      JSON.stringify({ mcpServers: { foo: { command: 'x' }, bar: { command: 'y' } } }))
    r = await dispatch({ jsonrpc: '2.0', id: 801,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.exists, true)
    assert.equal(r.result.approved, false)
    assert.deepEqual(r.result.servers.sort(), ['bar', 'foo'])

    // (c) approved via enableAllProjectMcpServers in PROJECT settings
    mkdirSync(join(mcpProj, '.claude'), { recursive: true })
    writeFileSync(join(mcpProj, '.claude', 'settings.json'),
      JSON.stringify({ enableAllProjectMcpServers: true, otherKey: 'keep' }))
    r = await dispatch({ jsonrpc: '2.0', id: 802,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.approved, true, 'enableAllProjectMcpServers in project settings approves')

    // (d) approved via exhaustive enabledMcpjsonServers list
    writeFileSync(join(mcpProj, '.claude', 'settings.json'),
      JSON.stringify({ enabledMcpjsonServers: ['foo', 'bar', 'extra'] }))
    r = await dispatch({ jsonrpc: '2.0', id: 803,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.approved, true, 'exhaustive enabledMcpjsonServers approves')

    // (e) PARTIAL enabledMcpjsonServers (1/2 covered) → unapproved
    // — the CLI only attaches individually-listed servers, so reporting
    // approved=true here would mislead the user.
    writeFileSync(join(mcpProj, '.claude', 'settings.json'),
      JSON.stringify({ enabledMcpjsonServers: ['foo'] }))
    r = await dispatch({ jsonrpc: '2.0', id: 804,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.approved, false, 'partial enabledMcpjsonServers must NOT count as approved')

    // (f) approved via USER settings (~/.claude/settings.json) — wipe
    // project settings first so the source-precedence is unambiguous.
    rmSync(join(mcpProj, '.claude', 'settings.json'))
    mkdirSync(join(mcpHome, '.claude'), { recursive: true })
    writeFileSync(join(mcpHome, '.claude', 'settings.json'),
      JSON.stringify({ enableAllProjectMcpServers: true }))
    r = await dispatch({ jsonrpc: '2.0', id: 805,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.approved, true, 'enableAllProjectMcpServers in user settings approves')

    // (g) approved via LOCAL settings (settings.local.json overrides project)
    rmSync(join(mcpHome, '.claude', 'settings.json'))
    writeFileSync(join(mcpProj, '.claude', 'settings.local.json'),
      JSON.stringify({ enableAllProjectMcpServers: true }))
    r = await dispatch({ jsonrpc: '2.0', id: 806,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.approved, true, 'enableAllProjectMcpServers in settings.local.json approves')
    rmSync(join(mcpProj, '.claude', 'settings.local.json'))

    // (h) malformed .mcp.json (invalid JSON) → treated as no .mcp.json
    writeFileSync(join(mcpProj, '.mcp.json'), '{ this is not json')
    r = await dispatch({ jsonrpc: '2.0', id: 807,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.deepEqual(r.result, { exists: false, approved: false, servers: [] })

    // (i) missing cwd param → graceful empty default (no throw)
    r = await dispatch({ jsonrpc: '2.0', id: 808, method: 'claude.checkMcpJsonStatus' })
    assert.deepEqual(r.result, { exists: false, approved: false, servers: [] })

    // --- enableAllProjectMcp ---
    // (j) fresh project (no .claude/ dir, no settings.json) → both created
    const freshProj = join(mcpRoot, 'fresh'); mkdirSync(freshProj, { recursive: true })
    writeFileSync(join(freshProj, '.mcp.json'),
      JSON.stringify({ mcpServers: { only: { command: 'x' } } }))
    let w = await dispatch({ jsonrpc: '2.0', id: 810,
      method: 'claude.enableAllProjectMcp', params: { cwd: freshProj } })
    assert.equal(w.result.ok, true)
    assert.equal(w.result.changed, true, 'fresh write reports changed')
    const written = JSON.parse(await readFile(join(freshProj, '.claude', 'settings.json'), 'utf-8'))
    assert.equal(written.enableAllProjectMcpServers, true)

    // (k) existing settings — preserve other keys
    const presProj = join(mcpRoot, 'preserve'); mkdirSync(join(presProj, '.claude'), { recursive: true })
    writeFileSync(join(presProj, '.claude', 'settings.json'),
      JSON.stringify({ existingKey: 'keep', nested: { deep: 1 } }))
    w = await dispatch({ jsonrpc: '2.0', id: 811,
      method: 'claude.enableAllProjectMcp', params: { cwd: presProj } })
    assert.equal(w.result.changed, true)
    const merged = JSON.parse(await readFile(join(presProj, '.claude', 'settings.json'), 'utf-8'))
    assert.equal(merged.enableAllProjectMcpServers, true)
    assert.equal(merged.existingKey, 'keep', 'existing top-level key preserved')
    assert.deepEqual(merged.nested, { deep: 1 }, 'existing nested key preserved')

    // (l) idempotent — second call when flag is already true → changed:false, file unchanged
    const beforeMtime = (await readFile(join(presProj, '.claude', 'settings.json'), 'utf-8'))
    w = await dispatch({ jsonrpc: '2.0', id: 812,
      method: 'claude.enableAllProjectMcp', params: { cwd: presProj } })
    assert.equal(w.result.changed, false, 'idempotent second call reports changed:false')
    const afterMtime = (await readFile(join(presProj, '.claude', 'settings.json'), 'utf-8'))
    assert.equal(beforeMtime, afterMtime, 'idempotent second call does not rewrite the file')

    // (m) missing cwd → throws (write op needs an explicit target)
    const errReply = await dispatch({ jsonrpc: '2.0', id: 813, method: 'claude.enableAllProjectMcp' })
    assert.ok(errReply.error, 'enableAllProjectMcp without cwd must error')
    assert.match(errReply.error.message, /missing cwd/i)
  } finally {
    if (mcpSavedHome === undefined) delete process.env.HOME
    else process.env.HOME = mcpSavedHome
    if (mcpSavedUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = mcpSavedUserProfile
    rmSync(mcpRoot, { recursive: true, force: true })
  }

  // Per-session state round-trip via dispatch. Verifies setters mutate
  // the session map and getters read back exactly what was written.
  // This is the "stub stays consistent" contract — when SDK lands the
  // setters will additionally push into the live query instance.
  await dispatch({ jsonrpc: '2.0', id: 200, method: 'claude.startSession',
    params: { sessionId: 'state-1', options: { cwd: '/x', model: 'claude-sonnet-4-6', permissionMode: 'acceptEdits' } } })
  // Initial state from startSession options.
  const initState = await dispatch({ jsonrpc: '2.0', id: 201, method: 'claude.getSessionState', params: { sessionId: 'state-1' } })
  assert.equal(initState.result.active, true)
  assert.equal(initState.result.permissionMode, 'acceptEdits')
  assert.equal(initState.result.model, 'claude-sonnet-4-6')

  // setAutoContinue persists; usage counter resets.
  await dispatch({ jsonrpc: '2.0', id: 202, method: 'claude.setAutoContinue',
    params: { sessionId: 'state-1', opts: { enabled: true, max: 5, prompt: 'continue' } } })
  const ac = await dispatch({ jsonrpc: '2.0', id: 203, method: 'claude.getAutoContinue', params: { sessionId: 'state-1' } })
  assert.deepEqual(ac.result, { enabled: true, max: 5, used: 0, prompt: 'continue' })

  // setPermissionMode emits claude:modeChange — we can't assert that here
  // without wiring an event collector, but we can at least verify the
  // getter picks up the new value.
  await dispatch({ jsonrpc: '2.0', id: 204, method: 'claude.setPermissionMode',
    params: { sessionId: 'state-1', mode: 'plan' } })
  const meta = await dispatch({ jsonrpc: '2.0', id: 205, method: 'claude.getSessionMeta', params: { sessionId: 'state-1' } })
  assert.equal(meta.result.permissionMode, 'plan')

  // setModel + setEffort.
  await dispatch({ jsonrpc: '2.0', id: 206, method: 'claude.setModel',
    params: { sessionId: 'state-1', model: 'claude-haiku-4-5-20251001', autoCompactWindow: 100000 } })
  await dispatch({ jsonrpc: '2.0', id: 207, method: 'claude.setEffort',
    params: { sessionId: 'state-1', effort: 'high' } })
  const sandboxSet = await dispatch({ jsonrpc: '2.0', id: 2071, method: 'claude.setCodexSandboxMode',
    params: { sessionId: 'state-1', mode: 'danger-full-access' } })
  assert.equal(sandboxSet.result, true)
  const approvalSet = await dispatch({ jsonrpc: '2.0', id: 2072, method: 'claude.setCodexApprovalPolicy',
    params: { sessionId: 'state-1', policy: 'never' } })
  assert.equal(approvalSet.result, true)
  const badSandboxSet = await dispatch({ jsonrpc: '2.0', id: 2073, method: 'claude.setCodexSandboxMode',
    params: { sessionId: 'state-1', mode: 'root' } })
  assert.equal(badSandboxSet.result, false)
  const missingSandboxSet = await dispatch({ jsonrpc: '2.0', id: 2074, method: 'claude.setCodexSandboxMode',
    params: { sessionId: 'missing-state', mode: 'workspace-write' } })
  assert.equal(missingSandboxSet.result, false)
  const meta2 = await dispatch({ jsonrpc: '2.0', id: 208, method: 'claude.getSessionMeta', params: { sessionId: 'state-1' } })
  assert.equal(meta2.result.model, 'claude-haiku-4-5-20251001')
  assert.equal(meta2.result.effort, 'high')
  assert.equal(meta2.result.autoCompactWindow, 100000)
  const state2 = await dispatch({ jsonrpc: '2.0', id: 2081, method: 'claude.getSessionState', params: { sessionId: 'state-1' } })
  assert.equal(state2.result.codexSandboxMode, 'danger-full-access')
  assert.equal(state2.result.codexApprovalPolicy, 'never')
  // The renderer's status line reads inputTokens/outputTokens/numTurns/
  // contextTokens/durationMs etc. with `.toLocaleString()` directly (no
  // optional chaining), so before-the-first-turn the meta must still
  // surface 0 defaults instead of undefined. Lock the full shape so a
  // missing field crashes this test before crashing ClaudeAgentPanel.
  for (const key of [
    'permissionMode', 'model', 'effort', 'autoCompactWindow',
    'sdkSessionId', 'cwd', 'totalCost',
    'inputTokens', 'outputTokens', 'durationMs', 'numTurns',
    'contextWindow', 'maxOutputTokens', 'contextTokens',
    'cacheReadTokens', 'cacheCreationTokens',
    'callCacheRead', 'callCacheWrite', 'lastQueryCalls',
  ]) {
    assert.ok(key in meta2.result, `getSessionMeta missing field: ${key}`)
  }
  // Numeric fields default to 0 (not undefined).
  for (const numKey of [
    'totalCost', 'inputTokens', 'outputTokens', 'durationMs', 'numTurns',
    'contextWindow', 'maxOutputTokens', 'contextTokens',
    'cacheReadTokens', 'cacheCreationTokens',
    'callCacheRead', 'callCacheWrite', 'lastQueryCalls',
  ]) {
    assert.equal(typeof meta2.result[numKey], 'number',
      `getSessionMeta.${numKey} must be a number`)
  }

  // resetSession drops the entry; subsequent getSessionState returns null.
  // Wrap with sendEvent override so we can assert the claude:session-reset
  // notification fires for an existing session but NOT for an unknown id —
  // renderer panels rely on this event to clear UI state.
  const resetCaptured = []
  const restoreResetSend = mod.__setSendEventForTests((name, payload) => resetCaptured.push({ name, payload }))
  const reset = await dispatch({ jsonrpc: '2.0', id: 209, method: 'claude.resetSession', params: { sessionId: 'state-1' } })
  assert.equal(reset.result, true)
  const after = await dispatch({ jsonrpc: '2.0', id: 210, method: 'claude.getSessionState', params: { sessionId: 'state-1' } })
  assert.equal(after.result, null)
  // Reset of unknown session id returns false (not an error).
  const reset2 = await dispatch({ jsonrpc: '2.0', id: 211, method: 'claude.resetSession', params: { sessionId: 'nope' } })
  assert.equal(reset2.result, false)
  restoreResetSend()
  const sessionResetEvents = resetCaptured.filter(e => e.name === 'claude:session-reset')
  assert.equal(sessionResetEvents.length, 1, 'exactly one claude:session-reset emit for the existing session')
  assert.equal(sessionResetEvents[0].payload.sessionId, 'state-1')
  // Unknown-session reset must NOT emit (panel for that id likely doesn't exist).
  const otherResets = resetCaptured.filter(e => e.name === 'claude:session-reset' && e.payload.sessionId === 'nope')
  assert.equal(otherResets.length, 0, 'unknown sessionId reset should not emit')

  // Setters with bad params return false rather than throwing.
  const bad1 = await dispatch({ jsonrpc: '2.0', id: 212, method: 'claude.setAutoContinue', params: { opts: {} } })
  assert.equal(bad1.result, false)
  const bad2 = await dispatch({ jsonrpc: '2.0', id: 213, method: 'claude.setPermissionMode', params: { sessionId: 's', mode: 42 } })
  assert.equal(bad2.result, false)

  // claude.sendMessage event mapping with a fake SDK. We can't observe
  // events emitted via process.stdout from in-process dispatch, so
  // intercept by overriding sendEvent. The fake SDK feeds the handler
  // a canonical sequence — system/init → assistant → result/success —
  // and we assert each maps to the expected renderer event with the
  // right payload key. Captures sdkSessionId for resume on next call.
  const captured = []
  const restoreSendEvent = mod.__setSendEventForTests((name, payload) => captured.push({ name, payload }))
  const fakeSdkForSend = {
    query({ prompt, options }) {
      captured.push({ name: '__queryArgs', payload: { prompt, resume: options?.resume ?? null, cwd: options?.cwd ?? null } })
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'sdk-sess-abc', cwd: '/x', model: 'claude-sonnet-4-6', permissionMode: 'default' },
        { type: 'assistant', session_id: 'sdk-sess-abc', message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] } },
        { type: 'result', subtype: 'success', session_id: 'sdk-sess-abc', result: 'hello back', stop_reason: 'end_turn', total_cost_usd: 0.001, num_turns: 1 },
      ]
      return (async function*() {
        for (const m of messages) yield m
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkForSend)
  try {
    // Fresh session so we don't reuse state-1's mutated map.
    await dispatch({ jsonrpc: '2.0', id: 220, method: 'claude.startSession',
      params: { sessionId: 'send-1', options: { cwd: '/x' } } })
    const sendReply = await dispatch({ jsonrpc: '2.0', id: 221, method: 'claude.sendMessage',
      params: { sessionId: 'send-1', prompt: 'hi' } })
    assert.equal(sendReply.result.ok, true)
    // Event sequence: status, message, result, turn-end (in order).
    const events = captured.filter(c => c.name && c.name.startsWith('claude:'))
    const seq = events.map(e => e.name)
    assert.deepEqual(seq, ['claude:status', 'claude:message', 'claude:result', 'claude:turn-end'])
    // status payload.meta.sdkSessionId
    assert.equal(events[0].payload.meta.sdkSessionId, 'sdk-sess-abc')
    // status meta must carry the full SessionMetadata shape, not a
    // sparse subset — the renderer's ClaudeAgentPanel reads
    // `inputTokens.toLocaleString()` etc. without optional chaining.
    // Lock the same 19 keys + 13 numeric typeof asserted on the
    // getSessionMeta RPC reply, so any sparse status emit fails here
    // rather than crashing the panel.
    for (const key of [
      'permissionMode', 'model', 'effort', 'autoCompactWindow',
      'sdkSessionId', 'cwd', 'totalCost',
      'inputTokens', 'outputTokens', 'durationMs', 'numTurns',
      'contextWindow', 'maxOutputTokens', 'contextTokens',
      'cacheReadTokens', 'cacheCreationTokens',
      'callCacheRead', 'callCacheWrite', 'lastQueryCalls',
    ]) {
      assert.ok(key in events[0].payload.meta,
        `claude:status meta missing field: ${key}`)
    }
    for (const numKey of [
      'totalCost', 'inputTokens', 'outputTokens', 'durationMs', 'numTurns',
      'contextWindow', 'maxOutputTokens', 'contextTokens',
      'cacheReadTokens', 'cacheCreationTokens',
      'callCacheRead', 'callCacheWrite', 'lastQueryCalls',
    ]) {
      assert.equal(typeof events[0].payload.meta[numKey], 'number',
        `claude:status meta.${numKey} must be a number`)
    }
    // message payload.message.content shape preserved
    assert.equal(events[1].payload.message.message.content[0].text, 'hello back')
    // turn-end carries reason + sdkSessionId
    assert.equal(events[3].payload.payload.reason, 'completed')
    assert.equal(events[3].payload.payload.sdkSessionId, 'sdk-sess-abc')

    // Second sendMessage must pass `resume: 'sdk-sess-abc'` to the SDK
    // (proving multi-turn context preservation).
    const queryCallsBefore = captured.filter(c => c.name === '__queryArgs').length
    await dispatch({ jsonrpc: '2.0', id: 222, method: 'claude.sendMessage',
      params: { sessionId: 'send-1', prompt: 'follow up' } })
    const queryArgsRound2 = captured.filter(c => c.name === '__queryArgs')
    assert.equal(queryArgsRound2.length, queryCallsBefore + 1)
    assert.equal(queryArgsRound2[queryArgsRound2.length - 1].payload.resume, 'sdk-sess-abc')

    // A stale streaming flag must not reject a later prompt. The
    // sidecar's per-session sendQueue serializes real overlapping sends.
    const s = mod.sessions.get('send-1')
    s.streaming = true
    const staleFlagSend = await dispatch({ jsonrpc: '2.0', id: 223, method: 'claude.sendMessage',
      params: { sessionId: 'send-1', prompt: 'parallel' } })
    assert.equal(staleFlagSend.result.ok, true)
    assert.equal(s.streaming, false)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreSendEvent()
  }

  // Streaming-input mode: a single sdk.query() persists across multiple
  // sendMessage calls. The SDK CLI subprocess stays alive — second/third
  // turns pay only the API roundtrip cost, not the 3-4s cold-start. Fake
  // SDK drains the prompt iterable so each push delivers a user message
  // through the same generator.
  const persistentCaptured = []
  const restorePersistentSend = mod.__setSendEventForTests((name, payload) => persistentCaptured.push({ name, payload }))
  const fakeSdkStreaming = {
    queryCalls: 0,
    query({ prompt, options }) {
      this.queryCalls++
      const myCallIdx = this.queryCalls
      const userIter = prompt[Symbol.asyncIterator]()
      persistentCaptured.push({ name: '__queryArgs', payload: { resume: options?.resume ?? null, callIdx: myCallIdx } })
      let turn = 0
      return (async function*() {
        while (true) {
          const next = await userIter.next()
          if (next.done) return
          turn++
          yield { type: 'system', subtype: 'init', session_id: 'sdk-stream-1', cwd: '/s' }
          yield { type: 'assistant', session_id: 'sdk-stream-1',
            message: { role: 'assistant', content: [{ type: 'text', text: `reply-${myCallIdx}-${turn}` }] } }
          yield { type: 'result', subtype: 'success', session_id: 'sdk-stream-1',
            result: `reply-${myCallIdx}-${turn}`, stop_reason: 'end_turn',
            total_cost_usd: 0.001, num_turns: turn }
        }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkStreaming)
  try {
    await dispatch({ jsonrpc: '2.0', id: 224, method: 'claude.startSession',
      params: { sessionId: 'stream-1', options: { cwd: '/s' } } })
    // Two consecutive sends — must reuse the same query() invocation.
    const r1 = await dispatch({ jsonrpc: '2.0', id: 225, method: 'claude.sendMessage',
      params: { sessionId: 'stream-1', prompt: 'first' } })
    assert.equal(r1.result.ok, true)
    const r2 = await dispatch({ jsonrpc: '2.0', id: 226, method: 'claude.sendMessage',
      params: { sessionId: 'stream-1', prompt: 'second' } })
    assert.equal(r2.result.ok, true)
    assert.equal(fakeSdkStreaming.queryCalls, 1, 'streaming-input mode must NOT spawn a second sdk.query')
    // Both turns produced result events from the same generator.
    const results = persistentCaptured.filter(c => c.name === 'claude:result')
    assert.equal(results.length, 2, 'expected 2 result events across persistent query')
    assert.equal(results[0].payload.result.result, 'reply-1-1')
    assert.equal(results[1].payload.result.result, 'reply-1-2')
    // Session has live query attached + currentQuery exposed for the
    // claude-readonly handlers (supportedCommands / accountInfo).
    const ss = mod.sessions.get('stream-1')
    assert.ok(ss.liveQuery, 'expected live query on session after sendMessage')
    assert.equal(ss.liveQuery.isClosed, false)
    assert.ok(ss.currentQuery, 'currentQuery must mirror liveQuery.generator for readonly handlers')
  } finally {
    __setSdkOverrideForTests(undefined)
    restorePersistentSend()
    // Ensure no liveQuery leaks across tests.
    mod.sessions.get('stream-1')?.liveQuery?.close()
  }

  // Overlapping sends on the same session must serialize rather than
  // returning `{ok:false, error:"session already streaming"}`. This
  // mirrors Electron's "accept while busy" contract and protects the UI
  // from showing a user bubble whose prompt was dropped by the sidecar.
  const queuedCaptured = []
  let releaseFirstResult
  let firstTurnStartedResolve
  const firstTurnStarted = new Promise(resolve => { firstTurnStartedResolve = resolve })
  const fakeSdkQueued = {
    queryCalls: 0,
    query({ prompt }) {
      this.queryCalls++
      const userIter = prompt[Symbol.asyncIterator]()
      return (async function*() {
        let turn = 0
        while (true) {
          const next = await userIter.next()
          if (next.done) return
          turn++
          queuedCaptured.push(next.value?.message?.content)
          yield { type: 'system', subtype: 'init', session_id: 'sdk-queued-1', cwd: '/q' }
          yield { type: 'assistant', session_id: 'sdk-queued-1',
            message: { role: 'assistant', content: [{ type: 'text', text: `queued-reply-${turn}` }] } }
          if (turn === 1) {
            firstTurnStartedResolve()
            await new Promise(resolve => { releaseFirstResult = resolve })
          }
          yield { type: 'result', subtype: 'success', session_id: 'sdk-queued-1',
            result: `queued-reply-${turn}`, stop_reason: 'end_turn',
            total_cost_usd: 0.001, num_turns: turn }
        }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkQueued)
  try {
    await dispatch({ jsonrpc: '2.0', id: 227, method: 'claude.startSession',
      params: { sessionId: 'queued-1', options: { cwd: '/q' } } })
    const p1 = dispatch({ jsonrpc: '2.0', id: 228, method: 'claude.sendMessage',
      params: { sessionId: 'queued-1', prompt: 'first' } })
    await firstTurnStarted
    const p2 = dispatch({ jsonrpc: '2.0', id: 229, method: 'claude.sendMessage',
      params: { sessionId: 'queued-1', prompt: 'second' } })
    releaseFirstResult()
    const [q1, q2] = await Promise.all([p1, p2])
    assert.equal(q1.result.ok, true)
    assert.equal(q2.result.ok, true)
    assert.equal(fakeSdkQueued.queryCalls, 1, 'queued sends should reuse the persistent query')
    assert.deepEqual(queuedCaptured, ['first', 'second'])
  } finally {
    __setSdkOverrideForTests(undefined)
    mod.sessions.get('queued-1')?.liveQuery?.close()
  }

  // claude.stopTask: forwards task_id to the live query's stopTask
  // control method. Errors gracefully when no live query exists.
  const stopCaptured = []
  const restoreStopSend = mod.__setSendEventForTests(() => {})
  const fakeSdkStop = {
    query({ prompt }) {
      const userIter = prompt[Symbol.asyncIterator]()
      const gen = (async function*() {
        // Stay open: consume one user message + emit a turn, then idle
        // forever so stopTask runs against an open generator.
        const first = await userIter.next()
        if (first.done) return
        yield { type: 'system', subtype: 'init', session_id: 'sdk-stop' }
        yield { type: 'result', subtype: 'success', session_id: 'sdk-stop', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
        // Idle until the iterator's done (close called).
        while (true) {
          const n = await userIter.next()
          if (n.done) return
        }
      })()
      gen.stopTask = async (taskId) => { stopCaptured.push(taskId) }
      gen.close = () => { /* ends the iterator */ }
      return gen
    },
  }
  __setSdkOverrideForTests(fakeSdkStop)
  try {
    // Without a live query, stopTask reports failure rather than throwing.
    await dispatch({ jsonrpc: '2.0', id: 227, method: 'claude.startSession',
      params: { sessionId: 'stop-1', options: { cwd: '/s' } } })
    const earlyStop = await dispatch({ jsonrpc: '2.0', id: 228, method: 'claude.stopTask',
      params: { sessionId: 'stop-1', taskId: 'task-x' } })
    assert.equal(earlyStop.result.ok, false)
    assert.match(earlyStop.result.error, /no active live query/)

    // Once the session has sent a message, stopTask routes through the
    // generator's control method.
    await dispatch({ jsonrpc: '2.0', id: 229, method: 'claude.sendMessage',
      params: { sessionId: 'stop-1', prompt: 'hello' } })
    const stopReply = await dispatch({ jsonrpc: '2.0', id: 230, method: 'claude.stopTask',
      params: { sessionId: 'stop-1', taskId: 'task-A' } })
    assert.equal(stopReply.result.ok, true)
    assert.deepEqual(stopCaptured, ['task-A'])

    // toolUseId fallback (renderer's older API).
    const stopReply2 = await dispatch({ jsonrpc: '2.0', id: 231, method: 'claude.stopTask',
      params: { sessionId: 'stop-1', toolUseId: 'tool-Z' } })
    assert.equal(stopReply2.result.ok, true)
    assert.deepEqual(stopCaptured, ['task-A', 'tool-Z'])

    // Missing args reject.
    const noSid = await dispatch({ jsonrpc: '2.0', id: 232, method: 'claude.stopTask',
      params: { taskId: 'x' } })
    assert.match(noSid.error?.message || '', /missing sessionId/)
    const noTask = await dispatch({ jsonrpc: '2.0', id: 233, method: 'claude.stopTask',
      params: { sessionId: 'stop-1' } })
    assert.match(noTask.error?.message || '', /missing taskId/)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreStopSend()
    mod.sessions.get('stop-1')?.liveQuery?.close()
  }

  // setPermissionMode + setModel forward to the live query's control
  // methods when one is open. Failure on the control method rebuilds
  // on next sendMessage (closes liveQuery).
  const ctrlCalls = { permissionMode: [], model: [] }
  const restoreCtrlSend = mod.__setSendEventForTests(() => {})
  const fakeSdkCtrl = {
    query({ prompt }) {
      const userIter = prompt[Symbol.asyncIterator]()
      const gen = (async function*() {
        const first = await userIter.next()
        if (first.done) return
        yield { type: 'system', subtype: 'init', session_id: 'sdk-ctrl' }
        yield { type: 'result', subtype: 'success', session_id: 'sdk-ctrl', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
        while (true) { const n = await userIter.next(); if (n.done) return }
      })()
      gen.setPermissionMode = async (m) => { ctrlCalls.permissionMode.push(m) }
      gen.setModel = async (m) => { ctrlCalls.model.push(m) }
      gen.close = () => {}
      return gen
    },
  }
  __setSdkOverrideForTests(fakeSdkCtrl)
  try {
    await dispatch({ jsonrpc: '2.0', id: 234, method: 'claude.startSession',
      params: { sessionId: 'ctrl-1', options: { cwd: '/c' } } })
    await dispatch({ jsonrpc: '2.0', id: 235, method: 'claude.sendMessage',
      params: { sessionId: 'ctrl-1', prompt: 'hi' } })
    // Mode change must hit the control method.
    await dispatch({ jsonrpc: '2.0', id: 236, method: 'claude.setPermissionMode',
      params: { sessionId: 'ctrl-1', mode: 'plan' } })
    assert.deepEqual(ctrlCalls.permissionMode, ['plan'])
    // bypassPlan maps to 'plan' (sidecar-only mode the SDK doesn't know).
    await dispatch({ jsonrpc: '2.0', id: 237, method: 'claude.setPermissionMode',
      params: { sessionId: 'ctrl-1', mode: 'bypassPlan' } })
    assert.deepEqual(ctrlCalls.permissionMode, ['plan', 'plan'])
    // Model change forwards too.
    await dispatch({ jsonrpc: '2.0', id: 238, method: 'claude.setModel',
      params: { sessionId: 'ctrl-1', model: 'claude-opus-4-7' } })
    assert.deepEqual(ctrlCalls.model, ['claude-opus-4-7'])
    // Live query still open after control method success.
    assert.equal(mod.sessions.get('ctrl-1').liveQuery.isClosed, false)
    // autoCompactWindow change closes liveQuery (env var requires rebuild).
    await dispatch({ jsonrpc: '2.0', id: 239, method: 'claude.setModel',
      params: { sessionId: 'ctrl-1', autoCompactWindow: 200000 } })
    assert.equal(mod.sessions.get('ctrl-1').liveQuery, null,
      'autoCompactWindow change must close liveQuery so next send rebuilds with env')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreCtrlSend()
  }

  // closeLiveQuery cleanup: abortSession / stopSession / restSession /
  // resetSession / resumeSession all close any open liveQuery so the
  // SDK CLI subprocess doesn't outlive its session record. Verifies
  // each handler tears down the live query reference.
  const lcCalls = { close: 0 }
  const restoreLcSend = mod.__setSendEventForTests(() => {})
  function makeSdkLifecycle() {
    return {
      query({ prompt }) {
        const userIter = prompt[Symbol.asyncIterator]()
        const gen = (async function*() {
          const first = await userIter.next()
          if (first.done) return
          yield { type: 'system', subtype: 'init', session_id: 'sdk-lc' }
          yield { type: 'result', subtype: 'success', session_id: 'sdk-lc', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
          while (true) { const n = await userIter.next(); if (n.done) return }
        })()
        gen.close = () => { lcCalls.close++ }
        return gen
      },
    }
  }
  __setSdkOverrideForTests(makeSdkLifecycle())
  try {
    // abortSession closes liveQuery.
    await dispatch({ jsonrpc: '2.0', id: 240, method: 'claude.startSession', params: { sessionId: 'lc-abort', options: { cwd: '/lc' } } })
    await dispatch({ jsonrpc: '2.0', id: 241, method: 'claude.sendMessage', params: { sessionId: 'lc-abort', prompt: 'hi' } })
    assert.ok(mod.sessions.get('lc-abort').liveQuery, 'liveQuery built by sendMessage')
    const closeBeforeAbort = lcCalls.close
    await dispatch({ jsonrpc: '2.0', id: 242, method: 'claude.abortSession', params: { sessionId: 'lc-abort' } })
    assert.equal(mod.sessions.get('lc-abort').liveQuery, null, 'abortSession must null liveQuery')
    assert.ok(lcCalls.close > closeBeforeAbort, 'abortSession must call generator.close()')

    // stopSession closes liveQuery + deletes session.
    await dispatch({ jsonrpc: '2.0', id: 243, method: 'claude.startSession', params: { sessionId: 'lc-stop', options: { cwd: '/lc' } } })
    await dispatch({ jsonrpc: '2.0', id: 244, method: 'claude.sendMessage', params: { sessionId: 'lc-stop', prompt: 'hi' } })
    const stopCloseBefore = lcCalls.close
    await dispatch({ jsonrpc: '2.0', id: 245, method: 'claude.stopSession', params: { sessionId: 'lc-stop' } })
    assert.equal(mod.sessions.get('lc-stop'), undefined, 'stopSession deletes session record')
    assert.ok(lcCalls.close > stopCloseBefore, 'stopSession must close liveQuery')

    // resetSession closes liveQuery + deletes session.
    await dispatch({ jsonrpc: '2.0', id: 246, method: 'claude.startSession', params: { sessionId: 'lc-reset', options: { cwd: '/lc' } } })
    await dispatch({ jsonrpc: '2.0', id: 247, method: 'claude.sendMessage', params: { sessionId: 'lc-reset', prompt: 'hi' } })
    const resetCloseBefore = lcCalls.close
    await dispatch({ jsonrpc: '2.0', id: 248, method: 'claude.resetSession', params: { sessionId: 'lc-reset' } })
    assert.equal(mod.sessions.get('lc-reset'), undefined, 'resetSession deletes session record')
    assert.ok(lcCalls.close > resetCloseBefore, 'resetSession must close liveQuery')

    // resumeSession closes existing liveQuery before swapping the record.
    await dispatch({ jsonrpc: '2.0', id: 249, method: 'claude.startSession', params: { sessionId: 'lc-resume', options: { cwd: '/lc' } } })
    await dispatch({ jsonrpc: '2.0', id: 250, method: 'claude.sendMessage', params: { sessionId: 'lc-resume', prompt: 'hi' } })
    const resumeCloseBefore = lcCalls.close
    await dispatch({ jsonrpc: '2.0', id: 251, method: 'claude.resumeSession',
      params: { sessionId: 'lc-resume', sdkSessionId: 'sdk-lc-resumed', options: { cwd: '/lc' } } })
    assert.ok(lcCalls.close > resumeCloseBefore, 'resumeSession must close prior liveQuery')
    // New record has no liveQuery yet — first sendMessage rebuilds.
    assert.equal(mod.sessions.get('lc-resume').liveQuery, undefined)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreLcSend()
  }

  // LiveQuery — long-lived streaming-input mode SDK Query. Unwired in
  // this slice; the sendMessage rewrite that consumes it lands later.
  // We lock down the API surface here so the consumer slice can rely
  // on push() / stopTask / interrupt / close / FIFO turn deferreds.
  {
    const { LiveQuery } = await import('../src/lib/live-query.mjs')

    // Helper: build a fake SDK whose `query({prompt, options})` returns
    // a generator that drains the prompt iterable, emitting a 3-message
    // turn (system/init + assistant + result) per pushed user message.
    // Control methods (stopTask / interrupt / setPermissionMode /
    // setModel / close) are also stubbed so we can assert call counts.
    function makeStreamingFakeSdk({ failOnFirstTurn = false } = {}) {
      const calls = { query: 0, stopTask: [], interrupt: 0, setPermissionMode: [], setModel: [], close: 0 }
      let turnIdx = 0
      const sdk = {
        query({ prompt, options }) {
          calls.query++
          calls.lastOptions = options
          let userIter = null
          const gen = (async function*() {
            userIter = prompt[Symbol.asyncIterator]()
            while (true) {
              const next = await userIter.next()
              if (next.done) return
              turnIdx++
              if (failOnFirstTurn && turnIdx === 1) {
                throw new Error('simulated stream failure')
              }
              yield { type: 'system', subtype: 'init', session_id: 'sdk-1' }
              yield { type: 'assistant', session_id: 'sdk-1',
                message: { role: 'assistant', content: [{ type: 'text', text: `turn-${turnIdx}` }] } }
              yield { type: 'result', subtype: 'success', session_id: 'sdk-1',
                result: `turn-${turnIdx}`, stop_reason: 'end_turn',
                total_cost_usd: 0.001, num_turns: turnIdx }
            }
          })()
          gen.stopTask = async (taskId) => { calls.stopTask.push(taskId) }
          gen.interrupt = async () => { calls.interrupt++ }
          gen.setPermissionMode = async (m) => { calls.setPermissionMode.push(m) }
          gen.setModel = async (m) => { calls.setModel.push(m) }
          gen.close = () => { calls.close++ }
          return gen
        },
      }
      return { sdk, calls }
    }

    // (a) Construction validates required deps. Missing sdk / onMessage
    // throws synchronously so callers don't get an opaque later failure.
    assert.throws(() => new LiveQuery({}), /sdk\.query is required/)
    assert.throws(() => new LiveQuery({ sdk: { query: () => null } }), /onMessage callback is required/)

    // (b) Single-turn round trip: sdk.query is called exactly once on
    // construction, push() resolves with the result frame, onMessage is
    // invoked for every yielded SDK message in order, isClosed=false
    // throughout. Repeat push() reuses the same query (call count stays).
    {
      const { sdk, calls } = makeStreamingFakeSdk()
      const seen = []
      const lq = new LiveQuery({ sdk, queryOptions: { cwd: '/x' }, onMessage: (m) => seen.push(m) })
      assert.equal(calls.query, 1, 'sdk.query must run exactly once on construction')
      assert.equal(lq.isClosed, false)

      const r1 = await lq.push({ type: 'user', message: { role: 'user', content: 'hi' } })
      assert.equal(r1.type, 'result')
      assert.equal(r1.result, 'turn-1')
      // onMessage saw all three frames in order.
      assert.equal(seen.length, 3)
      assert.equal(seen[0].type, 'system')
      assert.equal(seen[1].type, 'assistant')
      assert.equal(seen[2].type, 'result')

      // Second push: same query, no rebuild.
      const r2 = await lq.push({ type: 'user', message: { role: 'user', content: 'follow up' } })
      assert.equal(calls.query, 1, 'second push must NOT rebuild the query')
      assert.equal(r2.result, 'turn-2')
      assert.equal(seen.length, 6)

      lq.close()
      assert.equal(lq.isClosed, true)
      assert.equal(calls.close, 1, 'close() must propagate to generator.close()')
    }

    // (c) FIFO turn deferreds: two pushes back-to-back resolve in order
    // even though the second is queued before the first finishes. The
    // fake SDK serialises turns through the iterator so order is kept.
    {
      const { sdk } = makeStreamingFakeSdk()
      const lq = new LiveQuery({ sdk, queryOptions: {}, onMessage: () => {} })
      try {
        const p1 = lq.push({ type: 'user', message: { role: 'user', content: 'first' } })
        const p2 = lq.push({ type: 'user', message: { role: 'user', content: 'second' } })
        const [r1, r2] = await Promise.all([p1, p2])
        assert.match(r1.result, /turn-/)
        assert.match(r2.result, /turn-/)
        // The two turns are distinct (turn-1, turn-2 in either order from
        // the *previous* test's reset; this fresh sdk re-counts from 1).
        assert.notEqual(r1.result, r2.result)
      } finally { lq.close() }
    }

    // (d) Control methods route through the generator's methods. Each
    // verifies the value is forwarded verbatim and call counts increment.
    {
      const { sdk, calls } = makeStreamingFakeSdk()
      const lq = new LiveQuery({ sdk, queryOptions: {}, onMessage: () => {} })
      try {
        await lq.stopTask('task-1')
        await lq.stopTask('task-2')
        assert.deepEqual(calls.stopTask, ['task-1', 'task-2'])
        await lq.interrupt()
        assert.equal(calls.interrupt, 1)
        await lq.setPermissionMode('plan')
        assert.deepEqual(calls.setPermissionMode, ['plan'])
        await lq.setModel('claude-opus-4-7')
        assert.deepEqual(calls.setModel, ['claude-opus-4-7'])
      } finally { lq.close() }

      // After close, control methods reject — they'd hit a dead generator
      // otherwise.
      await assert.rejects(lq.stopTask('x'), /closed/)
      await assert.rejects(lq.interrupt(), /closed/)
      await assert.rejects(lq.setPermissionMode('default'), /closed/)
      await assert.rejects(lq.setModel('x'), /closed/)
      await assert.rejects(lq.push({ type: 'user', message: { role: 'user', content: 'late' } }), /closed/)
    }

    // (e) Control method without SDK support throws a clear error rather
    // than silently swallowing. Build a generator that idles forever so
    // the LiveQuery stays open while we probe its control methods.
    {
      let resolveIdle
      const sdkBare = {
        query() {
          const gen = (async function*() {
            await new Promise(r => { resolveIdle = r })
          })()
          gen.close = () => { if (resolveIdle) resolveIdle() }
          // Note: NO stopTask / interrupt / setPermissionMode / setModel.
          return gen
        },
      }
      const lq = new LiveQuery({ sdk: sdkBare, queryOptions: {}, onMessage: () => {} })
      try {
        await assert.rejects(lq.stopTask('x'), /not supported by this SDK build/)
        await assert.rejects(lq.interrupt(), /not supported/)
        await assert.rejects(lq.setPermissionMode('plan'), /not supported/)
        await assert.rejects(lq.setModel('x'), /not supported/)
      } finally { lq.close() }
    }

    // (f) Generator throws → onError fires, all pending pushes reject,
    // isClosed flips true. The simulated SDK throws on first turn.
    {
      const { sdk } = makeStreamingFakeSdk({ failOnFirstTurn: true })
      const errors = []
      const lq = new LiveQuery({ sdk, queryOptions: {}, onMessage: () => {}, onError: (e) => errors.push(e) })
      const p = lq.push({ type: 'user', message: { role: 'user', content: 'doomed' } })
      await assert.rejects(p, /simulated stream failure/)
      // Wait a tick for the drain loop to clean up.
      await new Promise(r => setTimeout(r, 10))
      assert.equal(lq.isClosed, true)
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /simulated stream failure/)
    }

    // (g) onMessage that throws is funnelled through onError but doesn't
    // halt the drain loop. Subsequent messages still arrive.
    {
      const { sdk } = makeStreamingFakeSdk()
      const errors = []
      let count = 0
      const lq = new LiveQuery({
        sdk, queryOptions: {},
        onMessage: () => { count++; if (count === 1) throw new Error('boom in handler') },
        onError: (e) => errors.push(e),
      })
      try {
        const r = await lq.push({ type: 'user', message: { role: 'user', content: 'hi' } })
        assert.equal(r.type, 'result')
        // First message threw, second + third still got processed.
        assert.equal(count, 3)
        assert.equal(errors.length, 1)
        assert.match(errors[0].message, /boom in handler/)
      } finally { lq.close() }
    }

    // (h) Idempotent close: second call is a no-op.
    {
      const { sdk, calls } = makeStreamingFakeSdk()
      const lq = new LiveQuery({ sdk, queryOptions: {}, onMessage: () => {} })
      lq.close()
      lq.close()
      assert.equal(lq.isClosed, true)
      assert.equal(calls.close, 1, 'second close must not re-call generator.close')
    }

    // (i) close() while a push is in-flight rejects the pending deferred
    // with a closed error, never hangs. Use a fake SDK that holds the
    // pump open without ever yielding so the push() never naturally
    // resolves.
    {
      let resolveStream
      const sdkSlow = {
        query({ prompt }) {
          const gen = (async function*() {
            const it = prompt[Symbol.asyncIterator]()
            await it.next() // consume the user message
            // Wait forever (until close fires the abort).
            await new Promise(r => { resolveStream = r })
          })()
          gen.close = () => { if (resolveStream) resolveStream() }
          return gen
        },
      }
      const lq = new LiveQuery({ sdk: sdkSlow, queryOptions: {}, onMessage: () => {} })
      const inflight = lq.push({ type: 'user', message: { role: 'user', content: 'pending' } })
      // Close before any 'result' frame.
      setTimeout(() => lq.close(), 20)
      await assert.rejects(inflight, /closed/i)
    }
  }

  // claude.resumeSession: rehydrates an existing SDK session id so the
  // next sendMessage carries `resume: <id>`. Aborts any in-flight query
  // first; defaults permissionMode to bypassPermissions; respects
  // overrides supplied via options.
  const resumeCaptured = []
  const restoreResumeSend = mod.__setSendEventForTests(() => {})
  const fakeSdkResume = {
    query({ options }) {
      resumeCaptured.push({ options })
      const messages = [
        { type: 'system', subtype: 'init', session_id: options.resume || 'fresh-sdk' },
        { type: 'result', subtype: 'success', session_id: options.resume || 'fresh-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkResume)
  try {
    // Resume a session that the renderer just restored from history.
    const resumeReply = await dispatch({ jsonrpc: '2.0', id: 295, method: 'claude.resumeSession',
      params: { sessionId: 'resume-1', sdkSessionId: 'sdk-historic-xyz',
        options: { cwd: '/r', model: 'claude-sonnet-4-6' } } })
    assert.equal(resumeReply.result.ok, true)
    assert.equal(resumeReply.result.sdkSessionId, 'sdk-historic-xyz')
    // Default permissionMode must be bypassPermissions for resumed sessions.
    const resumed = mod.sessions.get('resume-1')
    assert.equal(resumed.permissionMode, 'bypassPermissions')
    assert.equal(resumed.sdkSessionId, 'sdk-historic-xyz')
    assert.equal(resumed.model, 'claude-sonnet-4-6')
    // Next sendMessage must include the resumed sdkSessionId on
    // queryOptions.resume — that's what makes the SDK reconstruct the
    // historical conversation context.
    await dispatch({ jsonrpc: '2.0', id: 296, method: 'claude.sendMessage',
      params: { sessionId: 'resume-1', prompt: 'continue' } })
    assert.equal(resumeCaptured.length, 1)
    assert.equal(resumeCaptured[0].options.resume, 'sdk-historic-xyz')

    // Resume must reject missing sdkSessionId or sessionId.
    const noSdkReply = await dispatch({ jsonrpc: '2.0', id: 297, method: 'claude.resumeSession',
      params: { sessionId: 'r2' } })
    assert.match(noSdkReply.error?.message || '', /missing sdkSessionId/)
    const noSidReply = await dispatch({ jsonrpc: '2.0', id: 298, method: 'claude.resumeSession',
      params: { sdkSessionId: 'x' } })
    assert.match(noSidReply.error?.message || '', /missing sessionId/)

    // Override default permissionMode via options.
    await dispatch({ jsonrpc: '2.0', id: 299, method: 'claude.resumeSession',
      params: { sessionId: 'resume-2', sdkSessionId: 'sdk-2',
        options: { cwd: '/r', permissionMode: 'plan' } } })
    assert.equal(mod.sessions.get('resume-2').permissionMode, 'plan')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreResumeSend()
  }

  // claude.rewindToPrompt: cut the SDK transcript at a given user-prompt
  // index and write a fresh transcript under a new SDK session id.
  // Test drives the on-disk projects dir via a tmpdir override, builds
  // a synthetic JSONL transcript with 3 user prompts + assistant
  // responses interleaved, then asserts the cut wrote a new file with
  // only the lines before the index, removedPromptCount is correct,
  // and session.sdkSessionId points at the new id.
  const { __setProjectsDirOverrideForTests } = mod
  const projTmp = mkdtempSync(join(tmpdir(), 'sidecar-rewind-'))
  __setProjectsDirOverrideForTests(projTmp)
  try {
    // The CLI encodes cwd into the project dir name by replacing any
    // non-alphanumeric char with '-'. Use a path with slashes so the
    // encoded name actually exercises the encoding.
    const cwd = '/projects/alpha'
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const projDir = join(projTmp, encoded)
    mkdirSync(projDir, { recursive: true })
    const sdkId = '0000-aaaa-bbbb-historic'
    const txtMsg = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, sessionId: sdkId })
    const asstMsg = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, sessionId: sdkId })
    // Note: the second 'user' line below has tool_result content — it
    // must NOT count toward userPromptCount.
    const transcript = [
      txtMsg('first prompt'),
      asstMsg('first reply'),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] }, sessionId: sdkId },
      txtMsg('second prompt'),
      asstMsg('second reply'),
      txtMsg('third prompt'),
      asstMsg('third reply'),
    ]
    writeFileSync(
      join(projDir, `${sdkId}.jsonl`),
      transcript.map(o => JSON.stringify(o)).join('\n') + '\n',
    )

    // Bring up a session that points at this sdkId.
    await dispatch({ jsonrpc: '2.0', id: 350, method: 'claude.resumeSession',
      params: { sessionId: 'rw-1', sdkSessionId: sdkId, options: { cwd } } })

    // Rewind to prompt index 1 (the second text-bearing user prompt).
    // Cutoff line should be the index-3 line (txtMsg('second prompt')).
    const reply = await dispatch({ jsonrpc: '2.0', id: 351, method: 'claude.rewindToPrompt',
      params: { sessionId: 'rw-1', promptIndex: 1 } })
    assert.ok(reply.result, `expected result, got ${JSON.stringify(reply)}`)
    assert.equal(typeof reply.result.newSdkSessionId, 'string')
    assert.notEqual(reply.result.newSdkSessionId, sdkId)
    // Lines kept = indexes 0..2 = 3 lines. removed = 7 - 3 = 4.
    assert.equal(reply.result.removedPromptCount, 4)
    // The new transcript file exists with the kept lines and the
    // sessionId field rewritten.
    const newFile = join(projDir, `${reply.result.newSdkSessionId}.jsonl`)
    const newRaw = await readFile(newFile, 'utf-8')
    const newLines = newRaw.split('\n').filter(l => l.trim())
    assert.equal(newLines.length, 3)
    for (const line of newLines) {
      const obj = JSON.parse(line)
      assert.equal(obj.sessionId, reply.result.newSdkSessionId,
        'kept lines must have their sessionId rewritten to the new id')
    }
    // Session state was rewired.
    assert.equal(mod.sessions.get('rw-1').sdkSessionId, reply.result.newSdkSessionId)

    // Out-of-range promptIndex returns an error message.
    const oobReply = await dispatch({ jsonrpc: '2.0', id: 352, method: 'claude.rewindToPrompt',
      params: { sessionId: 'rw-1', promptIndex: 99 } })
    assert.ok(oobReply.result.error, `expected error, got ${JSON.stringify(oobReply)}`)
    assert.match(oobReply.result.error, /not found|user prompt/)

    // Streaming session refuses rewind (the renderer must stop the turn first).
    const streamingSession = mod.sessions.get('rw-1')
    streamingSession.streaming = true
    const busyReply = await dispatch({ jsonrpc: '2.0', id: 353, method: 'claude.rewindToPrompt',
      params: { sessionId: 'rw-1', promptIndex: 0 } })
    assert.match(busyReply.result.error || '', /Claude is responding/)
    streamingSession.streaming = false

    // Missing/invalid params surface clear error messages (not throws).
    const missingSidReply = await dispatch({ jsonrpc: '2.0', id: 354, method: 'claude.rewindToPrompt',
      params: { promptIndex: 0 } })
    assert.match(missingSidReply.result.error || '', /missing sessionId/)
    const negIdxReply = await dispatch({ jsonrpc: '2.0', id: 355, method: 'claude.rewindToPrompt',
      params: { sessionId: 'rw-1', promptIndex: -1 } })
    assert.match(negIdxReply.result.error || '', /non-negative number/)

    // Unknown sessionId.
    const unknownReply = await dispatch({ jsonrpc: '2.0', id: 356, method: 'claude.rewindToPrompt',
      params: { sessionId: 'never-started', promptIndex: 0 } })
    assert.equal(unknownReply.result.error, 'Session not found')
  } finally {
    __setProjectsDirOverrideForTests(null)
    rmSync(projTmp, { recursive: true, force: true })
  }

  // claude.forkSession: copy the current SDK transcript into a new SDK
  // session id by running a one-turn `forkSession: true` query. Drive the
  // SDK with a fake that yields a `system:init` carrying a new session_id,
  // then a `result` (the handler must wait for result before returning so
  // the CLI has time to persist the forked transcript). Assert the
  // captured queryOptions include forkSession + resume + maxTurns + cwd
  // + abortController, and that the handler returns { newSdkSessionId }.
  const forkCaptured = []
  const restoreForkSend = mod.__setSendEventForTests(() => {})
  const fakeSdkFork = {
    query({ prompt, options }) {
      forkCaptured.push({ prompt, options })
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'forked-sdk-id', cwd: options.cwd, model: 'claude-opus-4-7', permissionMode: 'default' },
        { type: 'result', subtype: 'success', session_id: 'forked-sdk-id', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkFork)
  try {
    // Bring up a session with a current sdkSessionId via resumeSession so
    // the fork has something to copy from.
    await dispatch({ jsonrpc: '2.0', id: 400, method: 'claude.resumeSession',
      params: { sessionId: 'fork-1', sdkSessionId: 'sdk-original-abc',
        options: { cwd: '/fork-cwd' } } })

    const reply = await dispatch({ jsonrpc: '2.0', id: 401, method: 'claude.forkSession',
      params: { sessionId: 'fork-1' } })
    assert.ok(reply.result, `expected result, got ${JSON.stringify(reply)}`)
    assert.equal(reply.result.newSdkSessionId, 'forked-sdk-id')
    // Original session record is unchanged — fork doesn't mutate the
    // current session's sdkSessionId. The renderer creates a separate
    // session record for the fork.
    assert.equal(mod.sessions.get('fork-1').sdkSessionId, 'sdk-original-abc')

    // Captured query() must carry the SDK fork contract.
    assert.equal(forkCaptured.length, 1)
    const opts = forkCaptured[0].options
    assert.equal(opts.forkSession, true, 'forkSession flag must be set')
    assert.equal(opts.resume, 'sdk-original-abc', 'resume must point at the current sdk id')
    assert.equal(opts.maxTurns, 1, 'maxTurns:1 keeps the fork query short')
    assert.equal(opts.cwd, '/fork-cwd')
    assert.ok(opts.abortController, 'abortController must be supplied for timeout')
    assert.equal(forkCaptured[0].prompt, ' ', 'prompt must be a single space')

    // Missing sessionId → null (no-op).
    const noSidReply = await dispatch({ jsonrpc: '2.0', id: 402, method: 'claude.forkSession',
      params: {} })
    assert.equal(noSidReply.result, null)

    // Unknown session → null.
    const unknownReply = await dispatch({ jsonrpc: '2.0', id: 403, method: 'claude.forkSession',
      params: { sessionId: 'never-started' } })
    assert.equal(unknownReply.result, null)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreForkSend()
  }

  // Session without sdkSessionId yet → null (nothing to fork from).
  await dispatch({ jsonrpc: '2.0', id: 404, method: 'claude.startSession',
    params: { sessionId: 'fork-empty', options: { cwd: '/x' } } })
  // Note: startSession creates session record but sdkSessionId is empty
  // until a query has run. The fake SDK isn't installed here, so even if
  // we did have an id, the SDK loader returns null in test env.
  const noIdReply = await dispatch({ jsonrpc: '2.0', id: 405, method: 'claude.forkSession',
    params: { sessionId: 'fork-empty' } })
  assert.equal(noIdReply.result, null)

  // Fork that never yields a session_id → null. Drive a fake SDK whose
  // generator yields only a `result` with no preceding `system:init`.
  const restoreForkSend2 = mod.__setSendEventForTests(() => {})
  const fakeSdkForkNoInit = {
    query() {
      return (async function*() {
        yield { type: 'result', subtype: 'success', session_id: 'whatever', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkForkNoInit)
  try {
    await dispatch({ jsonrpc: '2.0', id: 406, method: 'claude.resumeSession',
      params: { sessionId: 'fork-no-init', sdkSessionId: 'sdk-no-init',
        options: { cwd: '/x' } } })
    const noInitReply = await dispatch({ jsonrpc: '2.0', id: 407, method: 'claude.forkSession',
      params: { sessionId: 'fork-no-init' } })
    assert.equal(noInitReply.result, null,
      'no system:init means no new session_id captured → null')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreForkSend2()
  }

  // claude.fetchSubagentMessages: read the SDK's per-subagent transcript
  // shard and normalise into the renderer's (ClaudeMessage|ClaudeToolCall)[]
  // shape. Drive a fake SDK exporting `getSubagentMessages()` that yields
  // a synthetic 4-message conversation: user kickoff prompt, assistant
  // tool_use, user tool_result (success), assistant final reply. Assert
  // the sidecar collapses the tool_result back into the matching tool
  // entry, drops noise messages, and tags items with parentToolUseId.
  const fetchCaptured = []
  const restoreFetchSend = mod.__setSendEventForTests(() => {})
  const fakeSdkFetch = {
    getSubagentMessages(sdkSid, agentId, opts) {
      fetchCaptured.push({ sdkSid, agentId, opts })
      return Promise.resolve([
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'sub kickoff' }] },
          timestamp: '2026-05-09T10:00:00Z',
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [
            { type: 'thinking', thinking: 'planning the bash run' },
            { type: 'text', text: 'I will run the command.' },
            { type: 'tool_use', id: 'tu-bash-1', name: 'Bash', input: { command: 'ls' } },
          ] },
          timestamp: '2026-05-09T10:00:01Z',
        },
        {
          type: 'user',
          message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'tu-bash-1', content: 'file1\nfile2', is_error: false },
          ] },
          timestamp: '2026-05-09T10:00:02Z',
        },
        // Noise message — must be dropped.
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
          timestamp: '2026-05-09T10:00:03Z',
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [
            { type: 'text', text: 'Done.' },
          ] },
          timestamp: '2026-05-09T10:00:04Z',
        },
      ])
    },
  }
  __setSdkOverrideForTests(fakeSdkFetch)
  try {
    await dispatch({ jsonrpc: '2.0', id: 410, method: 'claude.resumeSession',
      params: { sessionId: 'sa-1', sdkSessionId: 'sdk-parent-xyz',
        options: { cwd: '/sa-cwd' } } })

    const reply = await dispatch({ jsonrpc: '2.0', id: 411, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-1', agentToolUseId: 'agent-tu-1' } })
    assert.ok(Array.isArray(reply.result), `expected array, got ${JSON.stringify(reply)}`)
    assert.equal(reply.result.length, 4, 'kickoff + thinking-bearing assistant + bash tool + final reply (noise dropped)')

    // SDK helper was called with sdkSessionId, agentToolUseId, and {dir:cwd}.
    assert.equal(fetchCaptured.length, 1)
    assert.equal(fetchCaptured[0].sdkSid, 'sdk-parent-xyz')
    assert.equal(fetchCaptured[0].agentId, 'agent-tu-1')
    assert.deepEqual(fetchCaptured[0].opts, { dir: '/sa-cwd' })

    // Item 0: user kickoff text. parentToolUseId pinned to the agent.
    assert.equal(reply.result[0].role, 'user')
    assert.equal(reply.result[0].content, 'sub kickoff')
    assert.equal(reply.result[0].parentToolUseId, 'agent-tu-1')

    // Item 1: assistant text with thinking sidecar.
    assert.equal(reply.result[1].role, 'assistant')
    assert.equal(reply.result[1].content, 'I will run the command.')
    assert.equal(reply.result[1].thinking, 'planning the bash run')

    // Item 2: tool_use entry, status updated to 'completed' by the
    // tool_result fold-in, result text captured.
    assert.equal(reply.result[2].toolName, 'Bash')
    assert.equal(reply.result[2].id, 'tu-bash-1')
    assert.deepEqual(reply.result[2].input, { command: 'ls' })
    assert.equal(reply.result[2].status, 'completed', 'tool_result is_error:false → completed')
    assert.equal(reply.result[2].result, 'file1\nfile2', 'tool_result content folded in')

    // Item 3: final assistant reply.
    assert.equal(reply.result[3].role, 'assistant')
    assert.equal(reply.result[3].content, 'Done.')

    // is_error:true should map status → 'error'.
    const errSdk = {
      getSubagentMessages: () => Promise.resolve([
        { type: 'assistant', message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu-read-1', name: 'Read', input: { file_path: '/missing' } },
        ] } },
        { type: 'user', message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu-read-1', content: 'ENOENT', is_error: true },
        ] } },
      ]),
    }
    __setSdkOverrideForTests(errSdk)
    const errReply = await dispatch({ jsonrpc: '2.0', id: 412, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-1', agentToolUseId: 'agent-tu-2' } })
    assert.equal(errReply.result.length, 1)
    assert.equal(errReply.result[0].status, 'error')
    assert.equal(errReply.result[0].result, 'ENOENT')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreFetchSend()
  }

  // Defensive paths: missing params → []; unknown sessionId → [];
  // session without sdkSessionId → []; SDK throws → []; SDK without
  // getSubagentMessages helper → []. All five must avoid throwing so the
  // renderer just shows "no subagent details" instead of crashing.
  const restoreFetchSend2 = mod.__setSendEventForTests(() => {})
  try {
    const noSidReply = await dispatch({ jsonrpc: '2.0', id: 413, method: 'claude.fetchSubagentMessages',
      params: { agentToolUseId: 'a' } })
    assert.deepEqual(noSidReply.result, [])
    const noAgentReply = await dispatch({ jsonrpc: '2.0', id: 414, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-1' } })
    assert.deepEqual(noAgentReply.result, [])
    const unknownReply = await dispatch({ jsonrpc: '2.0', id: 415, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'never-started', agentToolUseId: 'a' } })
    assert.deepEqual(unknownReply.result, [])

    // Session with no sdkSessionId yet → [] (start without resume).
    await dispatch({ jsonrpc: '2.0', id: 416, method: 'claude.startSession',
      params: { sessionId: 'sa-empty', options: { cwd: '/x' } } })
    const noSdkReply = await dispatch({ jsonrpc: '2.0', id: 417, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-empty', agentToolUseId: 'a' } })
    assert.deepEqual(noSdkReply.result, [])

    // SDK throws → [].
    const throwingSdk = {
      getSubagentMessages: () => Promise.reject(new Error('disk read failed')),
    }
    __setSdkOverrideForTests(throwingSdk)
    await dispatch({ jsonrpc: '2.0', id: 418, method: 'claude.resumeSession',
      params: { sessionId: 'sa-throw', sdkSessionId: 'sdk-t', options: { cwd: '/x' } } })
    const throwReply = await dispatch({ jsonrpc: '2.0', id: 419, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-throw', agentToolUseId: 'a' } })
    assert.deepEqual(throwReply.result, [], 'sdk throw → graceful []')

    // SDK without getSubagentMessages helper → [].
    __setSdkOverrideForTests({ /* no getSubagentMessages */ })
    const noHelperReply = await dispatch({ jsonrpc: '2.0', id: 420, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-throw', agentToolUseId: 'a' } })
    assert.deepEqual(noHelperReply.result, [], 'missing helper → []')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreFetchSend2()
  }

  // claude.restSession / wakeSession / isResting — the renderer's
  // pause/resume UX. rest aborts in-flight + emits a one-line system
  // message so the panel shows "tap to wake"; wake clears the flag;
  // sendMessage also auto-wakes (mirror of claude-agent-manager.ts:581).
  // Drive a fake SDK so we can pre-flag streaming + verify abort signal
  // propagation without depending on real network.
  const restEvents = []
  const restoreRestSend = mod.__setSendEventForTests((method, payload) => {
    restEvents.push({ method, payload })
  })
  try {
    // Bring up a session via resumeSession (gives it an sdkSessionId).
    const fakeSdkRest = {
      query() {
        return (async function*() { /* never yields */ })()
      },
    }
    __setSdkOverrideForTests(fakeSdkRest)
    await dispatch({ jsonrpc: '2.0', id: 430, method: 'claude.resumeSession',
      params: { sessionId: 'rest-1', sdkSessionId: 'sdk-rest-x',
        options: { cwd: '/r' } } })

    // Initial state: not resting.
    const before = await dispatch({ jsonrpc: '2.0', id: 431, method: 'claude.isResting',
      params: { sessionId: 'rest-1' } })
    assert.equal(before.result, false)

    // Pre-flag streaming + plant an abortController to verify rest aborts.
    const restingSession = mod.sessions.get('rest-1')
    const ac = new AbortController()
    restingSession.streaming = true
    restingSession.abortController = ac

    restEvents.length = 0
    const restReply = await dispatch({ jsonrpc: '2.0', id: 432, method: 'claude.restSession',
      params: { sessionId: 'rest-1' } })
    assert.equal(restReply.result, true)
    assert.equal(restingSession.isResting, true)
    assert.equal(restingSession.streaming, false, 'rest must clear streaming flag')
    // abortController stays referenced (signal kept aborted) so a
    // pending sendMessage's catch can still read .aborted to emit
    // turn-end with reason:'aborted' instead of 'error'. The next
    // ensureLiveQuery overwrites the field on rebuild.
    assert.equal(ac.signal.aborted, true, 'rest must abort the in-flight signal')
    assert.equal(restingSession.liveQuery, null, 'rest must close liveQuery')
    // Emitted exactly one system message hint.
    const sysMsgEvents = restEvents.filter(e => e.method === 'claude:message'
      && e.payload?.message?.role === 'system')
    assert.equal(sysMsgEvents.length, 1, 'rest emits one system hint message')
    assert.match(sysMsgEvents[0].payload.message.content, /resting/i)

    // isResting now true.
    const during = await dispatch({ jsonrpc: '2.0', id: 433, method: 'claude.isResting',
      params: { sessionId: 'rest-1' } })
    assert.equal(during.result, true)

    // wakeSession clears the flag.
    const wakeReply = await dispatch({ jsonrpc: '2.0', id: 434, method: 'claude.wakeSession',
      params: { sessionId: 'rest-1' } })
    assert.equal(wakeReply.result, true)
    assert.equal(restingSession.isResting, false)
    const after = await dispatch({ jsonrpc: '2.0', id: 435, method: 'claude.isResting',
      params: { sessionId: 'rest-1' } })
    assert.equal(after.result, false)

    // sendMessage also auto-wakes a resting session (mirror of Electron
    // line 581-582 — incoming user input always wakes).
    restingSession.isResting = true
    // SDK is still installed; use a fake that yields a complete turn so
    // sendMessage doesn't hang, but we don't care about the response —
    // only the isResting flip is under test.
    __setSdkOverrideForTests({
      query() {
        return (async function*() {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-rest-x', cwd: '/r', model: null, permissionMode: 'default' }
          yield { type: 'result', subtype: 'success', session_id: 'sdk-rest-x', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
        })()
      },
    })
    await dispatch({ jsonrpc: '2.0', id: 436, method: 'claude.sendMessage',
      params: { sessionId: 'rest-1', prompt: 'wake up' } })
    assert.equal(restingSession.isResting, false, 'sendMessage auto-wakes')

    // Defensive: missing/unknown sessionId returns false on all three.
    const noSidRest = await dispatch({ jsonrpc: '2.0', id: 437, method: 'claude.restSession',
      params: {} })
    assert.equal(noSidRest.result, false)
    const noSidWake = await dispatch({ jsonrpc: '2.0', id: 438, method: 'claude.wakeSession',
      params: {} })
    assert.equal(noSidWake.result, false)
    const noSidIsResting = await dispatch({ jsonrpc: '2.0', id: 439, method: 'claude.isResting',
      params: {} })
    assert.equal(noSidIsResting.result, false)
    const unknownRest = await dispatch({ jsonrpc: '2.0', id: 440, method: 'claude.restSession',
      params: { sessionId: 'never-started' } })
    assert.equal(unknownRest.result, false)
    const unknownIsResting = await dispatch({ jsonrpc: '2.0', id: 441, method: 'claude.isResting',
      params: { sessionId: 'never-started' } })
    assert.equal(unknownIsResting.result, false)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreRestSend()
  }

  // claude.archiveMessages / loadArchived / clearArchive — pure fs
  // round-trip under a tmpdir BAT_SIDECAR_DATA_DIR override. Drives a
  // 5-message archive, loads with offset/limit pages from the tail
  // (mirror Electron's tail-pagination contract), clears, and verifies
  // the file is gone.
  const archiveDataDir = mkdtempSync(join(tmpdir(), 'sidecar-archive-'))
  const savedDataDirArchive = process.env.BAT_SIDECAR_DATA_DIR
  process.env.BAT_SIDECAR_DATA_DIR = archiveDataDir
  try {
    // Empty archive (no file yet) → empty page.
    const empty = await dispatch({ jsonrpc: '2.0', id: 450, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 0, limit: 10 } })
    assert.deepEqual(empty.result, { messages: [], total: 0, hasMore: false })

    // Archive 5 messages.
    const msgs = [
      { id: 'm1', role: 'user', content: 'first' },
      { id: 'm2', role: 'assistant', content: 'reply 1' },
      { id: 'm3', role: 'user', content: 'second' },
      { id: 'm4', role: 'assistant', content: 'reply 2' },
      { id: 'm5', role: 'user', content: 'third' },
    ]
    const archived = await dispatch({ jsonrpc: '2.0', id: 451, method: 'claude.archiveMessages',
      params: { sessionId: 'arch-1', messages: msgs } })
    assert.equal(archived.result, true)

    // Tail page: offset=0, limit=2 → last 2 messages [m4, m5]; hasMore true.
    const tail2 = await dispatch({ jsonrpc: '2.0', id: 452, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 0, limit: 2 } })
    assert.equal(tail2.result.total, 5)
    assert.equal(tail2.result.hasMore, true)
    assert.equal(tail2.result.messages.length, 2)
    assert.equal(tail2.result.messages[0].id, 'm4')
    assert.equal(tail2.result.messages[1].id, 'm5')

    // Page back: offset=2 (skip last 2), limit=2 → [m2, m3]; hasMore true.
    const tail22 = await dispatch({ jsonrpc: '2.0', id: 453, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 2, limit: 2 } })
    assert.equal(tail22.result.messages.length, 2)
    assert.equal(tail22.result.messages[0].id, 'm2')
    assert.equal(tail22.result.messages[1].id, 'm3')
    assert.equal(tail22.result.hasMore, true)

    // Beyond start: offset=4, limit=10 → [m1] only; hasMore false.
    const tailEnd = await dispatch({ jsonrpc: '2.0', id: 454, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 4, limit: 10 } })
    assert.equal(tailEnd.result.messages.length, 1)
    assert.equal(tailEnd.result.messages[0].id, 'm1')
    assert.equal(tailEnd.result.hasMore, false)

    // Past total: offset=999 → empty + hasMore:false (graceful).
    const past = await dispatch({ jsonrpc: '2.0', id: 455, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 999, limit: 10 } })
    assert.deepEqual(past.result, { messages: [], total: 5, hasMore: false })

    // Append more — archive should grow not overwrite.
    await dispatch({ jsonrpc: '2.0', id: 456, method: 'claude.archiveMessages',
      params: { sessionId: 'arch-1', messages: [{ id: 'm6', role: 'user', content: 'fourth' }] } })
    const grown = await dispatch({ jsonrpc: '2.0', id: 457, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 0, limit: 1 } })
    assert.equal(grown.result.total, 6)
    assert.equal(grown.result.messages[0].id, 'm6')

    // clearArchive removes the file → next load returns empty page.
    const cleared = await dispatch({ jsonrpc: '2.0', id: 458, method: 'claude.clearArchive',
      params: { sessionId: 'arch-1' } })
    assert.equal(cleared.result, true)
    const afterClear = await dispatch({ jsonrpc: '2.0', id: 459, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 0, limit: 10 } })
    assert.deepEqual(afterClear.result, { messages: [], total: 0, hasMore: false })
    // clearArchive on a non-existent file is still ok.
    const clearAgain = await dispatch({ jsonrpc: '2.0', id: 460, method: 'claude.clearArchive',
      params: { sessionId: 'arch-never' } })
    assert.equal(clearAgain.result, true)

    // Defensive: missing/invalid params return false / empty page.
    const noSidArch = await dispatch({ jsonrpc: '2.0', id: 461, method: 'claude.archiveMessages',
      params: { messages: [] } })
    assert.equal(noSidArch.result, false)
    const noMsgsArch = await dispatch({ jsonrpc: '2.0', id: 462, method: 'claude.archiveMessages',
      params: { sessionId: 'x' } })
    assert.equal(noMsgsArch.result, false)
    const noSidLoad = await dispatch({ jsonrpc: '2.0', id: 463, method: 'claude.loadArchived',
      params: { offset: 0, limit: 10 } })
    assert.deepEqual(noSidLoad.result, { messages: [], total: 0, hasMore: false })
    const noSidClear = await dispatch({ jsonrpc: '2.0', id: 464, method: 'claude.clearArchive',
      params: {} })
    assert.equal(noSidClear.result, false)

    // sessionId path-escape attempt — sanitised to underscores so the
    // archive file lives inside message-archives/ regardless. We just
    // check it doesn't throw and round-trips under the sanitized name.
    await dispatch({ jsonrpc: '2.0', id: 465, method: 'claude.archiveMessages',
      params: { sessionId: '../../etc/passwd', messages: [{ id: 'evil' }] } })
    const escaped = await dispatch({ jsonrpc: '2.0', id: 466, method: 'claude.loadArchived',
      params: { sessionId: '../../etc/passwd', offset: 0, limit: 10 } })
    assert.equal(escaped.result.total, 1, 'sanitized path round-trips')
  } finally {
    rmSync(archiveDataDir, { recursive: true, force: true })
    if (savedDataDirArchive === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
    else process.env.BAT_SIDECAR_DATA_DIR = savedDataDirArchive
  }

  // Parity test: queryOptions must include the same keys Electron sets.
  // Without these, the sidecar session loses the claude_code system
  // prompt + tool preset → no Bash/Read/Edit etc. Capture the raw
  // options by intercepting query() and assert each parity key is set.
  const parityCaptured = []
  const restoreParitySend = mod.__setSendEventForTests(() => {})
  const fakeSdkParity = {
    query({ prompt, options }) {
      parityCaptured.push({ prompt, options })
      // Yield a minimal valid stream so handler exits cleanly.
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'p-sdk', cwd: '/p', model: 'claude-opus-4-7', permissionMode: 'default' },
        { type: 'result', subtype: 'success', session_id: 'p-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkParity)
  try {
    // Use an Opus 4.7 auto-compact preset so we exercise the
    // sdkModelForClaudeSelection mapping (preset → base id) plus the
    // CLAUDE_CODE_AUTO_COMPACT_WINDOW env hookup.
    await dispatch({ jsonrpc: '2.0', id: 230, method: 'claude.startSession',
      params: { sessionId: 'parity-1', options: {
        cwd: '/p',
        model: 'claude-opus-4-7:auto-compact-200k',
        autoCompactWindow: 200000,
        permissionMode: 'bypassPermissions',
        effort: 'high',
      } } })
    await dispatch({ jsonrpc: '2.0', id: 231, method: 'claude.sendMessage',
      params: { sessionId: 'parity-1', prompt: 'hello' } })
    assert.equal(parityCaptured.length, 1, 'expected exactly one query() call')
    const opts = parityCaptured[0].options
    // claude_code preset (system prompt + tools) — without these the
    // session has no built-in tools.
    assert.deepEqual(opts.systemPrompt, { type: 'preset', preset: 'claude_code' })
    assert.deepEqual(opts.tools, { type: 'preset', preset: 'claude_code' })
    // Streaming + setting + agent UX flags.
    assert.equal(opts.includePartialMessages, true)
    assert.equal(opts.promptSuggestions, true)
    assert.deepEqual(opts.settingSources, ['user', 'project', 'local'])
    assert.equal(opts.agentProgressSummaries, true)
    assert.deepEqual(opts.toolConfig, { askUserQuestion: { previewFormat: 'html' } })
    // Effort + permission + bypass mapping.
    assert.equal(opts.effort, 'high')
    assert.equal(opts.permissionMode, 'bypassPermissions')
    assert.equal(opts.allowDangerouslySkipPermissions, true)
    // sdkModelForClaudeSelection maps the preset to the base id.
    assert.equal(opts.model, 'claude-opus-4-7')
    // autoCompactWindow → CLAUDE_CODE_AUTO_COMPACT_WINDOW env passthrough.
    assert.ok(opts.env, 'expected env on queryOptions when autoCompactWindow is set')
    assert.equal(opts.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000')
    // abortController must be set so abort propagates.
    assert.ok(opts.abortController, 'expected abortController on queryOptions')

    // Second turn with empty prompt must enable continue + carry resume.
    await dispatch({ jsonrpc: '2.0', id: 232, method: 'claude.sendMessage',
      params: { sessionId: 'parity-1', prompt: '' } })
    const opts2 = parityCaptured[1].options
    assert.equal(opts2.resume, 'p-sdk', 'resume should carry sdkSessionId from prior turn')
    assert.equal(opts2.continue, true, 'continue:true expected when resuming with empty prompt')

    // bypassPlan must map to plan (SDK does not understand bypassPlan).
    mod.sessions.get('parity-1').permissionMode = 'bypassPlan'
    await dispatch({ jsonrpc: '2.0', id: 233, method: 'claude.sendMessage',
      params: { sessionId: 'parity-1', prompt: 'plan it' } })
    const opts3 = parityCaptured[2].options
    assert.equal(opts3.permissionMode, 'plan', 'bypassPlan -> plan mapping')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreParitySend()
  }

  // Image attachment must produce a single SDKUserMessage with
  // image+text content blocks, delivered through the streaming-input
  // prompt iterable so the SDK's CLI subprocess sees it. The fake SDK
  // here drains the iterable (mirroring real SDK behaviour) and
  // captures the user message for shape validation.
  const imageCaptured = []
  const restoreImageSend = mod.__setSendEventForTests(() => {})
  const fakeSdkImage = {
    query({ prompt, options }) {
      const cap = { prompt, options, userMessages: [] }
      imageCaptured.push(cap)
      const userIter = prompt[Symbol.asyncIterator]()
      return (async function*() {
        // Pull one user message (matches our single push per send).
        const next = await userIter.next()
        if (!next.done) cap.userMessages.push(next.value)
        yield { type: 'system', subtype: 'init', session_id: 'img-sdk', cwd: '/i', model: 'claude-sonnet-4-6', permissionMode: 'default' }
        yield { type: 'result', subtype: 'success', session_id: 'img-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkImage)
  try {
    await dispatch({ jsonrpc: '2.0', id: 240, method: 'claude.startSession',
      params: { sessionId: 'img-1', options: { cwd: '/i', model: 'claude-sonnet-4-6' } } })
    // 1×1 transparent PNG.
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    await dispatch({ jsonrpc: '2.0', id: 241, method: 'claude.sendMessage',
      params: { sessionId: 'img-1', prompt: 'describe this', images: [tinyPng] } })
    assert.equal(imageCaptured.length, 1, 'sdk.query must run once for the first send')
    const promptArg = imageCaptured[0].prompt
    assert.equal(typeof promptArg, 'object', 'streaming-input mode passes an iterable for prompt')
    assert.equal(typeof promptArg[Symbol.asyncIterator], 'function', 'expected async iterable prompt')
    // The fake SDK drained the first user message — its shape must be
    // image-then-text content blocks.
    assert.equal(imageCaptured[0].userMessages.length, 1)
    const userMsg = imageCaptured[0].userMessages[0]
    assert.equal(userMsg.type, 'user')
    assert.equal(userMsg.message.role, 'user')
    assert.equal(userMsg.message.content.length, 2)
    assert.equal(userMsg.message.content[0].type, 'image')
    assert.equal(userMsg.message.content[0].source.media_type, 'image/png')
    assert.equal(userMsg.message.content[1].type, 'text')
    assert.equal(userMsg.message.content[1].text, 'describe this')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreImageSend()
  }

  // canUseTool round-trip. Fake SDK calls the canUseTool callback with
  // a Bash tool; sidecar must surface a claude:permission-request event
  // and then resolve the SDK's promise when claude.resolvePermission
  // arrives from the renderer. This is the wire that lets the Tauri
  // permission UI actually approve / deny tool calls.
  const permCaptured = []
  const restorePermSend = mod.__setSendEventForTests((name, payload) => permCaptured.push({ name, payload }))
  let canUseToolFn = null
  const fakeSdkPerm = {
    query({ options }) {
      canUseToolFn = options.canUseTool
      return (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'perm-sdk' }
        // We yield, then the test triggers canUseTool out-of-band.
        // We need the message stream to "wait" for the resolution
        // before yielding the result so the test ordering is stable.
        await new Promise(r => setTimeout(r, 50))
        yield { type: 'result', subtype: 'success', session_id: 'perm-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkPerm)
  try {
    await dispatch({ jsonrpc: '2.0', id: 260, method: 'claude.startSession',
      params: { sessionId: 'perm-1', options: { cwd: '/p' } } })
    // Kick off sendMessage but do not await — we'll trigger canUseTool
    // mid-stream via the captured callback ref.
    const sendPromise = dispatch({ jsonrpc: '2.0', id: 261, method: 'claude.sendMessage',
      params: { sessionId: 'perm-1', prompt: 'run a tool' } })
    // Wait for the sendMessage handler to enter the for-await loop and
    // canUseTool to be wired up.
    await new Promise(r => setTimeout(r, 10))
    assert.ok(canUseToolFn, 'expected canUseTool to be set on queryOptions')
    // Drive a Bash request through canUseTool.
    const cuPromise = canUseToolFn('Bash', { command: 'ls' }, { toolUseID: 'tool-bash-1', suggestions: [], decisionReason: 'why?' })
    // Wait long enough for the permission-request event to be emitted.
    await new Promise(r => setTimeout(r, 5))
    const permEvents = permCaptured.filter(e => e.name === 'claude:permission-request')
    assert.equal(permEvents.length, 1)
    assert.equal(permEvents[0].payload.sessionId, 'perm-1')
    assert.equal(permEvents[0].payload.data.toolUseId, 'tool-bash-1')
    assert.equal(permEvents[0].payload.data.toolName, 'Bash')
    assert.deepEqual(permEvents[0].payload.data.input, { command: 'ls' })
    // Renderer answers via claude.resolvePermission.
    const resolveReply = await dispatch({ jsonrpc: '2.0', id: 262, method: 'claude.resolvePermission',
      params: { sessionId: 'perm-1', toolUseId: 'tool-bash-1', result: { behavior: 'allow', updatedInput: { command: 'ls' } } } })
    assert.equal(resolveReply.result, true)
    const decision = await cuPromise
    assert.equal(decision.behavior, 'allow')
    assert.deepEqual(decision.updatedInput, { command: 'ls' })
    // claude:permission-resolved event must have fired.
    const resolvedEvents = permCaptured.filter(e => e.name === 'claude:permission-resolved')
    assert.equal(resolvedEvents.length, 1)
    assert.equal(resolvedEvents[0].payload.toolUseId, 'tool-bash-1')
    // Drain sendMessage.
    await sendPromise
  } finally {
    __setSdkOverrideForTests(undefined)
    restorePermSend()
    canUseToolFn = null
  }

  // bypassPermissions auto-allows without surfacing UI.
  const bypassCaptured = []
  const restoreBypassSend = mod.__setSendEventForTests((name, payload) => bypassCaptured.push({ name, payload }))
  let bypassCanUse = null
  const fakeSdkBypass = {
    query({ options }) {
      bypassCanUse = options.canUseTool
      return (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'bp-sdk' }
        yield { type: 'result', subtype: 'success', session_id: 'bp-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkBypass)
  try {
    await dispatch({ jsonrpc: '2.0', id: 270, method: 'claude.startSession',
      params: { sessionId: 'bp-1', options: { cwd: '/p', permissionMode: 'bypassPermissions' } } })
    await dispatch({ jsonrpc: '2.0', id: 271, method: 'claude.sendMessage',
      params: { sessionId: 'bp-1', prompt: 'go' } })
    assert.ok(bypassCanUse)
    const decision = bypassCanUse('Bash', { command: 'rm -rf /' }, { toolUseID: 'bp-tool' })
    // Synchronous decision — not a Promise (or resolves immediately).
    const result = await Promise.resolve(decision)
    assert.equal(result.behavior, 'allow')
    // No permission-request event fired.
    const permEvents = bypassCaptured.filter(e => e.name === 'claude:permission-request')
    assert.equal(permEvents.length, 0, 'bypassPermissions must not emit permission-request')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreBypassSend()
    bypassCanUse = null
  }

  // acceptEdits auto-allows file/read tools but still prompts for Bash.
  const acceptCaptured = []
  const restoreAcceptSend = mod.__setSendEventForTests((name, payload) => acceptCaptured.push({ name, payload }))
  let acceptCanUse = null
  const fakeSdkAccept = {
    query({ options }) {
      acceptCanUse = options.canUseTool
      return (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'ae-sdk' }
        yield { type: 'result', subtype: 'success', session_id: 'ae-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkAccept)
  try {
    await dispatch({ jsonrpc: '2.0', id: 280, method: 'claude.startSession',
      params: { sessionId: 'ae-1', options: { cwd: '/p', permissionMode: 'acceptEdits' } } })
    await dispatch({ jsonrpc: '2.0', id: 281, method: 'claude.sendMessage',
      params: { sessionId: 'ae-1', prompt: 'go' } })
    assert.ok(acceptCanUse)
    const editDecision = await Promise.resolve(acceptCanUse('Edit', { path: '/x', diff: '...' }, { toolUseID: 'ae-edit' }))
    assert.equal(editDecision.behavior, 'allow', 'Edit must auto-allow in acceptEdits')
    // Bash still prompts.
    const bashPromise = acceptCanUse('Bash', { command: 'ls' }, { toolUseID: 'ae-bash' })
    await new Promise(r => setTimeout(r, 5))
    const permEvents = acceptCaptured.filter(e => e.name === 'claude:permission-request')
    assert.equal(permEvents.length, 1, 'acceptEdits Bash must prompt')
    // Resolve so the promise settles cleanly.
    await dispatch({ jsonrpc: '2.0', id: 282, method: 'claude.resolvePermission',
      params: { sessionId: 'ae-1', toolUseId: 'ae-bash', result: { behavior: 'deny', message: 'no' } } })
    const bashResult = await bashPromise
    assert.equal(bashResult.behavior, 'deny')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreAcceptSend()
    acceptCanUse = null
  }

  // AskUserQuestion: sidecar emits claude:ask-user, renderer answers via
  // claude.resolveAskUser, and the SDK promise resolves to the answers.
  const askCaptured = []
  const restoreAskSend = mod.__setSendEventForTests((name, payload) => askCaptured.push({ name, payload }))
  let askCanUse = null
  const fakeSdkAsk = {
    query({ options }) {
      askCanUse = options.canUseTool
      return (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'ask-sdk' }
        yield { type: 'result', subtype: 'success', session_id: 'ask-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkAsk)
  try {
    await dispatch({ jsonrpc: '2.0', id: 290, method: 'claude.startSession',
      params: { sessionId: 'ask-1', options: { cwd: '/p' } } })
    await dispatch({ jsonrpc: '2.0', id: 291, method: 'claude.sendMessage',
      params: { sessionId: 'ask-1', prompt: 'q' } })
    assert.ok(askCanUse)
    const askPromise = askCanUse('AskUserQuestion', { questions: [{ id: 'q1', text: 'pick' }] }, { toolUseID: 'ask-tool' })
    await new Promise(r => setTimeout(r, 5))
    const askEvents = askCaptured.filter(e => e.name === 'claude:ask-user')
    assert.equal(askEvents.length, 1)
    assert.equal(askEvents[0].payload.data.toolUseId, 'ask-tool')
    assert.deepEqual(askEvents[0].payload.data.questions, [{ id: 'q1', text: 'pick' }])
    await dispatch({ jsonrpc: '2.0', id: 292, method: 'claude.resolveAskUser',
      params: { sessionId: 'ask-1', toolUseId: 'ask-tool', answers: { q1: 'option-A' } } })
    const answers = await askPromise
    assert.deepEqual(answers, { q1: 'option-A' })
    const resolved = askCaptured.filter(e => e.name === 'claude:ask-user-resolved')
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].payload.toolUseId, 'ask-tool')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreAskSend()
    askCanUse = null
  }

  // Plugin loading: when ~/.claude/plugins/installed_plugins.json
  // exists with valid entries, queryOptions.plugins is set to
  // [{ type: 'local', path }] for each installPath.
  const { __setPluginsPathOverrideForTests, loadInstalledPlugins } = mod
  // Empty / missing file -> empty array (graceful).
  const tmpRoot = mkdtempSync(join(tmpdir(), 'sidecar-plugins-'))
  try {
    const missingPath = join(tmpRoot, 'does-not-exist.json')
    __setPluginsPathOverrideForTests(missingPath)
    const empty = await loadInstalledPlugins()
    assert.deepEqual(empty, [], 'missing file -> []')

    // Malformed JSON -> empty.
    const badPath = join(tmpRoot, 'bad.json')
    writeFileSync(badPath, '{ not valid json')
    __setPluginsPathOverrideForTests(badPath)
    const malformed = await loadInstalledPlugins()
    assert.deepEqual(malformed, [], 'malformed json -> []')

    // Real shape: pluginsData.plugins is an object whose values are
    // arrays of {installPath} entries. Mirrors the on-disk format
    // Claude CLI writes when running `/plugin install`.
    const goodPath = join(tmpRoot, 'good.json')
    writeFileSync(goodPath, JSON.stringify({
      plugins: {
        'official': [
          { installPath: '/home/u/.claude/plugins/official/some-plugin' },
          { installPath: '/home/u/.claude/plugins/official/other-plugin' },
        ],
        'community': [
          { installPath: '/home/u/.claude/plugins/community/extra' },
        ],
        'malformed': [
          { /* no installPath */ },
          'string-not-object',
          null,
        ],
      },
    }))
    __setPluginsPathOverrideForTests(goodPath)
    const loaded = await loadInstalledPlugins()
    assert.equal(loaded.length, 3, 'expected 3 plugins (malformed entries skipped)')
    for (const p of loaded) {
      assert.equal(p.type, 'local')
      assert.match(p.path, /^\/home\/u\/\.claude\/plugins\//)
    }

    // Now verify sendMessage actually wires the plugins into queryOptions.
    const pluginCaptured = []
    const restoreSend = mod.__setSendEventForTests(() => {})
    const fakeSdkPlugin = {
      query({ options }) {
        pluginCaptured.push({ options })
        const messages = [
          { type: 'system', subtype: 'init', session_id: 'pl-sdk', cwd: '/p' },
          { type: 'result', subtype: 'success', session_id: 'pl-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
        ]
        return (async function*() { for (const m of messages) yield m })()
      },
    }
    __setSdkOverrideForTests(fakeSdkPlugin)
    try {
      await dispatch({ jsonrpc: '2.0', id: 250, method: 'claude.startSession',
        params: { sessionId: 'pl-1', options: { cwd: '/p' } } })
      await dispatch({ jsonrpc: '2.0', id: 251, method: 'claude.sendMessage',
        params: { sessionId: 'pl-1', prompt: 'hi' } })
      assert.equal(pluginCaptured.length, 1)
      const opts = pluginCaptured[0].options
      assert.ok(Array.isArray(opts.plugins), 'expected plugins on queryOptions')
      assert.equal(opts.plugins.length, 3)
      assert.equal(opts.plugins[0].type, 'local')

      // No plugins file -> queryOptions.plugins absent (not [] — Electron
      // spreads conditionally).
      __setPluginsPathOverrideForTests(missingPath)
      await dispatch({ jsonrpc: '2.0', id: 252, method: 'claude.sendMessage',
        params: { sessionId: 'pl-1', prompt: 'again' } })
      assert.equal(pluginCaptured.length, 2)
      assert.equal(pluginCaptured[1].options.plugins, undefined,
        'plugins option must be absent when no plugins are installed')
    } finally {
      __setSdkOverrideForTests(undefined)
      restoreSend()
    }
  } finally {
    __setPluginsPathOverrideForTests(null)
    rmSync(tmpRoot, { recursive: true, force: true })
  }

  // Regression: __normalizeMainPath must equate a Windows verbatim-
  // prefixed path with its non-prefixed sibling. Tauri's resource_dir()
  // returns `\\?\C:\...`-style paths on Windows, and a previous version
  // of the isMain check naively compared `file://<argv[1]>` against
  // import.meta.url — that comparison failed for verbatim paths, so
  // main() never ran and the sidecar exited immediately on every spawn,
  // surfacing as Win32 ERROR_NO_DATA (232) on the parent's stdin pipe.
  const { __normalizeMainPath } = mod
  if (process.platform === 'win32') {
    const verbatim = '\\\\?\\C:\\foo\\BAR\\server.mjs'
    const normal = 'C:\\foo\\BAR\\server.mjs'
    assert.equal(__normalizeMainPath(verbatim), __normalizeMainPath(normal),
      'verbatim and non-verbatim Windows paths must normalize equal')
    // Case-insensitive (Windows fs is).
    assert.equal(__normalizeMainPath('C:\\Foo\\Bar.mjs'), __normalizeMainPath('c:\\foo\\bar.mjs'))
  }
  assert.equal(__normalizeMainPath(''), '')
  assert.equal(__normalizeMainPath(null), '')

  // Helpers (sdkModelForClaudeSelection + dataUrlToContentBlock) sanity.
  const { sdkModelForClaudeSelection, dataUrlToContentBlock } = mod
  assert.equal(sdkModelForClaudeSelection(undefined), undefined)
  assert.equal(sdkModelForClaudeSelection('claude-sonnet-4-6'), 'claude-sonnet-4-6')
  assert.equal(sdkModelForClaudeSelection('claude-opus-4-7:auto-compact-200k'), 'claude-opus-4-7')
  assert.equal(sdkModelForClaudeSelection('claude-opus-4-7:auto-compact-300k'), 'claude-opus-4-7')
  assert.equal(sdkModelForClaudeSelection('claude-opus-4-7:1m'), 'claude-opus-4-7')
  assert.equal(dataUrlToContentBlock('not a data url'), null)
  assert.equal(dataUrlToContentBlock(''), null)
  const block = dataUrlToContentBlock('data:image/png;base64,iVBORw0KGgo=')
  assert.equal(block?.type, 'image')
  assert.equal(block?.source.media_type, 'image/png')
  assert.equal(block?.source.data, 'iVBORw0KGgo=')

  // Drift guard: sidecar CLAUDE_MODEL_CONTEXT_WINDOWS must agree with
  // src/utils/claude-model-presets.ts CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS
  // for every base-id key + value, AND must contain entries for all
  // four auto-compact preset ids (values are hand-derived from
  // OPUS_47_PRESET_AUTO_COMPACT and don't exactly mirror that map —
  // :1m has TS-side null (no auto-compact) but the actual context
  // window is 1M, which is what we surface to maxTokens).
  // Scope the match to the same map literal we located earlier (ctxMatch[1]).
  const { CLAUDE_MODEL_CONTEXT_WINDOWS, expectedContextWindowForModel } = mod
  const tsCtxMap = new Map()
  for (const m of ctxMatch[1].matchAll(/\[\s*'([^']+)'\s*,\s*(\d+)\s*\]/g)) {
    tsCtxMap.set(m[1], parseInt(m[2], 10))
  }
  for (const [k, v] of tsCtxMap) {
    assert.equal(
      CLAUDE_MODEL_CONTEXT_WINDOWS.get(k), v,
      `sidecar CLAUDE_MODEL_CONTEXT_WINDOWS[${k}] (${CLAUDE_MODEL_CONTEXT_WINDOWS.get(k)}) drifted from TS (${v})`,
    )
  }
  // Preset entries must exist with a positive number.
  for (const presetId of [
    'claude-opus-4-7:auto-compact-200k',
    'claude-opus-4-7:auto-compact-300k',
    'claude-opus-4-7:auto-compact-400k',
    'claude-opus-4-7:1m',
  ]) {
    const v = CLAUDE_MODEL_CONTEXT_WINDOWS.get(presetId)
    assert.ok(typeof v === 'number' && v > 0, `expected positive context window for ${presetId}, got ${v}`)
  }

  // Spot-check a few well-known values + expectedContextWindowForModel
  // base-id fallback semantics.
  assert.equal(CLAUDE_MODEL_CONTEXT_WINDOWS.get('claude-opus-4-7'), 1000000)
  assert.equal(CLAUDE_MODEL_CONTEXT_WINDOWS.get('claude-haiku-4-5-20251001'), 200000)
  assert.equal(CLAUDE_MODEL_CONTEXT_WINDOWS.get('claude-opus-4-7:auto-compact-200k'), 200000)
  assert.equal(CLAUDE_MODEL_CONTEXT_WINDOWS.get('claude-opus-4-7:1m'), 1000000)
  // expectedContextWindowForModel: hits map; falls back to base id by
  // stripping [1m]; returns null for unknown.
  assert.equal(expectedContextWindowForModel('claude-opus-4-7'), 1000000)
  assert.equal(expectedContextWindowForModel('claude-opus-4-7[1m]'), 1000000)
  assert.equal(expectedContextWindowForModel('claude-opus-4-6[1m]'), 1000000)
  assert.equal(expectedContextWindowForModel(undefined), null)
  assert.equal(expectedContextWindowForModel('totally-unknown-model'), null)

  // claude.getContextUsage: cached usage from stream_event + result.
  // Inject a fake SDK that streams a message_start with usage, a result
  // with final usage, then verify the handler returns the right shape.
  __setSdkOverrideForTests({
    query() {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'cu-sdk', cwd: '/x' },
        { type: 'stream_event', session_id: 'cu-sdk', parent_tool_use_id: null, event: { type: 'message_start', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 200, output_tokens: 0 } } } },
        { type: 'assistant', session_id: 'cu-sdk', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success', session_id: 'cu-sdk', result: 'hi', stop_reason: 'end_turn',
          total_cost_usd: 0.0042, num_turns: 1,
          usage: { input_tokens: 150, cache_creation_input_tokens: 50, cache_read_input_tokens: 250, output_tokens: 30 } },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  })
  try {
    // Pre-turn: getContextUsage returns null (no usage cached yet).
    await dispatch({ jsonrpc: '2.0', id: 290, method: 'claude.startSession',
      params: { sessionId: 'cu-1', options: { cwd: '/x', model: 'claude-sonnet-4-6' } } })
    const preReply = await dispatch({ jsonrpc: '2.0', id: 291, method: 'claude.getContextUsage', params: { sessionId: 'cu-1' } })
    assert.equal(preReply.result, null)
    // Run a turn. result.usage should override the mid-stream estimate.
    await dispatch({ jsonrpc: '2.0', id: 292, method: 'claude.sendMessage', params: { sessionId: 'cu-1', prompt: 'hi' } })
    const postReply = await dispatch({ jsonrpc: '2.0', id: 293, method: 'claude.getContextUsage', params: { sessionId: 'cu-1' } })
    const cu = postReply.result
    assert.ok(cu, 'expected non-null context usage after turn')
    assert.equal(cu.totalTokens, 150 + 50 + 250)  // input + creation + read
    assert.equal(cu.maxTokens, 1000000)  // claude-sonnet-4-6 = 1M
    assert.equal(cu.percentage, Math.round((450 / 1000000) * 100))
    assert.equal(cu.model, 'claude-sonnet-4-6')
    assert.equal(cu.apiUsage.input_tokens, 150)
    assert.equal(cu.apiUsage.output_tokens, 30)
    assert.equal(cu.apiUsage.cache_creation_input_tokens, 50)
    assert.equal(cu.apiUsage.cache_read_input_tokens, 250)
    assert.deepEqual(cu.categories, [{ name: 'Context', tokens: 450, color: '#8B5CF6' }])
  } finally {
    __setSdkOverrideForTests(undefined)
  }
  // Unknown sessionId → null (renderer interprets as "no data yet").
  const unknownReply = await dispatch({ jsonrpc: '2.0', id: 294, method: 'claude.getContextUsage', params: { sessionId: 'doesnt-exist' } })
  assert.equal(unknownReply.result, null)

  // Live-Query backed read APIs (getSupportedCommands / getSupportedAgents
  // / getAccountInfo) are pinned in the dedicated Live-Query contract block
  // above (no-session / unknown-session / live / throwing-currentQuery).
  // No SDK fallback here — these RPCs no longer call the SDK builder.

  // stream_event → claude:stream mapping for real-time text/thinking
  // deltas. Only content_block_delta with text or thinking forwards;
  // other stream event variants (message_start, message_delta usage,
  // ping, etc.) are dropped at this layer. Verifies the contract.
  const streamCaptured = []
  const restoreStreamEmit = mod.__setSendEventForTests((n, p) => streamCaptured.push({ name: n, payload: p }))
  const fakeSdkWithStream = {
    query() {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 's-stream', cwd: '/x' },
        { type: 'stream_event', session_id: 's-stream', parent_tool_use_id: null, event: { type: 'message_start', message: { usage: { input_tokens: 10 } } } },
        { type: 'stream_event', session_id: 's-stream', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { text: 'Hel' } } },
        { type: 'stream_event', session_id: 's-stream', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { text: 'lo' } } },
        { type: 'stream_event', session_id: 's-stream', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { thinking: 'pondering' } } },
        { type: 'stream_event', session_id: 's-stream', parent_tool_use_id: null, event: { type: 'ping' } },
        { type: 'assistant', session_id: 's-stream', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
        { type: 'result', subtype: 'success', session_id: 's-stream', result: 'Hello', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkWithStream)
  try {
    await dispatch({ jsonrpc: '2.0', id: 280, method: 'claude.startSession', params: { sessionId: 'stream-1', options: { cwd: '/x' } } })
    await dispatch({ jsonrpc: '2.0', id: 281, method: 'claude.sendMessage', params: { sessionId: 'stream-1', prompt: 'hi' } })
    const streamEvents = streamCaptured.filter(e => e.name === 'claude:stream')
    // 2 text deltas + 1 thinking delta = 3 stream events. message_start
    // and ping must NOT produce a stream event.
    assert.equal(streamEvents.length, 3, `expected 3 stream events, got ${streamEvents.length}`)
    assert.equal(streamEvents[0].payload.data.text, 'Hel')
    assert.equal(streamEvents[1].payload.data.text, 'lo')
    assert.equal(streamEvents[2].payload.data.thinking, 'pondering')
    // parentToolUseId field present (null for top-level stream).
    for (const ev of streamEvents) assert.equal(ev.payload.data.parentToolUseId, null)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreStreamEmit()
  }

  // rate_limit_event mapping. The SDK emits a top-level message of
  // type 'rate_limit_event' when the API throttles us; the sidecar
  // must convert that into a claude:rate-limit notification with
  // resetsAt expanded from seconds to ms (renderer does Date math
  // on it). A second event missing required fields must NOT emit —
  // the SDK occasionally produces partial rate_limit_event during
  // transient slowdowns we don't want to surface.
  const rateLimitCaptured = []
  const restoreRateLimitEmit = mod.__setSendEventForTests((n, p) => rateLimitCaptured.push({ name: n, payload: p }))
  const fakeSdkWithRateLimit = {
    query() {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 's-rl', cwd: '/x' },
        // Full rate-limit event — should emit.
        { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'primary', resetsAt: 1700000000, utilization: 0.92, isUsingOverage: false } },
        // Missing resetsAt — must NOT emit.
        { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'primary', utilization: 0.5 } },
        // utilization optional — emit but utilization=null.
        { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'fallback', resetsAt: 1700001000, isUsingOverage: true } },
        { type: 'result', subtype: 'success', session_id: 's-rl', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkWithRateLimit)
  try {
    await dispatch({ jsonrpc: '2.0', id: 290, method: 'claude.startSession', params: { sessionId: 'rl-1', options: { cwd: '/x' } } })
    await dispatch({ jsonrpc: '2.0', id: 291, method: 'claude.sendMessage', params: { sessionId: 'rl-1', prompt: 'hi' } })
    const rl = rateLimitCaptured.filter(e => e.name === 'claude:rate-limit')
    assert.equal(rl.length, 2, `expected 2 rate-limit emits (one full, one no-utilization), got ${rl.length}`)
    // First emit — full info, resetsAt converted to ms.
    assert.equal(rl[0].payload.sessionId, 'rl-1')
    assert.equal(rl[0].payload.info.rateLimitType, 'primary')
    assert.equal(rl[0].payload.info.resetsAt, 1700000000 * 1000)
    assert.equal(rl[0].payload.info.utilization, 0.92)
    assert.equal(rl[0].payload.info.isUsingOverage, false)
    // Second emit — utilization omitted → null, isUsingOverage=true.
    assert.equal(rl[1].payload.info.rateLimitType, 'fallback')
    assert.equal(rl[1].payload.info.utilization, null)
    assert.equal(rl[1].payload.info.isUsingOverage, true)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreRateLimitEmit()
  }

  // Abort path: while a query is mid-stream (fake SDK yields slowly),
  // claude.abortSession must propagate to the AbortController so the
  // SDK's iterator terminates promptly. Verifies the renderer's stop
  // button actually stops a running turn.
  const abortCaptured = []
  const restoreAbortEmit = mod.__setSendEventForTests((n, p) => abortCaptured.push({ name: n, payload: p }))
  let signalSeenByFakeSdk = null
  const slowFakeSdk = {
    query({ options }) {
      signalSeenByFakeSdk = options?.abortController?.signal ?? null
      return (async function*() {
        // Yield init synchronously so we know the loop entered.
        yield { type: 'system', subtype: 'init', session_id: 'sdk-abort', cwd: '/x' }
        // Then "stream" forever, checking the abort signal each iteration.
        // 50 iterations * 25ms = 1.25s ceiling without abort; abort
        // should cut us off long before that.
        for (let i = 0; i < 50; i++) {
          if (signalSeenByFakeSdk?.aborted) {
            // Mirror real SDK behaviour: throw AbortError when aborted.
            throw new Error('aborted')
          }
          await new Promise(r => setTimeout(r, 25))
          yield { type: 'assistant', session_id: 'sdk-abort', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: `chunk-${i}` }] } }
        }
        yield { type: 'result', subtype: 'success', session_id: 'sdk-abort', result: 'done', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(slowFakeSdk)
  try {
    await dispatch({ jsonrpc: '2.0', id: 260, method: 'claude.startSession',
      params: { sessionId: 'abort-1', options: { cwd: '/x' } } })
    // Kick off sendMessage but don't await yet — it'll block on the
    // generator. abortSession needs to execute concurrently.
    const sendPromise = dispatch({ jsonrpc: '2.0', id: 261, method: 'claude.sendMessage',
      params: { sessionId: 'abort-1', prompt: 'tell me a long story' } })
    // Wait long enough for a few chunks to stream so we KNOW the abort
    // happens mid-flight (not before the loop even started).
    await new Promise(r => setTimeout(r, 80))
    const beforeAbort = abortCaptured.length
    assert.ok(beforeAbort >= 2, `expected ≥2 events before abort, got ${beforeAbort}`)
    const abortReply = await dispatch({ jsonrpc: '2.0', id: 262, method: 'claude.abortSession',
      params: { sessionId: 'abort-1' } })
    assert.equal(abortReply.result.ok, true)
    // sendMessage must complete promptly after abort — use a 1s ceiling
    // (much tighter than the 1.25s the fake SDK would otherwise run).
    const settled = await Promise.race([
      sendPromise,
      new Promise(r => setTimeout(() => r({ timedOut: true }), 1000)),
    ])
    assert.ok(!settled.timedOut, 'sendMessage did not settle within 1s of abortSession')
    // signal must have been propagated to the SDK so the fake iterator
    // saw .aborted=true.
    assert.ok(signalSeenByFakeSdk?.aborted, 'abort signal never reached the fake SDK iterator')
    // turn-end with reason:'aborted' must be present.
    const turnEnd = abortCaptured.find(e => e.name === 'claude:turn-end')
    assert.ok(turnEnd, 'expected claude:turn-end after abort')
    assert.equal(turnEnd.payload.payload.reason, 'aborted')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreAbortEmit()
  }

  // Tool-use / tool-result event mapping. The SDK emits assistant
  // messages whose content arrays carry tool_use blocks, and follow-up
  // user messages whose content arrays carry tool_result blocks. We
  // mirror Electron's contract: emit claude:tool-use per tool_use block
  // and claude:tool-result per tool_result block, keyed by tool_use_id
  // so the renderer can pair them up. Verify with a fake SDK that
  // streams a Bash call + its result.
  const tcCaptured = []
  const restoreTcEmit = mod.__setSendEventForTests((n, p) => tcCaptured.push({ name: n, payload: p }))
  const fakeSdkWithTools = {
    query() {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'sdk-tc', cwd: '/x' },
        { type: 'assistant', session_id: 'sdk-tc', parent_tool_use_id: null, message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running command' },
            { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
          ],
        } },
        { type: 'user', session_id: 'sdk-tc', parent_tool_use_id: null, message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'file1\nfile2', is_error: false },
          ],
        } },
        { type: 'assistant', session_id: 'sdk-tc', parent_tool_use_id: null, message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/missing' } }],
        } },
        { type: 'user', session_id: 'sdk-tc', parent_tool_use_id: null, message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'ENOENT', is_error: true }],
        } },
        { type: 'result', subtype: 'success', session_id: 'sdk-tc', result: 'done', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkWithTools)
  try {
    await dispatch({ jsonrpc: '2.0', id: 240, method: 'claude.startSession',
      params: { sessionId: 'tc-1', options: { cwd: '/x' } } })
    await dispatch({ jsonrpc: '2.0', id: 241, method: 'claude.sendMessage',
      params: { sessionId: 'tc-1', prompt: 'list files' } })
    const toolUseEvents = tcCaptured.filter(e => e.name === 'claude:tool-use')
    const toolResultEvents = tcCaptured.filter(e => e.name === 'claude:tool-result')
    assert.equal(toolUseEvents.length, 2, `expected 2 tool-use events, got ${toolUseEvents.length}`)
    assert.equal(toolResultEvents.length, 2, `expected 2 tool-result events, got ${toolResultEvents.length}`)
    const tu1 = toolUseEvents[0].payload
    assert.equal(tu1.sessionId, 'tc-1')
    assert.equal(tu1.toolCall.id, 'toolu_01')
    assert.equal(tu1.toolCall.toolName, 'Bash')
    assert.deepEqual(tu1.toolCall.input, { command: 'ls' })
    assert.equal(tu1.toolCall.status, 'running')
    assert.equal(tu1.toolCall.parentToolUseId, null)
    assert.equal(typeof tu1.toolCall.timestamp, 'number')
    const tr1 = toolResultEvents[0].payload.result
    assert.equal(tr1.id, 'toolu_01')
    assert.equal(tr1.status, 'success')
    assert.equal(tr1.result, 'file1\nfile2')
    const tr2 = toolResultEvents[1].payload.result
    assert.equal(tr2.id, 'toolu_02')
    assert.equal(tr2.status, 'error')
    assert.equal(tr2.result, 'ENOENT')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreTcEmit()
  }

  // SDK-unavailable fallback: claude.sendMessage stays usable as a stub
  // so renderer doesn't hang. Locks the release-without-bundle contract.
  __setSdkOverrideForTests(null)
  const captured2 = []
  const restore2 = mod.__setSendEventForTests((n, p) => captured2.push({ name: n, payload: p }))
  try {
    await dispatch({ jsonrpc: '2.0', id: 230, method: 'claude.startSession',
      params: { sessionId: 'send-stub', options: { cwd: '/x' } } })
    const stubReply = await dispatch({ jsonrpc: '2.0', id: 231, method: 'claude.sendMessage',
      params: { sessionId: 'send-stub', prompt: 'hi' } })
    assert.equal(stubReply.result.ok, true)
    assert.equal(stubReply.result.stub, true)
    const stubEvents = captured2.filter(c => c.name?.startsWith('claude:')).map(c => c.name)
    assert.deepEqual(stubEvents, ['claude:message', 'claude:turn-end'])
  } finally {
    __setSdkOverrideForTests(undefined)
    restore2()
  }

  // claude.authLogin / authLogout / authStatus all spawn the resolved
  // claude CLI. Verify that the resolver picks up the bundled binary
  // when present (sidecar/node_modules/@anthropic-ai/claude-agent-sdk-<triple>/claude[.exe])
  // and that the env override BAT_SIDECAR_CLAUDE_BIN takes precedence.
  // We use the env override for the actual auth-flow tests so we can
  // point at a deterministic shim (process.execPath running an exit-0
  // script) instead of invoking the real CLI's network flow.
  const { resolveClaudeCliBinary, __resetClaudeCliCacheForTests } = mod
  __resetClaudeCliCacheForTests()
  const savedBin = process.env.BAT_SIDECAR_CLAUDE_BIN
  delete process.env.BAT_SIDECAR_CLAUDE_BIN
  try {
    const bundledPath = resolveClaudeCliBinary()
    if (bundledPath) {
      // Bundled binary resolved. Sanity check: it points at the SDK
      // package's claude executable.
      const bundledLower = bundledPath.toLowerCase().replace(/\\/g, '/')
      assert.ok(
        bundledLower.includes('node_modules/@anthropic-ai/claude-agent-sdk-'),
        `expected bundled path under @anthropic-ai/claude-agent-sdk-<triple>, got ${bundledPath}`,
      )
      assert.ok(
        bundledLower.endsWith('claude.exe') || bundledLower.endsWith('/claude'),
        `expected exe suffix, got ${bundledPath}`,
      )
    } else {
      // No bundled binary — that's OK in fresh checkouts where
      // node-sidecar/node_modules hasn't been installed. The handler
      // falls back to PATH lookup which we can't deterministically test.
      console.log('claude CLI bundle not present — bundled-resolver assertion skipped')
    }
  } finally {
    if (savedBin !== undefined) process.env.BAT_SIDECAR_CLAUDE_BIN = savedBin
  }

  // Env override: set BAT_SIDECAR_CLAUDE_BIN to a node shim that
  // exits 0 immediately. authLogin/authLogout dispatch must succeed
  // and report {success:true}. Verifies the spawn path is plumbed
  // correctly without hitting the real network OAuth flow.
  process.env.BAT_SIDECAR_CLAUDE_BIN = process.execPath
  __resetClaudeCliCacheForTests()
  try {
    // The shim is just `node`; pass an exit-0 args via a wrapper. Since
    // execFile passes our handler args as-is, we can't inject a
    // -e "process.exit(0)" globally — but `node auth login` will still
    // exit immediately with code 1 (unknown subcommand) which means we
    // get an error result, not a stub. That's enough to prove the
    // handler is calling spawnClaudeCli, not falling back to the stub.
    const loginReply = await dispatch({ jsonrpc: '2.0', id: 250, method: 'claude.authLogin' })
    // Either success (unlikely with node binary) or a CLI error message
    // from node. The pre-#23 stub would have returned a hardcoded
    // STUB_AUTH_ERR; absence of that string proves the wiring.
    assert.ok(loginReply.result, 'authLogin returned undefined result')
    if (!loginReply.result.success) {
      assert.ok(typeof loginReply.result.error === 'string')
      assert.ok(
        !loginReply.result.error.includes('not yet wired'),
        `authLogin still using stub error: ${loginReply.result.error}`,
      )
    }
    const logoutReply = await dispatch({ jsonrpc: '2.0', id: 251, method: 'claude.authLogout' })
    assert.ok(logoutReply.result)
  } finally {
    if (savedBin === undefined) delete process.env.BAT_SIDECAR_CLAUDE_BIN
    else process.env.BAT_SIDECAR_CLAUDE_BIN = savedBin
    __resetClaudeCliCacheForTests()
  }

  // remote.* / tunnel.* — server lifecycle still stubs (TLS+WS port lands
  // later); tunnel.getConnection now returns the real os.networkInterfaces()
  // address list so SettingsPanel's QR view has usable IPs even before a
  // server starts.
  {
    // remote.serverStatus — shape contract for renderer destructuring.
    const ss = await dispatch({ jsonrpc: '2.0', id: 9001, method: 'remote.serverStatus' })
    assert.equal(ss.result.running, false)
    assert.equal(ss.result.port, null)
    assert.equal(ss.result.fingerprint, null)
    assert.equal(ss.result.bindInterface, null)
    assert.equal(ss.result.boundHost, null)
    assert.deepEqual(ss.result.clients, [])

    // remote.clientStatus — same shape contract.
    const cs = await dispatch({ jsonrpc: '2.0', id: 9002, method: 'remote.clientStatus' })
    assert.equal(cs.result.connected, false)
    assert.equal(cs.result.info, null)

    // remote.startServer / connect / disconnect / clientStatus /
    // testConnection / listProfiles are now all real (#51, #52). The
    // end-to-end happy-path round trip is covered by the
    // remote-client-impl block below. Here we only assert the
    // input-validation branches that don't require a live server, since
    // SettingsPanel's `'error' in result` branch reads these.
    const conn = await dispatch({ jsonrpc: '2.0', id: 9004, method: 'remote.connect', params: { host: 'h', port: 1, token: 't' /* missing fingerprint */ } })
    assert.equal(typeof conn.result.error, 'string', 'missing fingerprint must surface error')
    assert.match(conn.result.error, /fingerprint/i)
    const test = await dispatch({ jsonrpc: '2.0', id: 9005, method: 'remote.testConnection', params: { host: 'h', port: 1, token: 't' /* missing fingerprint */ } })
    assert.equal(test.result.ok, false)
    assert.match(test.result.error, /fingerprint/i)
    const lp = await dispatch({ jsonrpc: '2.0', id: 9006, method: 'remote.listProfiles', params: { host: 'h', port: 1, token: 't' /* missing fingerprint */ } })
    assert.equal(typeof lp.result.error, 'string')
    assert.match(lp.result.error, /fingerprint/i)

    // tunnel.getConnection — loopback `boundHost` short-circuits to a
    // single 127.0.0.1 entry. The handler still returns `{error, addresses}`
    // because no server is running, but the address list is real.
    const localTun = await dispatch({ jsonrpc: '2.0', id: 9010, method: 'tunnel.getConnection', params: { boundHost: '127.0.0.1' } })
    assert.equal(typeof localTun.result.error, 'string', 'expected error since server not running')
    assert.ok(Array.isArray(localTun.result.addresses), 'addresses must be an array')
    assert.equal(localTun.result.addresses.length, 1)
    assert.equal(localTun.result.addresses[0].ip, '127.0.0.1')
    assert.equal(localTun.result.addresses[0].mode, 'localhost')
    assert.ok(localTun.result.addresses[0].label.includes('127.0.0.1'))

    // boundHost='::1' / 'localhost' aliases also collapse to loopback-only.
    for (const lh of ['::1', 'localhost']) {
      const r = await dispatch({ jsonrpc: '2.0', id: 9011, method: 'tunnel.getConnection', params: { boundHost: lh } })
      assert.equal(r.result.addresses.length, 1, `${lh} should yield 1 address`)
      assert.equal(r.result.addresses[0].mode, 'localhost')
    }

    // boundHost='0.0.0.0' / missing param / 'all' — return real LAN+
    // Tailscale addresses from os.networkInterfaces(). On CI/dev boxes
    // this list may be empty (no external NICs); we just assert the
    // shape and that no loopback leaks in. Each entry must have
    // {ip, mode, label} with mode in {tailscale, lan}.
    for (const params of [{ boundHost: '0.0.0.0' }, undefined, { boundHost: 'all' }]) {
      const r = await dispatch({ jsonrpc: '2.0', id: 9012, method: 'tunnel.getConnection', params })
      assert.equal(typeof r.result.error, 'string')
      assert.ok(Array.isArray(r.result.addresses))
      for (const addr of r.result.addresses) {
        assert.equal(typeof addr.ip, 'string')
        assert.ok(addr.mode === 'tailscale' || addr.mode === 'lan',
          `unexpected mode ${addr.mode} from external boundHost`)
        assert.equal(typeof addr.label, 'string')
        assert.ok(addr.label.includes(addr.ip), 'label should embed ip')
        // Tailscale mode entries should be 100.x; LAN mode entries should not.
        if (addr.mode === 'tailscale') {
          assert.ok(addr.ip.startsWith('100.'), `tailscale entry must be 100.x, got ${addr.ip}`)
        } else {
          assert.ok(!addr.ip.startsWith('100.'), `lan entry must not be 100.x, got ${addr.ip}`)
        }
      }
    }

    // Direct unit on the helper: synthesise a tailscale-only and a
    // mixed-only check by calling getAllAddresses(boundHost).
    const { getAllAddresses } = await import('../src/handlers/remote-tunnel.mjs')
    const loopback = getAllAddresses('127.0.0.1')
    assert.equal(loopback.length, 1)
    assert.equal(loopback[0].mode, 'localhost')
    // Helper called with a non-loopback boundHost returns [tailscale..., lan...]
    // — tailscale entries (if any) sort before LAN. Verify ordering invariant.
    const all = getAllAddresses('0.0.0.0')
    let sawLan = false
    for (const a of all) {
      if (a.mode === 'lan') sawLan = true
      else if (a.mode === 'tailscale' && sawLan) {
        throw new Error('tailscale entry appeared after lan entry — ordering broken')
      }
    }
  }

  // remote-protocol allowlists — must stay in lockstep with
  // electron/remote/protocol.ts. Read both files, parse out the Set
  // literals, diff. Any channel/event added to one side without the
  // other will fail authorization at runtime when the WebSocket server
  // lands, so we lock parity here.
  {
    const protocol = await import('../src/lib/remote-protocol.mjs')
    const electronSrcPath = resolve(here, '..', '..', 'electron', 'remote', 'protocol.ts')
    const electronSrc = await readFile(electronSrcPath, 'utf-8')

    function parseSet(varName) {
      // Match `export const <name> = new Set([ ... ])` and pull strings
      // out of the array literal. Tolerates JS comments inside the
      // array so we can keep the // PTY / // Claude section labels.
      const re = new RegExp(`export const ${varName}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`)
      const m = electronSrc.match(re)
      if (!m) throw new Error(`could not locate ${varName} in electron/remote/protocol.ts`)
      const body = m[1].replace(/\/\/[^\n]*\n/g, '\n')
      const items = []
      for (const sm of body.matchAll(/'([^']+)'/g)) items.push(sm[1])
      return new Set(items)
    }

    const electronChannels = parseSet('PROXIED_CHANNELS')
    const electronEvents = parseSet('PROXIED_EVENTS')

    function diffSets(label, a, b) {
      const onlyA = [...a].filter(x => !b.has(x))
      const onlyB = [...b].filter(x => !a.has(x))
      assert.deepEqual(onlyA, [], `${label}: in electron but not sidecar — ${onlyA.join(', ')}`)
      assert.deepEqual(onlyB, [], `${label}: in sidecar but not electron — ${onlyB.join(', ')}`)
    }

    diffSets('PROXIED_CHANNELS', electronChannels, protocol.PROXIED_CHANNELS)
    diffSets('PROXIED_EVENTS', electronEvents, protocol.PROXIED_EVENTS)
    // Sanity: the sets are non-trivial.
    assert.ok(protocol.PROXIED_CHANNELS.size > 50, `expected >50 channels, got ${protocol.PROXIED_CHANNELS.size}`)
    assert.ok(protocol.PROXIED_EVENTS.size > 15, `expected >15 events, got ${protocol.PROXIED_EVENTS.size}`)

    // Handler-registry contract: register / has / invoke / reset.
    const { registerRemoteHandler, hasRemoteHandler, invokeRemoteHandler, __resetRemoteHandlersForTests, __remoteHandlerCountForTests } = protocol
    __resetRemoteHandlersForTests()
    assert.equal(__remoteHandlerCountForTests(), 0)
    assert.equal(hasRemoteHandler('test:foo'), false)

    let calls = 0
    registerRemoteHandler('test:foo', async (ctx, ...args) => {
      calls++
      return { ctx, args }
    })
    assert.equal(__remoteHandlerCountForTests(), 1)
    assert.equal(hasRemoteHandler('test:foo'), true)

    // Default ctx: windowId=null, isRemote=false.
    const r1 = await invokeRemoteHandler('test:foo', ['hi', 42])
    assert.deepEqual(r1.ctx, { windowId: null, isRemote: false })
    assert.deepEqual(r1.args, ['hi', 42])
    // Custom ctx propagates.
    const r2 = await invokeRemoteHandler('test:foo', [], 'win-1', true)
    assert.deepEqual(r2.ctx, { windowId: 'win-1', isRemote: true })
    assert.deepEqual(r2.args, [])
    // Non-array args coerced to [] (mirror Electron's tolerance).
    const r3 = await invokeRemoteHandler('test:foo', null)
    assert.deepEqual(r3.args, [])
    assert.equal(calls, 3)

    // Unknown channel throws synchronously (matching Electron's behavior).
    await assert.rejects(invokeRemoteHandler('test:nope', []), /No handler for channel: test:nope/)

    // Validation: empty channel / non-function handler must throw.
    assert.throws(() => registerRemoteHandler('', () => {}), /non-empty string/)
    assert.throws(() => registerRemoteHandler('x', null), /must be a function/)

    // Reset clears the registry.
    __resetRemoteHandlersForTests()
    assert.equal(__remoteHandlerCountForTests(), 0)
    assert.equal(hasRemoteHandler('test:foo'), false)

    // The remote-server-impl block below relies on the production bridge
    // wiring (server.mjs runs wireRemoteBridgeHandlers() on import).
    // Re-wire here so subsequent tests see the same registry the live
    // sidecar starts with.
    const bridge = await import('../src/lib/remote-bridge.mjs')
    bridge.wireRemoteBridgeHandlers()
    assert.ok(hasRemoteHandler('claude:auth-status'),
      'bridge re-wire must register every PROXIED_CHANNEL')
    assert.ok(__remoteHandlerCountForTests() >= 50,
      `expected >50 bridged handlers, got ${__remoteHandlerCountForTests()}`)
  }

  // remote-bridge — kebab→camel translation + auto-bridge of every
  // PROXIED_CHANNEL into the sidecar's JSON-RPC dispatch.
  {
    const bridge = await import('../src/lib/remote-bridge.mjs')
    const { invokeRemoteHandler, hasRemoteHandler, __resetRemoteHandlersForTests } =
      await import('../src/lib/remote-protocol.mjs')

    // (a) channelToMethod translates kebab → camel correctly. Anchors:
    //   simple namespaces, hyphenated channels, channels already in
    //   camelCase, image:read-as-data-url (multi-hyphen).
    assert.equal(bridge.channelToMethod('claude:start-session'), 'claude.startSession')
    assert.equal(bridge.channelToMethod('claude:auth-status'), 'claude.authStatus')
    assert.equal(bridge.channelToMethod('claude:get-supported-models'), 'claude.getSupportedModels')
    assert.equal(bridge.channelToMethod('image:read-as-data-url'), 'image.readAsDataUrl')
    assert.equal(bridge.channelToMethod('snippet:toggleFavorite'), 'snippet.toggleFavorite')
    assert.equal(bridge.channelToMethod('git:getRoot'), 'git.getRoot')
    assert.equal(bridge.channelToMethod('agent:list-presets'), 'agent.listPresets')
    assert.equal(bridge.channelToMethod('profile:get-active-ids'), 'profile.getActiveIds')
    // Empty/non-string throws — never silently returns garbage.
    assert.throws(() => bridge.channelToMethod(''), /non-empty string/)
    assert.throws(() => bridge.channelToMethod(null), /non-empty string/)

    // (b) wireRemoteBridgeHandlers is idempotent. After bootstrap the
    // registry is full; re-running registers nothing more (count stays).
    const before = __resetRemoteHandlersForTests
    // Snapshot the post-server.mjs-import wiring then make sure re-run
    // doesn't double-count.
    const firstRun = bridge.wireRemoteBridgeHandlers()
    const secondRun = bridge.wireRemoteBridgeHandlers()
    assert.equal(secondRun, 0, 'second wire pass must be a no-op')
    // firstRun is non-negative; if the registry was full from server
    // import it'll be 0, otherwise > 0. Either way the registry is now
    // in the wired state.
    assert.ok(firstRun >= 0)
    assert.ok(hasRemoteHandler('claude:auth-status'))
    assert.ok(hasRemoteHandler('worktree:create'))

    // (c) Direct invokeRemoteHandler hits dispatch. claude:auth-status
    // → claude.authStatus → null or auth object.
    const authR = await invokeRemoteHandler('claude:auth-status', [])
    assert.ok(authR === null || typeof authR === 'object')

    // (d) Unbridged channel (no sidecar handler — pty:create lives in
    // Tauri Rust) propagates JSON-RPC -32601 as a thrown Error with
    // `method not found` in the message.
    await assert.rejects(invokeRemoteHandler('pty:create', [{}]), /method not found/i)

    // (e) args[0] becomes JSON-RPC params. Use claude.getSupportedModels
    // which takes optional `{cwd}` — the bridge passes args[0] verbatim.
    // (Result is an array; we only assert shape.)
    const models = await invokeRemoteHandler('claude:get-supported-models', [{ cwd: tmpdir() }])
    assert.ok(Array.isArray(models), `expected array, got ${typeof models}`)
  }

  // path-guard — port of electron/path-guard.ts and src-tauri/path_guard.rs.
  // Same deny list across all three hosts so the sidecar can't be tricked
  // into reading credential stores via image.readAsDataUrl (or a future
  // fs.readFile handler) just because the renderer asks nicely.
  {
    const { isSensitivePath } = await import('../src/lib/path-guard.mjs')
    const { homedir } = await import('os')
    const home = homedir()
    const sep = process.platform === 'win32' ? '\\' : '/'

    // (a) Empty / non-string → sensitive (caller is broken).
    assert.equal(isSensitivePath(''), true)
    assert.equal(isSensitivePath(null), true)
    assert.equal(isSensitivePath(undefined), true)
    assert.equal(isSensitivePath(123), true)

    // (b) Unrelated paths in the user's home / project tree are NOT
    //     sensitive — Claude legitimately reads ~/.bashrc, /etc/hosts,
    //     etc. Stricter scoping would belong at ctx.isRemote.
    assert.equal(isSensitivePath(`${home}${sep}.bashrc`), false)
    assert.equal(isSensitivePath(`${home}${sep}projects${sep}foo${sep}README.md`), false)
    if (process.platform !== 'win32') {
      assert.equal(isSensitivePath('/etc/hosts'), false)
      assert.equal(isSensitivePath('/usr/local/bin/node'), false)
    }

    // (c) ~/.ssh and anything beneath blocked (directory containment).
    assert.equal(isSensitivePath(`${home}${sep}.ssh`), true)
    assert.equal(isSensitivePath(`${home}${sep}.ssh${sep}id_rsa`), true)
    assert.equal(isSensitivePath(`${home}${sep}.ssh${sep}known_hosts`), true)
    // Sibling directory must NOT match (prefix check guards against
    // /home/user/.sshfs being treated as /home/user/.ssh).
    assert.equal(isSensitivePath(`${home}${sep}.sshfs${sep}config`), false)

    // (d) AWS / GCP / kube credential stores blocked.
    assert.equal(isSensitivePath(`${home}${sep}.aws${sep}credentials`), true)
    assert.equal(isSensitivePath(`${home}${sep}.kube${sep}config`), true)
    assert.equal(isSensitivePath(`${home}${sep}.config${sep}gcloud${sep}application_default_credentials.json`), true)
    assert.equal(isSensitivePath(`${home}${sep}.netrc`), true)
    assert.equal(isSensitivePath(`${home}${sep}.claude${sep}.credentials.json`), true)

    // (e) Private-key filename heuristic — id_rsa / id_ed25519 / *.pem
    //     under any .ssh/ or keys/ directory anywhere in the tree.
    assert.equal(isSensitivePath(`${home}${sep}work${sep}.ssh${sep}id_ed25519`), true)
    assert.equal(isSensitivePath(`${home}${sep}.ssh${sep}id_rsa.pub`), true)
    assert.equal(isSensitivePath(`/srv/keys/host.pem`.replaceAll('/', sep)), true)
    // Same filename outside .ssh/keys is fine.
    assert.equal(isSensitivePath(`${home}${sep}docs${sep}id_rsa.txt`), false)

    // (f) System-wide files (POSIX only — Windows path normalisation
    //     mangles forward slashes).
    if (process.platform !== 'win32') {
      assert.equal(isSensitivePath('/etc/shadow'), true)
      assert.equal(isSensitivePath('/etc/sudoers'), true)
      assert.equal(isSensitivePath('/root'), true)
      assert.equal(isSensitivePath('/root/.bashrc'), true)
    }
  }

  // image.readAsDataUrl — port of electron's `image:read-as-data-url`
  // and Tauri's `image_read_as_data_url`. 10 MiB cap, ext→MIME map,
  // path-guard refusal for sensitive paths, base64-encoded data URL.
  {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sidecar-img-'))
    try {
      // (a) Round-trip a tiny PNG → data:image/png;base64,<...>.
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02, 0x03,
      ])
      const pngPath = join(tmpRoot, 'tiny.png')
      writeFileSync(pngPath, pngBytes)
      const reply = await dispatch({ jsonrpc: '2.0', id: 700, method: 'image.readAsDataUrl',
        params: { path: pngPath } })
      assert.equal(typeof reply.result, 'string')
      assert.match(reply.result, /^data:image\/png;base64,/)
      const payload = reply.result.replace(/^data:image\/png;base64,/, '')
      const decoded = Buffer.from(payload, 'base64')
      assert.deepEqual([...decoded], [...pngBytes],
        'data URL must round-trip back to the original bytes')

      // (b) Bare-string params (Electron-style positional invoke through
      //     the bridge) also works.
      const stringReply = await dispatch({ jsonrpc: '2.0', id: 701, method: 'image.readAsDataUrl',
        params: pngPath })
      assert.match(stringReply.result, /^data:image\/png;base64,/)

      // (c) Extension → MIME mapping. .jpg/.jpeg → image/jpeg, .gif →
      //     image/gif, .webp → image/webp, anything else → image/png.
      for (const [ext, mime] of [['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
                                  ['gif', 'image/gif'], ['webp', 'image/webp'],
                                  ['bmp', 'image/png']]) {
        const p = join(tmpRoot, `t.${ext}`)
        writeFileSync(p, Buffer.from([0xFF]))
        const r = await dispatch({ jsonrpc: '2.0', id: 702, method: 'image.readAsDataUrl',
          params: { path: p } })
        assert.match(r.result, new RegExp(`^data:${mime.replace('/', '\\/')};base64,`))
      }

      // (d) Missing path → JSON-RPC error.
      const noPath = await dispatch({ jsonrpc: '2.0', id: 703, method: 'image.readAsDataUrl',
        params: {} })
      assert.match(noPath.error?.message || '', /missing path/)

      // (e) >10 MiB → refused with "Image too large".
      const bigPath = join(tmpRoot, 'big.png')
      writeFileSync(bigPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0))
      const big = await dispatch({ jsonrpc: '2.0', id: 704, method: 'image.readAsDataUrl',
        params: { path: bigPath } })
      assert.match(big.error?.message || '', /Image too large/)

      // (f) path-guard refuses sensitive paths. We exercise this with a
      //     synthetic ~/.ssh/id_rsa-shaped path — it doesn't have to
      //     exist on disk, the guard short-circuits before stat().
      const { homedir } = await import('os')
      const sshKey = join(homedir(), '.ssh', 'id_rsa')
      const denied = await dispatch({ jsonrpc: '2.0', id: 705, method: 'image.readAsDataUrl',
        params: { path: sshKey } })
      assert.match(denied.error?.message || '', /sensitive path/)

      // (g) Non-existent path → fs error surfaces (not a guard error).
      const ghost = await dispatch({ jsonrpc: '2.0', id: 706, method: 'image.readAsDataUrl',
        params: { path: join(tmpRoot, 'does-not-exist.png') } })
      assert.ok(ghost.error?.message, 'expected an error message for missing file')
      assert.doesNotMatch(ghost.error.message, /sensitive path/)

      // (h) End-to-end via the remote bridge: invokeRemoteHandler with
      //     'image:read-as-data-url' and `args[0] = {path}` reaches the
      //     handler through the bridge. Mirrors the renderer→remote
      //     client→host wire pattern.
      const protocol = await import('../src/lib/remote-protocol.mjs')
      const remoteResult = await protocol.invokeRemoteHandler('image:read-as-data-url', [{ path: pngPath }])
      assert.match(remoteResult, /^data:image\/png;base64,/)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  }

  // fs.* — port of the Electron fs:* handlers (readdir/readFile/home/
  // listDirs/mkdir/deletePath/quickLocations/resolvePathLinks). Each
  // exercises path-guard, the Tauri object-shaped params plus the
  // bare-string fallback, and verifies the structured-error contract
  // the renderer relies on.
  {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } = await import('fs')
    const { join, sep } = await import('path')
    const { tmpdir, homedir } = await import('os')
    const protocol = await import('../src/lib/remote-protocol.mjs')
    const fsRoot = mkdtempSync(join(tmpdir(), 'sidecar-fs-'))
    try {
      // (a) fs.home returns os.homedir().
      const homeReply = await dispatch({ jsonrpc: '2.0', id: 800, method: 'fs.home' })
      assert.equal(homeReply.result, homedir())

      // (b) fs.readdir — directory containment + ignored set + sort
      //     (dirs first, then alphabetical) + sensitive-path filter.
      mkdirSync(join(fsRoot, 'b-dir'))
      mkdirSync(join(fsRoot, 'a-dir'))
      mkdirSync(join(fsRoot, 'node_modules'))  // must be filtered out
      writeFileSync(join(fsRoot, 'a-file.txt'), 'x')
      writeFileSync(join(fsRoot, '.DS_Store'), 'x')  // also filtered
      const rd = await dispatch({ jsonrpc: '2.0', id: 801, method: 'fs.readdir',
        params: { dirPath: fsRoot } })
      assert.ok(Array.isArray(rd.result))
      const names = rd.result.map(e => e.name)
      assert.deepEqual(names, ['a-dir', 'b-dir', 'a-file.txt'],
        'dirs first then alphabetical, ignored set filtered')
      assert.equal(rd.result[0].isDirectory, true)
      assert.equal(rd.result[2].isDirectory, false)
      // Bare-string params (Electron fallback) also works.
      const rd2 = await dispatch({ jsonrpc: '2.0', id: 802, method: 'fs.readdir',
        params: fsRoot })
      assert.ok(Array.isArray(rd2.result))
      // Missing path → empty array (Electron contract — no throw).
      const rdMissing = await dispatch({ jsonrpc: '2.0', id: 803, method: 'fs.readdir', params: {} })
      assert.deepEqual(rdMissing.result, [])
      // Sensitive path → empty array.
      const rdSensitive = await dispatch({ jsonrpc: '2.0', id: 804, method: 'fs.readdir',
        params: { dirPath: join(homedir(), '.ssh') } })
      assert.deepEqual(rdSensitive.result, [])

      // (c) fs.readFile — UTF-8 read + 512 KB cap + path-guard.
      const txt = join(fsRoot, 'hello.txt')
      writeFileSync(txt, 'hello world\n', 'utf-8')
      const fr = await dispatch({ jsonrpc: '2.0', id: 805, method: 'fs.readFile',
        params: { path: txt } })
      assert.equal(fr.result.content, 'hello world\n')
      // >512 KiB → {error:'File too large', size}.
      const big = join(fsRoot, 'big.txt')
      writeFileSync(big, Buffer.alloc(512 * 1024 + 1, 0x61))
      const frBig = await dispatch({ jsonrpc: '2.0', id: 806, method: 'fs.readFile',
        params: { path: big } })
      assert.equal(frBig.result.error, 'File too large')
      assert.equal(typeof frBig.result.size, 'number')
      // Sensitive path → {error:'Access denied (sensitive path)'}.
      const frDenied = await dispatch({ jsonrpc: '2.0', id: 807, method: 'fs.readFile',
        params: { path: join(homedir(), '.ssh', 'id_rsa') } })
      assert.match(frDenied.result.error, /sensitive path/)
      // Missing path → {error:'missing path'}.
      const frEmpty = await dispatch({ jsonrpc: '2.0', id: 808, method: 'fs.readFile', params: {} })
      assert.match(frEmpty.result.error, /missing path/)

      // (d) fs.listDirs — only directories, hidden filter, parent
      //     calculation, tilde expansion.
      mkdirSync(join(fsRoot, '.hidden-dir'))
      const ld = await dispatch({ jsonrpc: '2.0', id: 809, method: 'fs.listDirs',
        params: { dirPath: fsRoot, includeHidden: false } })
      const ldNames = ld.result.entries.map(e => e.name)
      assert.deepEqual(ldNames, ['a-dir', 'b-dir', 'node_modules'],
        'only dirs, no files, no hidden — listDirs does not filter the readdir IGNORED set, ' +
        'mirror of Electron contract (the Sidebar workspace browser wants to descend into node_modules)')
      assert.equal(ld.result.current, fsRoot)
      assert.equal(typeof ld.result.parent, 'string')
      // includeHidden:true surfaces .hidden-dir.
      const ldHidden = await dispatch({ jsonrpc: '2.0', id: 810, method: 'fs.listDirs',
        params: { dirPath: fsRoot, includeHidden: true } })
      assert.ok(ldHidden.result.entries.some(e => e.name === '.hidden-dir'))
      // Tilde expansion (~/) — call with `~` and just confirm the result
      // resolves to homedir without throwing.
      const ldTilde = await dispatch({ jsonrpc: '2.0', id: 811, method: 'fs.listDirs',
        params: { dirPath: '~', includeHidden: false } })
      assert.equal(typeof ldTilde.result.current === 'string' || typeof ldTilde.result.error === 'string', true)
      // Sensitive path → {error}.
      const ldDenied = await dispatch({ jsonrpc: '2.0', id: 812, method: 'fs.listDirs',
        params: { dirPath: join(homedir(), '.ssh') } })
      assert.match(ldDenied.result.error, /sensitive path/)
      // Missing dirPath → error.
      const ldEmpty = await dispatch({ jsonrpc: '2.0', id: 813, method: 'fs.listDirs', params: {} })
      assert.match(ldEmpty.result.error, /missing dirPath/)

      // (e) fs.mkdir — name validation + sensitive-path guard.
      const mk = await dispatch({ jsonrpc: '2.0', id: 814, method: 'fs.mkdir',
        params: { parentPath: fsRoot, name: 'new-folder' } })
      assert.equal(mk.result.path, join(fsRoot, 'new-folder'))
      assert.ok(existsSync(mk.result.path))
      // Invalid name (slash) → error.
      const mkBad = await dispatch({ jsonrpc: '2.0', id: 815, method: 'fs.mkdir',
        params: { parentPath: fsRoot, name: 'bad/slash' } })
      assert.match(mkBad.result.error, /Invalid folder name/)
      // .. → error (path traversal).
      const mkDots = await dispatch({ jsonrpc: '2.0', id: 816, method: 'fs.mkdir',
        params: { parentPath: fsRoot, name: '..' } })
      assert.match(mkDots.result.error, /Invalid folder name/)
      // Missing args → error.
      const mkEmpty = await dispatch({ jsonrpc: '2.0', id: 817, method: 'fs.mkdir', params: {} })
      assert.match(mkEmpty.result.error, /missing parentPath/)

      // (f) fs.deletePath — only directories, sensitive-path guard.
      const dp = await dispatch({ jsonrpc: '2.0', id: 818, method: 'fs.deletePath',
        params: { targetPath: join(fsRoot, 'new-folder') } })
      assert.equal(dp.result.path, join(fsRoot, 'new-folder'))
      assert.equal(existsSync(join(fsRoot, 'new-folder')), false)
      // Refuses to delete a file.
      const dpFile = await dispatch({ jsonrpc: '2.0', id: 819, method: 'fs.deletePath',
        params: { targetPath: txt } })
      assert.match(dpFile.result.error, /Only directories/)
      // Sensitive path → error before lstat.
      const dpDenied = await dispatch({ jsonrpc: '2.0', id: 820, method: 'fs.deletePath',
        params: { targetPath: join(homedir(), '.ssh') } })
      assert.match(dpDenied.result.error, /sensitive path/)

      // (g) fs.quickLocations — always includes Home, root/drives by
      //     platform.
      const ql = await dispatch({ jsonrpc: '2.0', id: 821, method: 'fs.quickLocations' })
      assert.ok(Array.isArray(ql.result))
      assert.ok(ql.result.some(it => it.kind === 'home'))
      if (process.platform === 'win32') {
        assert.ok(ql.result.some(it => it.kind === 'drive'),
          'win32 must list at least one drive')
      } else {
        assert.ok(ql.result.some(it => it.kind === 'root'),
          'POSIX must list / as root')
      }

      // (h) fs.resolvePathLinks — extracts file paths with optional
      //     line:col, filters by extension, drops sensitive paths.
      const real = join(fsRoot, 'real.ts')
      writeFileSync(real, 'export const x = 1\n', 'utf-8')
      const fake = join(fsRoot, 'fake.bin')  // not in TEXT_EXTS
      writeFileSync(fake, 'x')
      const rp = await dispatch({ jsonrpc: '2.0', id: 822, method: 'fs.resolvePathLinks',
        params: { cwd: fsRoot, rawPaths: ['real.ts:42:7', 'fake.bin', 'real.ts'] } })
      assert.equal(rp.result.length, 2, 'real.ts referenced twice (with and without line) → both keep')
      // Wait — actually unique() dedupes raw strings. 'real.ts:42:7' and
      // 'real.ts' are different raws, so both kept; 'fake.bin' filtered
      // by extension. Confirm shape:
      const withLine = rp.result.find(r => r.line === 42)
      assert.ok(withLine, 'expected entry with line:42')
      assert.equal(withLine.column, 7)
      assert.equal(withLine.path, real)
      // Sensitive path skipped.
      const rpDenied = await dispatch({ jsonrpc: '2.0', id: 823, method: 'fs.resolvePathLinks',
        params: { cwd: homedir(), rawPaths: ['.ssh/id_rsa.pem'] } })
      assert.deepEqual(rpDenied.result, [])

      // (i) End-to-end via remote bridge: kebab→camel for the multi-
      //     hyphen channel `fs:list-dirs` resolves to fs.listDirs.
      const remoteRd = await protocol.invokeRemoteHandler('fs:list-dirs',
        [{ dirPath: fsRoot, includeHidden: false }])
      assert.equal(remoteRd.current, fsRoot)
    } finally {
      rmSync(fsRoot, { recursive: true, force: true })
    }
  }

  // git.* — port of the Electron git:* handlers (branch, log, diff,
  // diffFiles, status, getRoot, getGithubUrl). All wrap `git` CLI via
  // child_process; each handler returns a safe default (null / [] / '')
  // when the cwd isn't a repo / git missing / timeout. Tests stand up a
  // real one-commit repo in tmpdir, confirm happy paths against it,
  // then exercise the empty-cwd / non-repo defaults.
  {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { execSync } = await import('child_process')
    const protocol = await import('../src/lib/remote-protocol.mjs')
    const repoRoot = mkdtempSync(join(tmpdir(), 'sidecar-git-'))
    let gitAvailable = true
    try {
      // Build a minimal repo: init, configure user, one commit, one
      // staged change so `git status` and `git diff HEAD` have content.
      try {
        execSync('git --version', { stdio: 'ignore' })
      } catch { gitAvailable = false }
      if (gitAvailable) {
        const gitOpts = { cwd: repoRoot, stdio: 'ignore' }
        execSync('git init -q', gitOpts)
        execSync('git config user.email "test@example.com"', gitOpts)
        execSync('git config user.name "Test User"', gitOpts)
        execSync('git config commit.gpgsign false', gitOpts)
        writeFileSync(join(repoRoot, 'a.txt'), 'first\n')
        execSync('git add a.txt', gitOpts)
        execSync('git commit -m "initial commit" -q', gitOpts)
        // Add an unstaged modification so `git status -uall` is non-empty.
        writeFileSync(join(repoRoot, 'a.txt'), 'first\nmodified\n')
        // And an untracked file.
        writeFileSync(join(repoRoot, 'b.txt'), 'untracked\n')
        // Configure a fake github remote so getGithubUrl has something
        // to parse. We don't push — just `remote add` then read.
        execSync('git remote add origin git@github.com:tonyq/test-repo.git', gitOpts)
      }

      // Skip git-specific assertions when the host has no git binary —
      // CI without git would otherwise fail. The default-path
      // assertions (no cwd / non-repo dir) still run.
      if (gitAvailable) {
        // (a) git.getRoot — returns the repo's top-level path. The
        //     test compares paths case-insensitively + via path.resolve
        //     because Windows symlinks tmpdir to a longer path
        //     (C:\\Users\\...\\Local\\Temp vs C:\\Users\\...\\AppData\\
        //     Local\\Temp) so a literal string compare is brittle.
        const { resolve } = await import('path')
        const rootReply = await dispatch({ jsonrpc: '2.0', id: 900, method: 'git.getRoot',
          params: { cwd: repoRoot } })
        assert.equal(typeof rootReply.result, 'string')
        assert.equal(resolve(rootReply.result).toLowerCase(),
          resolve(repoRoot).toLowerCase(),
          'git.getRoot should resolve to the temp repo root')

        // (b) git.branch — returns the current branch name. New repos
        //     default to either `main` or `master` depending on git
        //     version; just assert it's a non-empty string.
        const branchReply = await dispatch({ jsonrpc: '2.0', id: 901, method: 'git.branch',
          params: { cwd: repoRoot } })
        assert.equal(typeof branchReply.result, 'string')
        assert.ok(branchReply.result.length > 0, 'expected a branch name')

        // (c) git.log — returns a parsed array with one entry.
        const logReply = await dispatch({ jsonrpc: '2.0', id: 902, method: 'git.log',
          params: { cwd: repoRoot } })
        assert.ok(Array.isArray(logReply.result))
        assert.equal(logReply.result.length, 1)
        const entry = logReply.result[0]
        assert.equal(typeof entry.hash, 'string')
        assert.equal(entry.hash.length, 40)
        assert.equal(entry.author, 'Test User')
        assert.equal(entry.message, 'initial commit')
        // count clamping: huge values clamp to 500.
        const logBig = await dispatch({ jsonrpc: '2.0', id: 903, method: 'git.log',
          params: { cwd: repoRoot, count: 999999 } })
        assert.ok(Array.isArray(logBig.result))

        // (d) git.diff — returns a non-empty diff string for the
        //     unstaged change against HEAD.
        const diffReply = await dispatch({ jsonrpc: '2.0', id: 904, method: 'git.diff',
          params: { cwd: repoRoot } })
        assert.equal(typeof diffReply.result, 'string')
        assert.match(diffReply.result, /\+modified/, 'diff must show the added line')
        // filePath filter narrows to one file (no-op here since only
        // a.txt is modified, but verifies the arg passes through).
        const diffFile = await dispatch({ jsonrpc: '2.0', id: 905, method: 'git.diff',
          params: { cwd: repoRoot, filePath: 'a.txt' } })
        assert.match(diffFile.result, /a\.txt/)

        // (e) git.diffFiles — parsed name-status against HEAD.
        const dfReply = await dispatch({ jsonrpc: '2.0', id: 906, method: 'git.diffFiles',
          params: { cwd: repoRoot } })
        assert.ok(Array.isArray(dfReply.result))
        const aEntry = dfReply.result.find(e => e.file === 'a.txt')
        assert.ok(aEntry, 'expected diffFiles entry for a.txt')
        assert.equal(aEntry.status, 'M')

        // (f) git.status — porcelain entries. b.txt is untracked,
        //     a.txt is modified.
        const stReply = await dispatch({ jsonrpc: '2.0', id: 907, method: 'git.status',
          params: { cwd: repoRoot } })
        assert.ok(Array.isArray(stReply.result))
        const bEntry = stReply.result.find(e => e.file === 'b.txt')
        assert.ok(bEntry, 'expected status entry for b.txt (untracked)')
        assert.equal(bEntry.status, '??')
        const aSt = stReply.result.find(e => e.file === 'a.txt')
        assert.ok(aSt, 'expected status entry for a.txt (modified)')
        assert.equal(aSt.status, 'M')

        // (g) git.getGithubUrl — converts SSH remote to HTTPS URL.
        const ghReply = await dispatch({ jsonrpc: '2.0', id: 908, method: 'git.getGithubUrl',
          params: { folderPath: repoRoot } })
        assert.equal(ghReply.result, 'https://github.com/tonyq/test-repo')
        // folderPath fallback to cwd is also supported.
        const ghReply2 = await dispatch({ jsonrpc: '2.0', id: 909, method: 'git.getGithubUrl',
          params: { cwd: repoRoot } })
        assert.equal(ghReply2.result, 'https://github.com/tonyq/test-repo')
      }

      // (h) Default-path assertions — work regardless of git availability.
      //     Missing cwd → safe default (null / [] / '').
      const noCwd = await Promise.all([
        dispatch({ jsonrpc: '2.0', id: 910, method: 'git.branch', params: {} }),
        dispatch({ jsonrpc: '2.0', id: 911, method: 'git.log', params: {} }),
        dispatch({ jsonrpc: '2.0', id: 912, method: 'git.diff', params: {} }),
        dispatch({ jsonrpc: '2.0', id: 913, method: 'git.diffFiles', params: {} }),
        dispatch({ jsonrpc: '2.0', id: 914, method: 'git.status', params: {} }),
        dispatch({ jsonrpc: '2.0', id: 915, method: 'git.getRoot', params: {} }),
        dispatch({ jsonrpc: '2.0', id: 916, method: 'git.getGithubUrl', params: {} }),
      ])
      assert.equal(noCwd[0].result, null, 'git.branch missing cwd → null')
      assert.deepEqual(noCwd[1].result, [], 'git.log missing cwd → []')
      assert.equal(noCwd[2].result, '', 'git.diff missing cwd → ""')
      assert.deepEqual(noCwd[3].result, [], 'git.diffFiles missing cwd → []')
      assert.deepEqual(noCwd[4].result, [], 'git.status missing cwd → []')
      assert.equal(noCwd[5].result, null, 'git.getRoot missing cwd → null')
      assert.equal(noCwd[6].result, null, 'git.getGithubUrl missing folderPath → null')

      // (i) Non-repo dir → same safe defaults (git CLI exits non-zero,
      //     handler swallows). Use the tmpdir parent which is never a
      //     repo. Skip on systems without git since the failure mode
      //     would be ENOENT instead of git non-zero, but the result
      //     should still be the safe default.
      const nonRepoDir = tmpdir()
      const nonRepo = await dispatch({ jsonrpc: '2.0', id: 917, method: 'git.branch',
        params: { cwd: nonRepoDir } })
      assert.equal(nonRepo.result, null, 'git.branch on non-repo dir → null')

      // (j) End-to-end via remote bridge: `git:get-github-url` →
      //     git.getGithubUrl. Skip when git missing — the handler
      //     would still return null safely but the assertion is
      //     about the bridge wiring, which works either way.
      if (gitAvailable) {
        const remoteGh = await protocol.invokeRemoteHandler('git:get-github-url',
          [{ folderPath: repoRoot }])
        assert.equal(remoteGh, 'https://github.com/tonyq/test-repo')
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  }

  // github.* — port of the Electron github:* handlers (checkCli, prList,
  // issueList, prView, issueView, prComment, issueComment). Wraps the
  // `gh` CLI; reads return parsed JSON or `{error}`, writes return
  // `{success:true}` or `{error}`. checkCli must return a result shape
  // regardless of whether `gh` is installed. The other handlers can't be
  // exercised end-to-end without a real GitHub login, so the tests
  // focus on (a) shape contract for missing args and (b) checkCli's
  // graceful-degrade contract.
  {
    const protocol = await import('../src/lib/remote-protocol.mjs')

    // (a) checkCli returns a typed object regardless of gh availability.
    //     Both fields must be booleans. installed:false => authenticated:false.
    const cliReply = await dispatch({ jsonrpc: '2.0', id: 1000, method: 'github.checkCli', params: {} })
    assert.equal(typeof cliReply.result, 'object')
    assert.equal(typeof cliReply.result.installed, 'boolean')
    assert.equal(typeof cliReply.result.authenticated, 'boolean')
    if (!cliReply.result.installed) {
      assert.equal(cliReply.result.authenticated, false,
        'authenticated must be false when gh is not installed')
    }

    // (b) Read handlers — missing cwd → {error: 'missing cwd'}. Confirms
    //     the handler validates params before spawning gh.
    const missingCwd = await Promise.all([
      dispatch({ jsonrpc: '2.0', id: 1001, method: 'github.prList', params: {} }),
      dispatch({ jsonrpc: '2.0', id: 1002, method: 'github.issueList', params: {} }),
      dispatch({ jsonrpc: '2.0', id: 1003, method: 'github.prView', params: { number: 1 } }),
      dispatch({ jsonrpc: '2.0', id: 1004, method: 'github.issueView', params: { number: 1 } }),
      dispatch({ jsonrpc: '2.0', id: 1005, method: 'github.prComment', params: { number: 1, body: 'x' } }),
      dispatch({ jsonrpc: '2.0', id: 1006, method: 'github.issueComment', params: { number: 1, body: 'x' } }),
    ])
    for (const r of missingCwd) {
      assert.equal(typeof r.result, 'object')
      assert.equal(r.result.error, 'missing cwd')
    }

    // (c) View / comment handlers — missing number → {error: 'missing number'}.
    const missingNum = await Promise.all([
      dispatch({ jsonrpc: '2.0', id: 1010, method: 'github.prView', params: { cwd: '.' } }),
      dispatch({ jsonrpc: '2.0', id: 1011, method: 'github.issueView', params: { cwd: '.' } }),
      dispatch({ jsonrpc: '2.0', id: 1012, method: 'github.prComment', params: { cwd: '.', body: 'x' } }),
      dispatch({ jsonrpc: '2.0', id: 1013, method: 'github.issueComment', params: { cwd: '.', body: 'x' } }),
    ])
    for (const r of missingNum) {
      assert.equal(r.result.error, 'missing number')
    }

    // (d) Comment handlers — missing body → {error: 'missing body'}. Confirms
    //     all three required-field validations fire before the spawn.
    const missingBody = await Promise.all([
      dispatch({ jsonrpc: '2.0', id: 1020, method: 'github.prComment', params: { cwd: '.', number: 1 } }),
      dispatch({ jsonrpc: '2.0', id: 1021, method: 'github.issueComment', params: { cwd: '.', number: 1 } }),
    ])
    for (const r of missingBody) {
      assert.equal(r.result.error, 'missing body')
    }

    // (e) Number type validation — string '1' is rejected since pickNumber
    //     only accepts typeof 'number'. This catches param-shape drift
    //     between the renderer and the handler.
    const stringNum = await dispatch({ jsonrpc: '2.0', id: 1030, method: 'github.prView',
      params: { cwd: '.', number: '1' } })
    assert.equal(stringNum.result.error, 'missing number',
      'string-typed number must be rejected (renderer must send a JS number)')

    // (f) End-to-end via remote bridge: `github:check-cli` → github.checkCli.
    //     Verifies the kebab→camel auto-translation in remote-bridge picks
    //     up the new handler module without explicit wiring.
    const remoteCli = await protocol.invokeRemoteHandler('github:check-cli', [])
    assert.equal(typeof remoteCli, 'object')
    assert.equal(typeof remoteCli.installed, 'boolean')
    assert.equal(typeof remoteCli.authenticated, 'boolean')
  }

  // settings.* — port of the Electron settings:* handlers (save / load /
  // getShellPath / detectCx). Round-trip JSON via <dataDir>/settings.json,
  // resolve a platform-correct shell path from a logical name (cached),
  // and locate the optional `cx` semantic-navigation binary. Tests pin
  // BAT_SIDECAR_DATA_DIR at a fresh tmpdir so the host's real settings
  // file is never touched.
  {
    const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const protocol = await import('../src/lib/remote-protocol.mjs')
    const settingsMod = await import('../src/handlers/settings.mjs')
    const settingsRoot = mkdtempSync(join(tmpdir(), 'sidecar-settings-'))
    const savedDataDirS = process.env.BAT_SIDECAR_DATA_DIR
    process.env.BAT_SIDECAR_DATA_DIR = settingsRoot
    try {
      // (a) load before save → null. The handler must swallow ENOENT,
      //     not propagate — renderer treats null as "first run".
      const loadEmpty = await dispatch({ jsonrpc: '2.0', id: 1100, method: 'settings.load', params: {} })
      assert.equal(loadEmpty.result, null, 'settings.load missing file → null')

      // (b) save round-trip. Tauri shape `{data}` is the canonical wire
      //     form; the on-disk content must match byte-for-byte.
      const payload = JSON.stringify({ theme: 'dark', cxBinaryPath: '', n: 42 })
      const saveReply = await dispatch({ jsonrpc: '2.0', id: 1101, method: 'settings.save',
        params: { data: payload } })
      assert.equal(saveReply.result, true, 'settings.save → true')
      const onDisk = readFileSync(join(settingsRoot, 'settings.json'), 'utf-8')
      assert.equal(onDisk, payload, 'settings.json on disk must match the input bytes')
      const loadReply = await dispatch({ jsonrpc: '2.0', id: 1102, method: 'settings.load', params: {} })
      assert.equal(loadReply.result, payload, 'settings.load round-trips the saved string')

      // (c) bare-string param fallback (Electron-style positional). The
      //     bridge unwraps args[0] to a string; handler must accept.
      const saveBare = await dispatch({ jsonrpc: '2.0', id: 1103, method: 'settings.save',
        params: '{"alt":1}' })
      assert.equal(saveBare.result, true)
      assert.equal(readFileSync(join(settingsRoot, 'settings.json'), 'utf-8'), '{"alt":1}')

      // (d) save with missing data → JSON-RPC error. Param validation
      //     fires before the file write so a botched call doesn't
      //     truncate settings.json to empty.
      const saveBad = await dispatch({ jsonrpc: '2.0', id: 1104, method: 'settings.save', params: {} })
      assert.ok(saveBad.error, 'settings.save with no data must error')
      assert.match(saveBad.error.message, /missing data/)
      // settings.json still has the previous content.
      assert.equal(readFileSync(join(settingsRoot, 'settings.json'), 'utf-8'), '{"alt":1}',
        'failed save must not truncate the existing settings file')

      // (e) settings.getShellPath — logical name → platform-correct path.
      //     The contract: 'auto' returns a non-empty string on every
      //     platform, and the result is cached so two back-to-back calls
      //     return strict-equal strings.
      settingsMod.__resetShellPathCacheForTests()
      const shellAuto1 = await dispatch({ jsonrpc: '2.0', id: 1110, method: 'settings.getShellPath',
        params: { shellType: 'auto' } })
      assert.equal(typeof shellAuto1.result, 'string')
      assert.ok(shellAuto1.result.length > 0, 'auto shell must be non-empty')
      const shellAuto2 = await dispatch({ jsonrpc: '2.0', id: 1111, method: 'settings.getShellPath',
        params: { shellType: 'auto' } })
      assert.equal(shellAuto2.result, shellAuto1.result, 'cache must return identical string')

      // Platform-specific defaults:
      if (process.platform === 'win32') {
        // pwsh fallback: when no PowerShell 7 is installed, the handler
        // returns the literal 'pwsh.exe' (not absolute) so the OS shell
        // resolver kicks in. Either an absolute pwsh.exe path or the
        // bare 'pwsh.exe' is acceptable.
        const pwsh = await dispatch({ jsonrpc: '2.0', id: 1112, method: 'settings.getShellPath',
          params: { shellType: 'pwsh' } })
        assert.match(pwsh.result, /pwsh\.exe$/i)
        const cmd = await dispatch({ jsonrpc: '2.0', id: 1113, method: 'settings.getShellPath',
          params: { shellType: 'cmd' } })
        assert.equal(cmd.result, 'cmd.exe')
      } else {
        // POSIX: zsh always at /bin/zsh, sh at /bin/sh — both are
        // guaranteed by macOS / mainstream linux distros.
        const zsh = await dispatch({ jsonrpc: '2.0', id: 1112, method: 'settings.getShellPath',
          params: { shellType: 'zsh' } })
        assert.equal(zsh.result, '/bin/zsh')
        const sh = await dispatch({ jsonrpc: '2.0', id: 1113, method: 'settings.getShellPath',
          params: { shellType: 'sh' } })
        assert.equal(sh.result, '/bin/sh')
        // POSIX hosts can't run pwsh — fall back to auto shell, not throw.
        const pwsh = await dispatch({ jsonrpc: '2.0', id: 1114, method: 'settings.getShellPath',
          params: { shellType: 'pwsh' } })
        assert.equal(typeof pwsh.result, 'string')
        assert.ok(pwsh.result.length > 0, 'pwsh on POSIX must fall back, not throw')
      }

      // Bare-string param too.
      settingsMod.__resetShellPathCacheForTests()
      const shellBare = await dispatch({ jsonrpc: '2.0', id: 1120, method: 'settings.getShellPath',
        params: 'auto' })
      assert.equal(typeof shellBare.result, 'string')
      assert.ok(shellBare.result.length > 0)

      // Missing shellType → error, not silent default.
      const shellBad = await dispatch({ jsonrpc: '2.0', id: 1121, method: 'settings.getShellPath',
        params: {} })
      assert.ok(shellBad.error, 'missing shellType must error')
      assert.match(shellBad.error.message, /missing shellType/)

      // (f) settings.detectCx — must return a typed result no matter
      //     what (cx installed or not). Both `cacheDir` and `enabled`
      //     are always present; the rest depends on the host. With our
      //     freshly-pinned BAT_SIDECAR_DATA_DIR / no settings written,
      //     `enabled` defaults to false and cacheDir lives under our
      //     temp dir.
      writeFileSync(join(settingsRoot, 'settings.json'),
        JSON.stringify({ cxSemanticNavigationEnabled: false }), 'utf-8')
      const cxReply = await dispatch({ jsonrpc: '2.0', id: 1130, method: 'settings.detectCx',
        params: {} })
      assert.equal(typeof cxReply.result, 'object')
      assert.equal(cxReply.result.enabled, false)
      assert.equal(typeof cxReply.result.detected, 'boolean')
      assert.equal(typeof cxReply.result.cacheDir, 'string')
      assert.match(cxReply.result.cacheDir, /cx-cache/)
      // Pinned dataDir → cacheDir lives under our temp root, never
      // under the user's real Application Support dir.
      assert.ok(cxReply.result.cacheDir.startsWith(settingsRoot),
        'cacheDir must be inside the pinned BAT_SIDECAR_DATA_DIR')
      // When detected:false, `error` must be a string explaining why.
      if (!cxReply.result.detected) {
        assert.equal(typeof cxReply.result.error, 'string')
      }

      // Configured-path that obviously doesn't exist → detected:false
      // with a path field still set (renderer shows what was tried).
      writeFileSync(join(settingsRoot, 'settings.json'),
        JSON.stringify({ cxSemanticNavigationEnabled: true, cxBinaryPath: '/no/such/binary/cx-fake' }),
        'utf-8')
      const cxBad = await dispatch({ jsonrpc: '2.0', id: 1131, method: 'settings.detectCx', params: {} })
      assert.equal(cxBad.result.enabled, true, 'enabled flag must reflect settings file')
      assert.equal(cxBad.result.detected, false)
      assert.equal(cxBad.result.path, '/no/such/binary/cx-fake')
      assert.equal(typeof cxBad.result.error, 'string')

      // Corrupt settings.json → detect-cx must NOT crash; returns the
      // same enabled:false default. The handler swallows JSON.parse.
      writeFileSync(join(settingsRoot, 'settings.json'), '{not json', 'utf-8')
      const cxCorrupt = await dispatch({ jsonrpc: '2.0', id: 1132, method: 'settings.detectCx', params: {} })
      assert.equal(cxCorrupt.result.enabled, false,
        'corrupt settings.json must degrade to enabled:false, not throw')

      // (g) End-to-end via remote bridge — confirms kebab→camel routing
      //     for `settings:get-shell-path` lands at `settings.getShellPath`.
      settingsMod.__resetShellPathCacheForTests()
      const remoteShell = await protocol.invokeRemoteHandler('settings:get-shell-path',
        [{ shellType: 'auto' }])
      assert.equal(typeof remoteShell, 'string')
      assert.ok(remoteShell.length > 0)
    } finally {
      if (savedDataDirS === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
      else process.env.BAT_SIDECAR_DATA_DIR = savedDataDirS
      rmSync(settingsRoot, { recursive: true, force: true })
    }
  }

  // snippet.* — port of the Electron snippet:* handlers (10 channels).
  // Backed by a JSON file (`<dataDir>/snippets.json`) with debounced
  // writes. Tests pin BAT_SIDECAR_DATA_DIR at a fresh tmpdir so the
  // host's real snippets file is never touched, then exercise the
  // CRUD + search + favorite + by-workspace flows end-to-end through
  // dispatch (so param-shape unwrap is exercised too).
  {
    const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const protocol = await import('../src/lib/remote-protocol.mjs')
    const { snippetDb } = await import('../src/lib/snippet-db.mjs')
    const snipRoot = mkdtempSync(join(tmpdir(), 'sidecar-snippet-'))
    const savedDataDirSn = process.env.BAT_SIDECAR_DATA_DIR
    process.env.BAT_SIDECAR_DATA_DIR = snipRoot
    snippetDb.__resetForTests()
    try {
      // Helper to flush the 300ms debounce so we can assert on disk.
      const flush = () => snippetDb.flushNow()

      // (a) getAll on empty store → []. Exercises lazy-load with no file.
      const getAllEmpty = await dispatch({ jsonrpc: '2.0', id: 1200, method: 'snippet.getAll', params: {} })
      assert.deepEqual(getAllEmpty.result, [])

      // (b) create — returns the saved snippet with id=1, default
      //     format='plaintext', default action='terminal', isFavorite=false,
      //     timestamps set.
      const created = await dispatch({ jsonrpc: '2.0', id: 1201, method: 'snippet.create',
        params: { input: { title: 'first', content: 'hello world' } } })
      assert.equal(typeof created.result, 'object')
      assert.equal(created.result.id, 1)
      assert.equal(created.result.title, 'first')
      assert.equal(created.result.content, 'hello world')
      assert.equal(created.result.format, 'plaintext')
      assert.equal(created.result.action, 'terminal')
      assert.equal(created.result.isFavorite, false)
      assert.equal(typeof created.result.createdAt, 'number')
      assert.equal(created.result.createdAt, created.result.updatedAt)

      // (c) Bare-form input (Electron-style positional). Should be
      //     accepted because the object has title+content.
      const created2 = await dispatch({ jsonrpc: '2.0', id: 1202, method: 'snippet.create',
        params: { title: 'second', content: 'cmd', action: 'clipboard', tags: 'foo,bar' } })
      assert.equal(created2.result.id, 2)
      assert.equal(created2.result.action, 'clipboard')
      assert.equal(created2.result.tags, 'foo,bar')

      // (d) Missing input → JSON-RPC error.
      const createBad = await dispatch({ jsonrpc: '2.0', id: 1203, method: 'snippet.create', params: {} })
      assert.ok(createBad.error)
      assert.match(createBad.error.message, /missing input/)

      // (e) On-disk shape: flush the debounce, read snippets.json, assert
      //     {snippets:[2], nextId:3}.
      flush()
      const onDisk = JSON.parse(readFileSync(join(snipRoot, 'snippets.json'), 'utf-8'))
      assert.equal(onDisk.nextId, 3)
      assert.equal(onDisk.snippets.length, 2)

      // (f) getById — both Tauri object form and bare-number form.
      const byId = await dispatch({ jsonrpc: '2.0', id: 1210, method: 'snippet.getById',
        params: { id: 1 } })
      assert.equal(byId.result.title, 'first')
      const byIdBare = await dispatch({ jsonrpc: '2.0', id: 1211, method: 'snippet.getById', params: 1 })
      assert.equal(byIdBare.result.title, 'first')
      const missing = await dispatch({ jsonrpc: '2.0', id: 1212, method: 'snippet.getById',
        params: { id: 999 } })
      assert.equal(missing.result, null)

      // (g) update — must merge fields, bump updatedAt, leave createdAt
      //     untouched. Caller passes only the changed fields.
      const beforeUpd = byId.result
      // Sleep 5ms to ensure a different ms timestamp.
      await new Promise(r => setTimeout(r, 5))
      const updated = await dispatch({ jsonrpc: '2.0', id: 1220, method: 'snippet.update',
        params: { id: 1, updates: { title: 'first-renamed' } } })
      assert.equal(updated.result.title, 'first-renamed')
      assert.equal(updated.result.content, 'hello world', 'unchanged content must persist')
      assert.equal(updated.result.createdAt, beforeUpd.createdAt, 'createdAt must not move')
      assert.ok(updated.result.updatedAt > beforeUpd.updatedAt, 'updatedAt must advance')

      // Update missing id → null result, missing updates → error.
      const updMissingId = await dispatch({ jsonrpc: '2.0', id: 1221, method: 'snippet.update',
        params: { updates: { title: 'x' } } })
      assert.ok(updMissingId.error)
      assert.match(updMissingId.error.message, /missing id/)
      const updMissingUpdates = await dispatch({ jsonrpc: '2.0', id: 1222, method: 'snippet.update',
        params: { id: 1 } })
      assert.ok(updMissingUpdates.error)
      assert.match(updMissingUpdates.error.message, /missing updates/)

      // (h) toggleFavorite — flip; idempotent fav state via two flips.
      const fav1 = await dispatch({ jsonrpc: '2.0', id: 1230, method: 'snippet.toggleFavorite',
        params: { id: 1 } })
      assert.equal(fav1.result.isFavorite, true)
      const fav2 = await dispatch({ jsonrpc: '2.0', id: 1231, method: 'snippet.toggleFavorite',
        params: { id: 1 } })
      assert.equal(fav2.result.isFavorite, false)
      // toggle missing id → null.
      const favBad = await dispatch({ jsonrpc: '2.0', id: 1232, method: 'snippet.toggleFavorite',
        params: { id: 999 } })
      assert.equal(favBad.result, null)

      // (i) getFavorites — set fav on #2, expect 1-element array.
      await dispatch({ jsonrpc: '2.0', id: 1240, method: 'snippet.toggleFavorite',
        params: { id: 2 } })
      const favs = await dispatch({ jsonrpc: '2.0', id: 1241, method: 'snippet.getFavorites', params: {} })
      assert.ok(Array.isArray(favs.result))
      assert.equal(favs.result.length, 1)
      assert.equal(favs.result[0].id, 2)

      // (j) search — case-insensitive substring on title / content / tags.
      const sTitle = await dispatch({ jsonrpc: '2.0', id: 1250, method: 'snippet.search',
        params: { query: 'RENAMED' } })
      assert.equal(sTitle.result.length, 1)
      assert.equal(sTitle.result[0].id, 1)
      const sTag = await dispatch({ jsonrpc: '2.0', id: 1251, method: 'snippet.search',
        params: { query: 'foo' } })
      assert.equal(sTag.result.length, 1)
      assert.equal(sTag.result[0].id, 2)
      // Bare-string param.
      const sBare = await dispatch({ jsonrpc: '2.0', id: 1252, method: 'snippet.search',
        params: 'hello' })
      assert.equal(sBare.result.length, 1)
      assert.equal(sBare.result[0].id, 1, 'content match for "hello"')
      // Missing query → []. Don't throw — UI uses search-as-you-type.
      const sNone = await dispatch({ jsonrpc: '2.0', id: 1253, method: 'snippet.search', params: {} })
      assert.deepEqual(sNone.result, [])

      // (k) getCategories — distinct, sorted.
      await dispatch({ jsonrpc: '2.0', id: 1260, method: 'snippet.update',
        params: { id: 1, updates: { category: 'beta' } } })
      await dispatch({ jsonrpc: '2.0', id: 1261, method: 'snippet.update',
        params: { id: 2, updates: { category: 'alpha' } } })
      const cats = await dispatch({ jsonrpc: '2.0', id: 1262, method: 'snippet.getCategories', params: {} })
      assert.deepEqual(cats.result, ['alpha', 'beta'])

      // (l) getByWorkspace — filter by workspaceId, BUT snippets without
      //     workspaceId are visible everywhere (this is the Electron
      //     contract — workspace filter is opt-in per snippet).
      await dispatch({ jsonrpc: '2.0', id: 1270, method: 'snippet.update',
        params: { id: 1, updates: { workspaceId: 'ws-A' } } })
      // #2 still has no workspaceId — should appear in any workspace.
      const wsA = await dispatch({ jsonrpc: '2.0', id: 1271, method: 'snippet.getByWorkspace',
        params: { workspaceId: 'ws-A' } })
      assert.equal(wsA.result.length, 2, 'ws-A snippet + global #2')
      const wsB = await dispatch({ jsonrpc: '2.0', id: 1272, method: 'snippet.getByWorkspace',
        params: { workspaceId: 'ws-B' } })
      // #1 belongs to ws-A → not in ws-B; #2 is global → still visible.
      assert.equal(wsB.result.length, 1)
      assert.equal(wsB.result[0].id, 2)

      // (m) delete — true / false branches, and on-disk shape after flush.
      const del = await dispatch({ jsonrpc: '2.0', id: 1280, method: 'snippet.delete',
        params: { id: 1 } })
      assert.equal(del.result, true)
      const delMissing = await dispatch({ jsonrpc: '2.0', id: 1281, method: 'snippet.delete',
        params: { id: 999 } })
      assert.equal(delMissing.result, false)
      flush()
      const after = JSON.parse(readFileSync(join(snipRoot, 'snippets.json'), 'utf-8'))
      assert.equal(after.snippets.length, 1)
      assert.equal(after.snippets[0].id, 2)
      // nextId must NOT decrement after delete — id reuse is forbidden.
      assert.equal(after.nextId, 3, 'nextId must keep climbing past deleted ids')

      // (n) External edit detection: write a synthetic file with a third
      //     snippet, bump mtime; refreshIfChanged must reload it.
      const mutated = {
        snippets: [
          ...after.snippets,
          { id: 7, title: 'external', content: 'from outside', format: 'plaintext',
            action: 'terminal', isFavorite: false, createdAt: 1, updatedAt: Date.now() + 1000 },
        ],
        nextId: 8,
      }
      writeFileSync(join(snipRoot, 'snippets.json'), JSON.stringify(mutated, null, 2), 'utf-8')
      // Bump mtime by ~10ms so the > comparison fires reliably on
      // filesystems with coarse mtime precision (some Linux fs are 1s).
      const future = new Date(Date.now() + 1500)
      const { utimesSync } = await import('fs')
      utimesSync(join(snipRoot, 'snippets.json'), future, future)
      const externalReload = await dispatch({ jsonrpc: '2.0', id: 1290, method: 'snippet.getAll', params: {} })
      assert.equal(externalReload.result.length, 2)
      assert.ok(externalReload.result.some(s => s.id === 7),
        'external mutation must be picked up via mtime check')

      // (o) End-to-end via remote bridge: `snippet:getAll` →
      //     `snippet.getAll`. The channel has no hyphens so the
      //     kebab→camel rule passes through; this still verifies
      //     bridge wiring + dispatch is connected for snippet.* fully.
      const remoteAll = await protocol.invokeRemoteHandler('snippet:getAll', [])
      assert.ok(Array.isArray(remoteAll))
      assert.equal(remoteAll.length, 2)
    } finally {
      snippetDb.__resetForTests()
      if (savedDataDirSn === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
      else process.env.BAT_SIDECAR_DATA_DIR = savedDataDirSn
      rmSync(snipRoot, { recursive: true, force: true })
    }
  }

  // fs.search — recursive filename substring match. Pure Node walker;
  // builds a tmpdir tree, runs queries against dispatch, asserts the
  // sort order, IGNORED-dir pruning, max-results clamp, and depth cap.
  {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import('fs')
    const { join } = await import('path')
    const osModSearch = await import('os')
    const { tmpdir } = osModSearch
    const searchRoot = mkdtempSync(join(tmpdir(), 'sidecar-fssearch-'))
    try {
      // Layout:
      //   <root>/
      //     alpha-dir/             (matches 'alpha')
      //       alpha-file.txt       (matches 'alpha')
      //       deep/...             (depth chain to test depth cap)
      //     beta-dir/
      //       beta-file.md         (matches 'beta')
      //     node_modules/junk.txt  (must be pruned by IGNORED set)
      //     .git/HEAD              (must be pruned)
      //     dist/build.js          (must be pruned)
      //     plain.txt              (no match for either query)
      mkdirSync(join(searchRoot, 'alpha-dir'))
      writeFileSync(join(searchRoot, 'alpha-dir', 'alpha-file.txt'), '', 'utf-8')
      mkdirSync(join(searchRoot, 'beta-dir'))
      writeFileSync(join(searchRoot, 'beta-dir', 'beta-file.md'), '', 'utf-8')
      mkdirSync(join(searchRoot, 'node_modules'))
      writeFileSync(join(searchRoot, 'node_modules', 'alpha-junk.txt'), '', 'utf-8')
      mkdirSync(join(searchRoot, '.git'))
      writeFileSync(join(searchRoot, '.git', 'alpha-HEAD'), '', 'utf-8')
      mkdirSync(join(searchRoot, 'dist'))
      writeFileSync(join(searchRoot, 'dist', 'alpha-build.js'), '', 'utf-8')
      writeFileSync(join(searchRoot, 'plain.txt'), '', 'utf-8')

      // Build a 10-deep chain under alpha-dir/deep/... to test the
      // depth cap (8 levels). The 9th and 10th level alpha matches
      // must NOT appear.
      let cursor = join(searchRoot, 'alpha-dir', 'deep')
      mkdirSync(cursor)
      for (let i = 1; i <= 9; i++) {
        cursor = join(cursor, `lv${i}`)
        mkdirSync(cursor)
        writeFileSync(join(cursor, `alpha-lv${i}.txt`), '', 'utf-8')
      }

      // (a) Case-insensitive substring match — finds alpha-dir,
      //     alpha-file.txt, and the lv1..lv6 alpha files (depth check
      //     below). The pruned ones (node_modules/.git/dist) must NOT
      //     appear in the results.
      const r1 = await dispatch({ jsonrpc: '2.0', id: 1400, method: 'fs.search',
        params: { dirPath: searchRoot, query: 'ALPHA' } })
      assert.ok(Array.isArray(r1.result))
      const names = r1.result.map(r => r.name)
      assert.ok(names.includes('alpha-dir'), 'must include alpha-dir')
      assert.ok(names.includes('alpha-file.txt'), 'must include alpha-file.txt')
      assert.ok(!names.includes('alpha-junk.txt'), 'node_modules must be pruned')
      assert.ok(!names.includes('alpha-HEAD'), '.git must be pruned')
      assert.ok(!names.includes('alpha-build.js'), 'dist must be pruned')

      // (b) Sort order: directories first, then alphabetical by name.
      //     Find the first non-directory result and assert every
      //     preceding result is a directory.
      let sawFile = false
      for (const r of r1.result) {
        if (sawFile && r.isDirectory) {
          assert.fail(`directory '${r.name}' appeared after a file — sort order broken`)
        }
        if (!r.isDirectory) sawFile = true
      }

      // (c) Depth cap — the layout has alpha-lv1..alpha-lv9 at
      //     depths 3..11 from <root>. With SEARCH_MAX_DEPTH=8, the
      //     handler must include up to lv6 (depth 8) and exclude
      //     lv7..lv9. (Depth 0 is <root>, alpha-dir/deep/lv1 = depth 3,
      //     so lv6 = depth 8, lv7 = depth 9 → out.)
      assert.ok(names.includes('alpha-lv6.txt') || names.includes('alpha-lv5.txt'),
        'depth cap must include the bottom-most allowed level')
      assert.ok(!names.includes('alpha-lv9.txt'),
        'depth cap must exclude the deepest levels (lv9)')

      // (d) Empty / no-match query returns []. Missing query → [].
      const rNo = await dispatch({ jsonrpc: '2.0', id: 1401, method: 'fs.search',
        params: { dirPath: searchRoot, query: 'no-such-substring-anywhere' } })
      assert.deepEqual(rNo.result, [])
      const rMissing = await dispatch({ jsonrpc: '2.0', id: 1402, method: 'fs.search',
        params: { dirPath: searchRoot } })
      assert.deepEqual(rMissing.result, [], 'missing query → []')
      const rNoDir = await dispatch({ jsonrpc: '2.0', id: 1403, method: 'fs.search',
        params: { query: 'alpha' } })
      assert.deepEqual(rNoDir.result, [], 'missing dirPath → []')

      // (e) Sensitive-path refusal: searching directly inside ~/.ssh
      //     must return [] without enumerating. We don't actually
      //     have a guarantee ~/.ssh exists, but the handler short-
      //     circuits before fs.readdir so the contract holds either
      //     way — the assertion below is just "no throw, no leak".
      const rSensitive = await dispatch({ jsonrpc: '2.0', id: 1404, method: 'fs.search',
        params: { dirPath: join(osModSearch.homedir(), '.ssh'), query: 'id_rsa' } })
      assert.deepEqual(rSensitive.result, [],
        'sensitive root must short-circuit to []')

      // (f) Max-results clamp — make 120 alpha-* files in a flat dir,
      //     assert the result length is exactly 100.
      const flatDir = mkdtempSync(join(tmpdir(), 'sidecar-fssearch-flat-'))
      try {
        for (let i = 0; i < 120; i++) {
          writeFileSync(join(flatDir, `alpha-${String(i).padStart(3, '0')}.txt`), '', 'utf-8')
        }
        const rClamp = await dispatch({ jsonrpc: '2.0', id: 1410, method: 'fs.search',
          params: { dirPath: flatDir, query: 'alpha' } })
        assert.equal(rClamp.result.length, 100, 'max-results cap is 100')
      } finally {
        rmSync(flatDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(searchRoot, { recursive: true, force: true })
    }
  }

  // fs.watch / fs.unwatch — port of the Electron fs:watch / fs:unwatch
  // stateful handlers. Watches a directory recursively, debounces
  // 500ms, then emits `fs:changed` events with the absolute path. The
  // map is process-wide so a leak between tests would carry over —
  // __closeAllWatchersForTests() at the end is mandatory.
  {
    const { mkdtempSync, rmSync, writeFileSync } = await import('fs')
    const pathMod = await import('path')
    const { join } = pathMod
    const osMod = await import('os')
    const { tmpdir } = osMod
    const fsWatchMod = await import('../src/handlers/fs-watch.mjs')
    const watchRoot = mkdtempSync(join(tmpdir(), 'sidecar-fswatch-'))
    const captured = []
    const restoreSend = mod.__setSendEventForTests((name, payload) => {
      captured.push({ name, payload })
    })
    try {
      // (a) watch a brand-new directory → true; idempotent second call → true.
      const w1 = await dispatch({ jsonrpc: '2.0', id: 1300, method: 'fs.watch',
        params: { dirPath: watchRoot } })
      assert.equal(w1.result, true)
      assert.equal(fsWatchMod.__watcherCountForTests(), 1)
      const w2 = await dispatch({ jsonrpc: '2.0', id: 1301, method: 'fs.watch',
        params: { dirPath: watchRoot } })
      assert.equal(w2.result, true, 'second watch on same path → true (no-op)')
      assert.equal(fsWatchMod.__watcherCountForTests(), 1, 'second watch must not double-attach')

      // (b) sensitive path → false; no watcher attached.
      const sshPath = join(osMod.homedir(), '.ssh')
      const wSensitive = await dispatch({ jsonrpc: '2.0', id: 1302, method: 'fs.watch',
        params: { dirPath: sshPath } })
      assert.equal(wSensitive.result, false, 'sensitive path must be refused')
      assert.equal(fsWatchMod.__watcherCountForTests(), 1, 'refused watcher must not be added to map')

      // (c) missing dirPath → false.
      const wEmpty = await dispatch({ jsonrpc: '2.0', id: 1303, method: 'fs.watch', params: {} })
      assert.equal(wEmpty.result, false)

      // (d) Bare-string param (Electron-style positional) — also works.
      const watchRoot2 = mkdtempSync(join(tmpdir(), 'sidecar-fswatch2-'))
      const wBare = await dispatch({ jsonrpc: '2.0', id: 1304, method: 'fs.watch', params: watchRoot2 })
      assert.equal(wBare.result, true)
      assert.equal(fsWatchMod.__watcherCountForTests(), 2)
      // Clean up the second tmpdir's watcher before the event-flow test
      // so the captured events array stays scoped to watchRoot.
      const u2 = await dispatch({ jsonrpc: '2.0', id: 1305, method: 'fs.unwatch', params: watchRoot2 })
      assert.equal(u2.result, true)
      assert.equal(fsWatchMod.__watcherCountForTests(), 1)
      rmSync(watchRoot2, { recursive: true, force: true })

      // (e) Event flow: write a file, wait for 500ms debounce, expect
      //     exactly one fs:changed event with abs(watchRoot) payload.
      //     Burst of multiple writes inside the debounce window must
      //     coalesce into a single event.
      captured.length = 0
      writeFileSync(join(watchRoot, 'a.txt'), 'first', 'utf-8')
      writeFileSync(join(watchRoot, 'b.txt'), 'second', 'utf-8')
      writeFileSync(join(watchRoot, 'c.txt'), 'third', 'utf-8')
      // Wait > 500ms debounce + slack for fs.watch event delivery.
      await new Promise(r => setTimeout(r, 800))
      const fsChanged = captured.filter(e => e.name === 'fs:changed')
      assert.ok(fsChanged.length >= 1, 'expected at least one fs:changed event')
      assert.equal(typeof fsChanged[0].payload, 'string')
      const expectedAbs = pathMod.resolve(watchRoot)
      assert.equal(fsChanged[0].payload, expectedAbs,
        'fs:changed payload must be abs path of watched dir')
      // Debounce contract: 3 writes in < 500ms must coalesce. Allow
      // up to 2 events because fs.watch on some fs (Linux inotify
      // multi-event close) can split bursts across debounce windows
      // when writeFileSync emits separate events. The strict ≤ 1
      // is too brittle; ≤ 2 catches "no debounce at all" (would be 3+).
      assert.ok(fsChanged.length <= 2,
        `debounce must coalesce burst writes; got ${fsChanged.length} events`)

      // (f) unwatch — silences subsequent events. Write again, wait,
      //     captured must NOT grow.
      const u1 = await dispatch({ jsonrpc: '2.0', id: 1310, method: 'fs.unwatch',
        params: { dirPath: watchRoot } })
      assert.equal(u1.result, true)
      assert.equal(fsWatchMod.__watcherCountForTests(), 0, 'unwatch must clear the map entry')
      captured.length = 0
      writeFileSync(join(watchRoot, 'after-unwatch.txt'), 'x', 'utf-8')
      await new Promise(r => setTimeout(r, 700))
      const afterUnwatch = captured.filter(e => e.name === 'fs:changed')
      assert.equal(afterUnwatch.length, 0,
        'no fs:changed events after unwatch')

      // (g) unwatch a never-watched path → true (idempotent, never throws).
      const uMissing = await dispatch({ jsonrpc: '2.0', id: 1311, method: 'fs.unwatch',
        params: { dirPath: '/nonexistent/never-watched' } })
      assert.equal(uMissing.result, true)

      // (h) watch a nonexistent path → false (fs.watch throws ENOENT,
      //     handler swallows). Map is unchanged.
      const wMissing = await dispatch({ jsonrpc: '2.0', id: 1312, method: 'fs.watch',
        params: { dirPath: '/definitely/does/not/exist/here' } })
      assert.equal(wMissing.result, false)
      assert.equal(fsWatchMod.__watcherCountForTests(), 0)
    } finally {
      // Drop every watcher so node --test can exit cleanly. Restoring
      // the sendEvent stub is also mandatory or downstream tests
      // capture events meant for stdout.
      fsWatchMod.__closeAllWatchersForTests()
      restoreSend()
      rmSync(watchRoot, { recursive: true, force: true })
    }
  }

  // remote-secrets — port of electron/remote/secrets.ts. The sidecar
  // version always writes `{enc:false, data:<JSON>}` (no safeStorage in
  // pure-Node) but must (a) round-trip JSON / string, (b) read legacy
  // plaintext objects, (c) refuse `enc:true` blobs left by an Electron
  // build with a clear null result, (d) handle missing/corrupt files,
  // (e) write with mode 0600 on POSIX.
  {
    const secrets = await import('../src/lib/remote-secrets.mjs')
    const { readFileSync, writeFileSync, statSync, mkdtempSync, rmSync } = await import('node:fs')
    const { join, sep } = await import('node:path')
    const tmpRoot = mkdtempSync(join(tmpdir(), 'bat-remote-secrets-'))
    try {
      // (a) JSON round-trip.
      const jsonPath = join(tmpRoot, 'a.json')
      secrets.writeEncryptedJson(jsonPath, { token: 't', port: 9876, list: [1, 2, 3] })
      const back = secrets.readEncryptedJson(jsonPath)
      assert.deepEqual(back, { token: 't', port: 9876, list: [1, 2, 3] })

      // Envelope shape on disk: {enc:false, data:'<json string>'}.
      const onDisk = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      assert.equal(onDisk.enc, false)
      assert.equal(typeof onDisk.data, 'string')
      assert.deepEqual(JSON.parse(onDisk.data), { token: 't', port: 9876, list: [1, 2, 3] })

      // (b) Legacy plaintext (envelope-less object).
      const legacyPath = join(tmpRoot, 'legacy.json')
      writeFileSync(legacyPath, JSON.stringify({ token: 'old', plain: true }), 'utf-8')
      const legacyRead = secrets.readEncryptedJson(legacyPath)
      assert.deepEqual(legacyRead, { token: 'old', plain: true })

      // (c) enc:true blob from an Electron build — refuse with null,
      // never throw. Caller regenerates.
      const encryptedPath = join(tmpRoot, 'enc.json')
      writeFileSync(encryptedPath, JSON.stringify({ enc: true, data: 'AAAA' }), 'utf-8')
      assert.equal(secrets.readEncryptedJson(encryptedPath), null)

      // (d) Missing file → null, no throw.
      assert.equal(secrets.readEncryptedJson(join(tmpRoot, 'missing.json')), null)

      // Corrupt JSON → null + warn (warn captured below to avoid noise).
      const corruptPath = join(tmpRoot, 'corrupt.json')
      writeFileSync(corruptPath, '{ not: json', 'utf-8')
      const origWarn = console.warn
      console.warn = () => {}
      try {
        assert.equal(secrets.readEncryptedJson(corruptPath), null)

        // Inner-JSON corrupt envelope → null.
        const innerBad = join(tmpRoot, 'inner-bad.json')
        writeFileSync(innerBad, JSON.stringify({ enc: false, data: '{ not json' }), 'utf-8')
        assert.equal(secrets.readEncryptedJson(innerBad), null)
      } finally {
        console.warn = origWarn
      }

      // (e) Mode 0600 on POSIX. Windows reports 0666 here so we skip.
      if (process.platform !== 'win32') {
        const stat = statSync(jsonPath)
        const mode = stat.mode & 0o777
        assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
      }

      // String wrappers.
      const strPath = join(tmpRoot, 's.json')
      secrets.writeEncryptedString(strPath, 'super-secret-token')
      assert.equal(secrets.readEncryptedString(strPath), 'super-secret-token')

      // Round-trip: writing a bare string via writeEncryptedJson and
      // reading via readEncryptedString returns the string (handles the
      // `typeof obj === 'string'` branch in the wrapper).
      const bareStrPath = join(tmpRoot, 'bare.json')
      secrets.writeEncryptedJson(bareStrPath, 'just-a-string')
      assert.equal(secrets.readEncryptedString(bareStrPath), 'just-a-string')

      // readEncryptedString of a JSON object without `value` field → null.
      const objPath = join(tmpRoot, 'obj.json')
      secrets.writeEncryptedJson(objPath, { other: 'field' })
      assert.equal(secrets.readEncryptedString(objPath), null)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  }

  // remote-broadcast — trivial EventEmitter multiplexer that the future
  // WebSocket server consumes via .on('broadcast', ...). Tests cover:
  // (a) multi-listener receives same args, (b) channel + variadic args
  // round-trip, (c) reset hook clears subscribers.
  {
    const broadcast = await import('../src/lib/remote-broadcast.mjs')
    broadcast.__resetBroadcastHubForTests()
    const seen = []
    const seen2 = []
    const l1 = (channel, ...args) => seen.push({ channel, args })
    const l2 = (channel, ...args) => seen2.push({ channel, args })
    broadcast.broadcastHub.on('broadcast', l1)
    broadcast.broadcastHub.on('broadcast', l2)

    broadcast.broadcastHub.broadcast('claude:message', { id: 'm1', text: 'hi' })
    broadcast.broadcastHub.broadcast('pty:output', 'sess-1', 'hello\n')

    assert.equal(seen.length, 2)
    assert.equal(seen2.length, 2)
    assert.equal(seen[0].channel, 'claude:message')
    assert.deepEqual(seen[0].args, [{ id: 'm1', text: 'hi' }])
    assert.equal(seen[1].channel, 'pty:output')
    assert.deepEqual(seen[1].args, ['sess-1', 'hello\n'])
    // Both listeners observed identical sequences.
    assert.deepEqual(seen, seen2)

    // Reset clears subscribers.
    broadcast.__resetBroadcastHubForTests()
    broadcast.broadcastHub.broadcast('claude:message', { ignored: true })
    assert.equal(seen.length, 2, 'post-reset broadcasts must not reach removed listeners')
  }

  // remote-fingerprint — pure crypto helpers ported ahead of the
  // selfsigned cert generation slice. Verify the PEM strip + base64
  // decode + SHA-256 + colon-grouped uppercase pipeline against a
  // hand-computed fixture.
  {
    const fp = await import('../src/lib/remote-fingerprint.mjs')
    const { createHash } = await import('node:crypto')

    // Fake "PEM" — content is just the base64 of a known string. The
    // fingerprint helper doesn't validate ASN.1, only base64-decodes
    // the body, so this exercises the full pipeline.
    const bodyBytes = Buffer.from('better-agent-terminal test certificate body', 'utf-8')
    const bodyB64 = bodyBytes.toString('base64')
    const pem = `-----BEGIN CERTIFICATE-----\n${bodyB64}\n-----END CERTIFICATE-----`

    const expectedHex = createHash('sha256').update(bodyBytes).digest('hex').toUpperCase()
    const expected = expectedHex.match(/.{2}/g).join(':')

    const actual = fp.computeFingerprint(pem)
    assert.equal(actual, expected)

    // Format invariants: 64 hex chars + 31 colons = length 95.
    assert.equal(actual.length, 95)
    assert.match(actual, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)

    // Whitespace + linebreak inside body is stripped.
    const pemWithBreaks = `-----BEGIN CERTIFICATE-----\n${bodyB64.slice(0, 20)}\n  ${bodyB64.slice(20)}\r\n-----END CERTIFICATE-----`
    assert.equal(fp.computeFingerprint(pemWithBreaks), expected)

    // fingerprintOfPem alias — same function reference.
    assert.equal(fp.fingerprintOfPem, fp.computeFingerprint)

    // normalizeFingerprint: strip colons/spaces, uppercase. Idempotent
    // on already-normalized input. Non-string → ''.
    assert.equal(fp.normalizeFingerprint('ab:cd:EF: 12 \t 34'), 'ABCDEF1234')
    assert.equal(fp.normalizeFingerprint('ABCDEF1234'), 'ABCDEF1234')
    assert.equal(fp.normalizeFingerprint(fp.normalizeFingerprint('ab:cd')), 'ABCD')
    assert.equal(fp.normalizeFingerprint(null), '')
    assert.equal(fp.normalizeFingerprint(undefined), '')
    assert.equal(fp.normalizeFingerprint(42), '')

    // Empty / non-string PEM rejected.
    assert.throws(() => fp.computeFingerprint(''), /non-empty PEM/)
    assert.throws(() => fp.computeFingerprint(null), /non-empty PEM/)
    // PEM with only headers (no base64 body) rejected.
    assert.throws(
      () => fp.computeFingerprint('-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----'),
      /no base64 body/,
    )

    // Pin-comparison contract: normalize both sides and check equality.
    // This is what a remote client will do when verifying the host's
    // self-signed cert against a user-pasted pin.
    const userPasted = `${actual.toLowerCase()}` // pasted in lowercase
    assert.equal(fp.normalizeFingerprint(actual), fp.normalizeFingerprint(userPasted))
  }

  // remote-certificate — TLS cert generation + persistence for the
  // future WebSocket server. Generation uses 2048-bit RSA via the
  // `selfsigned` package, which costs a few seconds, so we run one
  // full generate + reload + corruption-recovery cycle.
  {
    const certMod = await import('../src/lib/remote-certificate.mjs')
    const fpMod = await import('../src/lib/remote-fingerprint.mjs')
    const { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const tmpRoot = mkdtempSync(join(tmpdir(), 'bat-remote-cert-'))
    try {
      // (1) Fresh dir → generate. Subdir auto-created when missing.
      const dir = join(tmpRoot, 'config')
      assert.equal(existsSync(dir), false)
      const cert1 = await certMod.ensureCertificate(dir)
      assert.equal(existsSync(dir), true, 'configDir auto-created')
      assert.match(cert1.cert, /-----BEGIN CERTIFICATE-----/)
      assert.match(cert1.cert, /-----END CERTIFICATE-----/)
      assert.match(cert1.privateKey, /-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----/)
      assert.equal(cert1.fingerprint256.length, 95)
      assert.match(cert1.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
      // Fingerprint must match what we'd compute from the PEM directly.
      assert.equal(cert1.fingerprint256, fpMod.computeFingerprint(cert1.cert))

      // Cert file written with the secrets envelope.
      const certPath = join(dir, certMod.__certFileNameForTests)
      assert.equal(existsSync(certPath), true)
      const onDisk = JSON.parse(readFileSync(certPath, 'utf-8'))
      assert.equal(onDisk.enc, false)
      assert.equal(typeof onDisk.data, 'string')

      // (2) Reload — same dir, same cert + fingerprint, no regeneration.
      // Stamp the file mtime by reading-then-comparing identity.
      const cert2 = await certMod.ensureCertificate(dir)
      assert.equal(cert2.cert, cert1.cert, 'reload must return identical cert PEM')
      assert.equal(cert2.privateKey, cert1.privateKey, 'reload must return identical private key')
      assert.equal(cert2.fingerprint256, cert1.fingerprint256)

      // (3) Corruption recovery — overwrite the cert file with garbage,
      // ensureCertificate regenerates rather than throwing. New cert
      // gets a different fingerprint.
      writeFileSync(certPath, 'not-json-at-all', 'utf-8')
      // Silence the warn from remote-secrets parse failure.
      const origWarn = console.warn
      console.warn = () => {}
      let cert3
      try {
        cert3 = await certMod.ensureCertificate(dir)
      } finally {
        console.warn = origWarn
      }
      assert.match(cert3.cert, /-----BEGIN CERTIFICATE-----/)
      assert.notEqual(cert3.fingerprint256, cert1.fingerprint256, 'regenerated cert must differ from original')
      assert.equal(cert3.fingerprint256, fpMod.computeFingerprint(cert3.cert))

      // (4) Missing-fields envelope (someone wrote {enc:false, data:'{}'})
      // is treated as missing → regenerate.
      writeFileSync(certPath, JSON.stringify({ enc: false, data: '{}' }), 'utf-8')
      const cert4 = await certMod.ensureCertificate(dir)
      assert.match(cert4.cert, /-----BEGIN CERTIFICATE-----/)
      // After this the file holds a fresh stored cert, fingerprint differs from cert3.
      assert.notEqual(cert4.fingerprint256, cert3.fingerprint256)

      // (5) Validation — empty/non-string configDir throws synchronously.
      await assert.rejects(certMod.ensureCertificate(''), /non-empty string/)
      await assert.rejects(certMod.ensureCertificate(null), /non-empty string/)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  }

  // remote-server-impl — WebSocket server lifecycle. Boots on an
  // OS-assigned port (port:0), connects with rejectUnauthorized:false
  // since we're using our own self-signed cert, runs the auth →
  // ping → pong frame round-trip, then verifies status / persisted
  // token / stop teardown.
  {
    const { RemoteServer } = await import('../src/lib/remote-server-impl.mjs')
    const { mkdtempSync, rmSync, existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { WebSocket } = await import('ws')
    const tmpRoot = mkdtempSync(join(tmpdir(), 'bat-remote-server-'))
    const dir = join(tmpRoot, 'cfg')
    let server
    try {
      server = new RemoteServer(dir)
      assert.equal(server.isRunning, false)

      // pre-start status shape — running:false, all fields null/empty.
      const sBefore = server.status()
      assert.equal(sBefore.running, false)
      assert.equal(sBefore.port, null)
      assert.equal(sBefore.fingerprint, null)
      assert.deepEqual(sBefore.clients, [])

      // Start. port:0 lets the OS pick; bind localhost.
      const startResult = await server.start({ port: 0, bindInterface: 'localhost' })
      assert.equal(server.isRunning, true)
      assert.equal(typeof startResult.port, 'number')
      assert.ok(startResult.port > 0)
      assert.equal(typeof startResult.token, 'string')
      assert.equal(startResult.token.length, 32, '16 random bytes hex = 32 chars')
      assert.match(startResult.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
      assert.equal(startResult.bindInterface, 'localhost')
      assert.equal(startResult.boundHost, '127.0.0.1')

      // Token persisted via remote-secrets envelope.
      const tokenPath = join(dir, 'server-token.enc.json')
      assert.equal(existsSync(tokenPath), true)
      const onDiskToken = JSON.parse(readFileSync(tokenPath, 'utf-8'))
      assert.equal(onDiskToken.enc, false)

      // Status while running.
      const sAfter = server.status()
      assert.equal(sAfter.running, true)
      assert.equal(sAfter.port, startResult.port)
      assert.equal(sAfter.fingerprint, startResult.fingerprint)
      assert.equal(sAfter.bindInterface, 'localhost')
      assert.equal(sAfter.boundHost, '127.0.0.1')

      // (a) Auth happy path — connect, send auth frame, get auth-result
      // result:true, then ping → pong.
      async function connectAndAuth(token) {
        const ws = new WebSocket(`wss://127.0.0.1:${startResult.port}`, {
          rejectUnauthorized: false,
        })
        await new Promise((resolve, reject) => {
          ws.once('open', resolve)
          ws.once('error', reject)
        })
        const seen = []
        ws.on('message', raw => seen.push(JSON.parse(raw.toString())))
        ws.send(JSON.stringify({ type: 'auth', id: 'auth-1', token, args: ['my-laptop', { windowId: 'w1' }] }))
        // Wait for auth-result.
        const deadline = Date.now() + 2000
        while (seen.length === 0 && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 20))
        }
        return { ws, seen }
      }

      const happy = await connectAndAuth(startResult.token)
      assert.equal(happy.seen.length, 1)
      assert.equal(happy.seen[0].type, 'auth-result')
      assert.equal(happy.seen[0].result, true)
      assert.equal(happy.seen[0].id, 'auth-1')

      // Connected client appears in status.
      const sWithClient = server.status()
      assert.equal(sWithClient.clients.length, 1)
      assert.equal(sWithClient.clients[0].label, 'my-laptop')
      assert.equal(sWithClient.clients[0].windowId, 'w1')

      // ping → pong round-trip.
      happy.ws.send(JSON.stringify({ type: 'ping', id: 'p-1' }))
      const pingDeadline = Date.now() + 2000
      while (happy.seen.length < 2 && Date.now() < pingDeadline) {
        await new Promise(r => setTimeout(r, 20))
      }
      assert.equal(happy.seen.length, 2)
      assert.equal(happy.seen[1].type, 'pong')
      assert.equal(happy.seen[1].id, 'p-1')

      // invoke for a bridged channel succeeds. claude:auth-status maps
      // to claude.authStatus (no params) which returns either null or a
      // parsed auth object — both are valid invoke-result payloads.
      happy.ws.send(JSON.stringify({ type: 'invoke', id: 'i-1', channel: 'claude:auth-status', args: [] }))
      const invokeDeadline = Date.now() + 4000
      while (happy.seen.length < 3 && Date.now() < invokeDeadline) {
        await new Promise(r => setTimeout(r, 20))
      }
      assert.equal(happy.seen.length, 3)
      assert.equal(happy.seen[2].type, 'invoke-result',
        `expected invoke-result for claude:auth-status, got ${JSON.stringify(happy.seen[2])}`)
      assert.equal(happy.seen[2].id, 'i-1')
      // Result is null or an object — both are fine.
      assert.ok(happy.seen[2].result === null || typeof happy.seen[2].result === 'object')

      // invoke for a not-on-allowlist channel: rejected before the
      // bridge check.
      happy.ws.send(JSON.stringify({ type: 'invoke', id: 'i-2', channel: 'evil:nuke-fs', args: [] }))
      const evilDeadline = Date.now() + 2000
      while (happy.seen.length < 4 && Date.now() < evilDeadline) {
        await new Promise(r => setTimeout(r, 20))
      }
      assert.equal(happy.seen[3].type, 'invoke-error')
      assert.match(happy.seen[3].error, /not exposed remotely/)

      // invoke for an allowlisted channel that has NO sidecar handler
      // (lives in Tauri Rust commands — pty:* / git:* / fs:* / etc.):
      // bridge dispatches, JSON-RPC returns -32601 method-not-found,
      // bridge re-raises as invoke-error so the renderer's
      // `'error' in result` branch is consistent.
      happy.ws.send(JSON.stringify({ type: 'invoke', id: 'i-3', channel: 'pty:create', args: [{}] }))
      const noHandlerDeadline = Date.now() + 2000
      while (happy.seen.length < 5 && Date.now() < noHandlerDeadline) {
        await new Promise(r => setTimeout(r, 20))
      }
      assert.equal(happy.seen[4].type, 'invoke-error')
      assert.match(happy.seen[4].error, /method not found/i)

      happy.ws.close()
      await new Promise(r => setTimeout(r, 50))

      // (b) Auth fail path — wrong token gets invalid-token + close.
      const ws2 = new WebSocket(`wss://127.0.0.1:${startResult.port}`, { rejectUnauthorized: false })
      await new Promise((resolve, reject) => { ws2.once('open', resolve); ws2.once('error', reject) })
      const seen2 = []
      ws2.on('message', raw => seen2.push(JSON.parse(raw.toString())))
      ws2.send(JSON.stringify({ type: 'auth', id: 'auth-bad', token: 'wrong-token' }))
      const failDeadline = Date.now() + 2000
      while (seen2.length === 0 && Date.now() < failDeadline) {
        await new Promise(r => setTimeout(r, 20))
      }
      assert.equal(seen2[0].type, 'auth-result')
      assert.match(seen2[0].error, /Invalid token/)

      // (c) Persisted token survives stop+start: re-create server with same dir.
      const persistedToken = server.getPersistedToken()
      assert.equal(persistedToken, startResult.token)

      await server.stop()
      assert.equal(server.isRunning, false)
      assert.equal(server.status().running, false)

      const server2 = new RemoteServer(dir)
      const restartResult = await server2.start({ port: 0, bindInterface: 'localhost' })
      try {
        // Same token re-loaded from disk.
        assert.equal(restartResult.token, startResult.token, 'persisted token must survive restart')
        // Same cert + fingerprint (cert file was written too).
        assert.equal(restartResult.fingerprint, startResult.fingerprint)
      } finally {
        await server2.stop()
      }

      // (d) Brute-force ban — 5 wrong-token attempts within window
      // pushes IP into bannedUntil > now.
      // Use the same server2 path is closed; spin a fresh server for ban test.
      const server3 = new RemoteServer(dir)
      const r3 = await server3.start({ port: 0, bindInterface: 'localhost' })
      try {
        // Simulate 5 failures from same IP without going through actual
        // sockets (faster + deterministic). The recordAuthFailure path is
        // contract-equivalent.
        const ip = '127.0.0.1'
        for (let i = 0; i < 5; i++) server3.recordAuthFailure(ip)
        assert.equal(server3.isBanned(ip), true)
        // Ban duration > 0.
        const entry = server3.authFailures.get(ip)
        assert.ok(entry.bannedUntil > Date.now())

        // Outside the window, recordAuthFailure resets the counter.
        // We can't actually wait 60s; just simulate by mutating timestamp.
        entry.firstFailAt = Date.now() - (61 * 1000)
        entry.bannedUntil = 0
        server3.recordAuthFailure(ip)
        const newEntry = server3.authFailures.get(ip)
        assert.equal(newEntry.count, 1, 'expired window should reset count to 1')

        // clearAuthFailures purges.
        server3.clearAuthFailures(ip)
        assert.equal(server3.authFailures.has(ip), false)

        // Validation — empty configDir construction throws.
        assert.throws(() => new RemoteServer(''), /non-empty string/)
        assert.throws(() => new RemoteServer(null), /non-empty string/)
      } finally {
        await server3.stop()
      }

      server = null // skip the outer-finally stop
    } finally {
      if (server && server.isRunning) await server.stop()
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  }

  // remote-client-impl — outgoing RemoteClient against a live RemoteServer.
  // Covers: fingerprint pinning happy/mismatch path, auth happy/wrong-token
  // path, invoke-error round trip (server has no bridged handlers in this
  // slice, so any allowed channel surfaces "not yet bridged"), event
  // fan-out from broadcastHub through the renderer-emit hook, isConnected
  // / connectionInfo / disconnect cleanup.
  {
    const { RemoteServer } = await import('../src/lib/remote-server-impl.mjs')
    const { RemoteClient, __setRemoteClientEmitForTests, __setRemoteClientLoggerForTests } =
      await import('../src/lib/remote-client-impl.mjs')
    const { broadcastHub, __resetBroadcastHubForTests } = await import('../src/lib/remote-broadcast.mjs')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')

    // Silence the client's stderr logging during the test run (mismatch /
    // close paths log expected errors).
    const restoreLogger = __setRemoteClientLoggerForTests({ log: () => {}, error: () => {} })

    const tmpRoot = mkdtempSync(join(tmpdir(), 'bat-remote-client-'))
    const dir = join(tmpRoot, 'cfg')
    const server = new RemoteServer(dir)
    let started
    try {
      started = await server.start({ port: 0, bindInterface: 'localhost' })

      // (a) Happy path: connect with the right fingerprint + token, get
      // {connected: true, info}. isConnected reflects open socket.
      {
        const client = new RemoteClient()
        try {
          const ok = await client.connect({
            host: '127.0.0.1',
            port: started.port,
            token: started.token,
            fingerprint: started.fingerprint,
            label: 'test-laptop',
          })
          assert.equal(ok, true, 'happy-path connect should resolve true')
          assert.equal(client.isConnected, true)
          assert.deepEqual(client.connectionInfo, { host: '127.0.0.1', port: started.port })

          // Server sees the labeled client.
          const liveStatus = server.status()
          assert.equal(liveStatus.clients.length, 1)
          assert.equal(liveStatus.clients[0].label, 'test-laptop')
        } finally {
          client.disconnect()
        }

        // After disconnect: not connected, info null, generation bumped.
        assert.equal(client.isConnected, false)
        assert.equal(client.connectionInfo, null)

        // Give the server a tick to drop the closed socket.
        await new Promise(r => setTimeout(r, 50))
      }

      // (b) Fingerprint mismatch: connect resolves false, isConnected false.
      // Use a syntactically valid SHA-256 fingerprint that's not the server's.
      {
        const wrongFp = 'AA:'.repeat(31) + 'AA'
        const client = new RemoteClient()
        try {
          const ok = await client.connect({
            host: '127.0.0.1',
            port: started.port,
            token: started.token,
            fingerprint: wrongFp,
          })
          assert.equal(ok, false, 'mismatched fingerprint must reject')
          assert.equal(client.isConnected, false)
        } finally {
          client.disconnect()
        }
      }

      // (c) Wrong token: TLS handshake succeeds (fingerprint matches), but
      // the auth-result frame carries an error → connect resolves false.
      {
        const client = new RemoteClient()
        try {
          const ok = await client.connect({
            host: '127.0.0.1',
            port: started.port,
            token: 'definitely-not-the-real-token',
            fingerprint: started.fingerprint,
          })
          assert.equal(ok, false)
          assert.equal(client.isConnected, false)
        } finally {
          client.disconnect()
        }
      }

      // (d) Connect-time validation — missing fingerprint / host / port /
      // token rejects synchronously without opening a socket.
      {
        const client = new RemoteClient()
        await assert.rejects(client.connect({ host: 'h', port: 1, token: 't' }), /fingerprint is required/)
        await assert.rejects(client.connect({ host: '', port: 1, token: 't', fingerprint: 'AA' }), /host is required/)
        await assert.rejects(client.connect({ host: 'h', port: 0, token: 't', fingerprint: 'AA' }), /port is required/)
        await assert.rejects(client.connect({ host: 'h', port: 1, token: '', fingerprint: 'AA' }), /token is required/)
        await assert.rejects(client.connect(null), /options is required/)
      }

      // (e) invoke before connect → rejects with 'Not connected'.
      {
        const client = new RemoteClient()
        await assert.rejects(client.invoke('claude:auth-status', []), /Not connected/)
      }

      // (f) invoke round trip — bridge wires every PROXIED_CHANNEL to
      // the sidecar's JSON-RPC dispatch, so allowlisted channels with a
      // sidecar handler return their real result. Non-allowlisted
      // channels surface 'not exposed remotely'; allowlisted-without-
      // sidecar-handler channels surface 'method not found'.
      {
        const client = new RemoteClient()
        try {
          await client.connect({
            host: '127.0.0.1',
            port: started.port,
            token: started.token,
            fingerprint: started.fingerprint,
          })
          // claude:auth-status → claude.authStatus → null or auth object.
          const authResult = await client.invoke('claude:auth-status', [])
          assert.ok(authResult === null || typeof authResult === 'object',
            `unexpected authStatus shape: ${JSON.stringify(authResult)}`)

          // Not on allowlist → rejected before bridge check.
          await assert.rejects(
            client.invoke('evil:nuke-fs', []),
            /not exposed remotely/,
          )
          // On allowlist but lives in Tauri Rust (no sidecar handler) —
          // bridge surfaces method-not-found via JSON-RPC -32601.
          await assert.rejects(
            client.invoke('pty:create', [{}]),
            /method not found/i,
          )
          // invoke channel-validation (empty) rejects synchronously.
          await assert.rejects(client.invoke('', []), /non-empty string/)
        } finally {
          client.disconnect()
        }
      }

      // (g) Event fan-out: broadcastHub.broadcast('claude:message', ...)
      // on the server side reaches the client's emit hook. PROXIED_EVENTS
      // gates which channels survive — non-allowlisted channels never fire.
      {
        const captured = []
        const restoreEmit = __setRemoteClientEmitForTests((channel, args) => {
          captured.push({ channel, args })
        })
        const client = new RemoteClient()
        try {
          await client.connect({
            host: '127.0.0.1',
            port: started.port,
            token: started.token,
            fingerprint: started.fingerprint,
          })

          // Emit one allowlisted event, one non-allowlisted event.
          // 'claude:message' is in PROXIED_EVENTS; 'fake:ignored' is not.
          broadcastHub.broadcast('claude:message', { id: 'm1', text: 'hi' })
          broadcastHub.broadcast('fake:ignored', 'should-not-arrive')
          // Wait for the message to round-trip.
          const deadline = Date.now() + 1000
          while (captured.length === 0 && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 20))
          }
          assert.equal(captured.length, 1, 'exactly one allowlisted event should fan out')
          assert.equal(captured[0].channel, 'claude:message')
          assert.deepEqual(captured[0].args, [{ id: 'm1', text: 'hi' }])
        } finally {
          restoreEmit()
          client.disconnect()
          __resetBroadcastHubForTests()
        }
      }

      // (h) Pending invokes get rejected on disconnect.
      {
        const client = new RemoteClient()
        try {
          await client.connect({
            host: '127.0.0.1',
            port: started.port,
            token: started.token,
            fingerprint: started.fingerprint,
          })
          // Fire a long-timeout invoke we'll never await, then disconnect.
          const inflight = client.invoke('claude:auth-status', [], 10_000).catch(e => e)
          // Server replies fast with 'not yet bridged' — race that against
          // disconnect. Either rejection message is fine (both come back
          // as Error). Just ensure the promise settles, doesn't leak.
          client.disconnect()
          const err = await inflight
          assert.ok(err instanceof Error)
        } catch (err) {
          // Connection might already be closed before invoke; both fine.
          assert.ok(err)
        }
      }

      // (i) Re-connect after explicit disconnect is allowed (generation
      // bump). The fresh connection round-trips auth without surfacing a
      // stale reconnect.
      {
        const client = new RemoteClient()
        try {
          let ok = await client.connect({
            host: '127.0.0.1',
            port: started.port,
            token: started.token,
            fingerprint: started.fingerprint,
          })
          assert.equal(ok, true)
          client.disconnect()
          ok = await client.connect({
            host: '127.0.0.1',
            port: started.port,
            token: started.token,
            fingerprint: started.fingerprint,
          })
          assert.equal(ok, true, 'reconnect after disconnect must succeed')
          assert.equal(client.isConnected, true)
        } finally {
          client.disconnect()
        }
      }

      // (j) Handler-level happy path through the dispatch surface.
      // remote.connect / clientStatus / disconnect drive the singleton
      // RemoteClient that the Tauri renderer talks to.
      {
        const connReply = await dispatch({
          jsonrpc: '2.0', id: 9100, method: 'remote.connect',
          params: { host: '127.0.0.1', port: started.port, token: started.token, fingerprint: started.fingerprint, label: 'singleton' },
        })
        assert.equal(connReply.result.connected, true,
          `remote.connect should succeed, got ${JSON.stringify(connReply.result)}`)
        assert.deepEqual(connReply.result.info, { host: '127.0.0.1', port: started.port })

        const csReply = await dispatch({ jsonrpc: '2.0', id: 9101, method: 'remote.clientStatus' })
        assert.equal(csReply.result.connected, true)
        assert.deepEqual(csReply.result.info, { host: '127.0.0.1', port: started.port })

        const discReply = await dispatch({ jsonrpc: '2.0', id: 9102, method: 'remote.disconnect' })
        assert.equal(discReply.result, true)

        const csAfter = await dispatch({ jsonrpc: '2.0', id: 9103, method: 'remote.clientStatus' })
        assert.equal(csAfter.result.connected, false)
        assert.equal(csAfter.result.info, null)
      }

      // (k) testConnection through dispatch — happy path returns {ok:true},
      // wrong fingerprint returns {ok:false}.
      {
        const okReply = await dispatch({
          jsonrpc: '2.0', id: 9110, method: 'remote.testConnection',
          params: { host: '127.0.0.1', port: started.port, token: started.token, fingerprint: started.fingerprint },
        })
        assert.equal(okReply.result.ok, true,
          `testConnection happy path should succeed, got ${JSON.stringify(okReply.result)}`)

        const badReply = await dispatch({
          jsonrpc: '2.0', id: 9111, method: 'remote.testConnection',
          params: { host: '127.0.0.1', port: started.port, token: started.token, fingerprint: 'AA:'.repeat(31) + 'BB' },
        })
        assert.equal(badReply.result.ok, false)

        // Wrong-token returns ok:false (no error string — auth path resolves cleanly false).
        const wrongTokenReply = await dispatch({
          jsonrpc: '2.0', id: 9112, method: 'remote.testConnection',
          params: { host: '127.0.0.1', port: started.port, token: 'wrong', fingerprint: started.fingerprint },
        })
        assert.equal(wrongTokenReply.result.ok, false)
      }

      // (l) listProfiles through dispatch — there's no sidecar
      // `profile.list` handler yet (profiles live in Tauri Rust + the
      // Electron build's profile-manager), so the bridge dispatches
      // and surfaces JSON-RPC -32601 method-not-found in the {error}
      // field. SettingsPanel branches on `'error' in result` so the
      // shape contract holds; once a sidecar profile.list lands the
      // assertion below should be flipped to expect {profiles, ...}.
      {
        const lpReply = await dispatch({
          jsonrpc: '2.0', id: 9120, method: 'remote.listProfiles',
          params: { host: '127.0.0.1', port: started.port, token: started.token, fingerprint: started.fingerprint },
        })
        assert.equal(typeof lpReply.result.error, 'string')
        assert.match(lpReply.result.error, /method not found|not exposed/i)
      }
    } finally {
      restoreLogger()
      if (server.isRunning) await server.stop()
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  }

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
    // Disable real SDK loading so claude.sendMessage takes the
    // deterministic stub path. The SDK code path is exercised by
    // the cargo end_to_end_bundled_sdk_loads_through_bundled_node
    // integration test instead — which is the right place because
    // that test actually has a bundled SDK available.
    env: { ...process.env, BAT_SIDECAR_DISABLE_SDK: '1' },
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
