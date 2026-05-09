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
  const { __setSdkOverrideForTests } = mod
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
  const meta2 = await dispatch({ jsonrpc: '2.0', id: 208, method: 'claude.getSessionMeta', params: { sessionId: 'state-1' } })
  assert.equal(meta2.result.model, 'claude-haiku-4-5-20251001')
  assert.equal(meta2.result.effort, 'high')
  assert.equal(meta2.result.autoCompactWindow, 100000)
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
  const reset = await dispatch({ jsonrpc: '2.0', id: 209, method: 'claude.resetSession', params: { sessionId: 'state-1' } })
  assert.equal(reset.result, true)
  const after = await dispatch({ jsonrpc: '2.0', id: 210, method: 'claude.getSessionState', params: { sessionId: 'state-1' } })
  assert.equal(after.result, null)
  // Reset of unknown session id returns false (not an error).
  const reset2 = await dispatch({ jsonrpc: '2.0', id: 211, method: 'claude.resetSession', params: { sessionId: 'nope' } })
  assert.equal(reset2.result, false)

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

    // Concurrent send must be rejected (the streaming flag clears in
    // the finally block, so we trigger this by pre-flagging the session).
    const s = mod.sessions.get('send-1')
    s.streaming = true
    const conflict = await dispatch({ jsonrpc: '2.0', id: 223, method: 'claude.sendMessage',
      params: { sessionId: 'send-1', prompt: 'parallel' } })
    assert.equal(conflict.result.ok, false)
    assert.match(conflict.result.error || '', /streaming/)
    s.streaming = false
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreSendEvent()
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
    assert.equal(restingSession.abortController, null, 'rest must drop abortController')
    assert.equal(ac.signal.aborted, true, 'rest must abort the in-flight signal')
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

  // Image attachment must turn the prompt into an async generator that
  // yields a single SDKUserMessage with image+text content blocks.
  const imageCaptured = []
  const restoreImageSend = mod.__setSendEventForTests(() => {})
  const fakeSdkImage = {
    query({ prompt, options }) {
      imageCaptured.push({ prompt, options })
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'img-sdk', cwd: '/i', model: 'claude-sonnet-4-6', permissionMode: 'default' },
        { type: 'result', subtype: 'success', session_id: 'img-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
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
    assert.equal(imageCaptured.length, 1)
    const promptArg = imageCaptured[0].prompt
    assert.equal(typeof promptArg, 'object', 'expected async generator for prompt with images')
    assert.equal(typeof promptArg[Symbol.asyncIterator], 'function', 'expected async iterable prompt')
    // Drain the generator and check the user message shape.
    const collected = []
    for await (const m of promptArg) collected.push(m)
    assert.equal(collected.length, 1)
    const userMsg = collected[0]
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

  // SDK-backed read APIs: getSupportedCommands / getSupportedAgents /
  // getAccountInfo. Same dual-mode contract as getSupportedModels —
  // returns SDK data when available, empty/null fallback when not. Lock
  // both branches with override hooks so dev-machine SDK-presence
  // doesn't mask a regression in the release fallback path.
  __setSdkOverrideForTests({
    query() {
      return {
        async supportedCommands() {
          return [
            { name: 'help', description: 'Show help', argumentHint: '' },
            { name: 'clear', description: 'Clear context' },
          ]
        },
        async supportedAgents() {
          return [{ name: 'general-purpose', description: 'General agent' }]
        },
        async accountInfo() {
          return { email: 'fake@example.com', subscriptionType: 'pro' }
        },
      }
    },
  })
  try {
    const cmdsReply = await dispatch({ jsonrpc: '2.0', id: 270, method: 'claude.getSupportedCommands' })
    assert.equal(cmdsReply.result.length, 2)
    assert.equal(cmdsReply.result[0].name, 'help')
    const agentsReply = await dispatch({ jsonrpc: '2.0', id: 271, method: 'claude.getSupportedAgents' })
    assert.equal(agentsReply.result.length, 1)
    assert.equal(agentsReply.result[0].name, 'general-purpose')
    const accountReply = await dispatch({ jsonrpc: '2.0', id: 272, method: 'claude.getAccountInfo' })
    assert.equal(accountReply.result.email, 'fake@example.com')
    assert.equal(accountReply.result.subscriptionType, 'pro')
  } finally {
    __setSdkOverrideForTests(undefined)
  }
  // SDK-unavailable fallback contract: empty array / null shape so the
  // renderer's pickers degrade gracefully instead of throwing.
  __setSdkOverrideForTests(null)
  try {
    const cmdsFallback = await dispatch({ jsonrpc: '2.0', id: 273, method: 'claude.getSupportedCommands' })
    assert.deepEqual(cmdsFallback.result, [])
    const agentsFallback = await dispatch({ jsonrpc: '2.0', id: 274, method: 'claude.getSupportedAgents' })
    assert.deepEqual(agentsFallback.result, [])
    const accountFallback = await dispatch({ jsonrpc: '2.0', id: 275, method: 'claude.getAccountInfo' })
    assert.equal(accountFallback.result, null)
  } finally {
    __setSdkOverrideForTests(undefined)
  }
  // SDK throws → handler must catch + return fallback (don't crash the
  // renderer panel). Verifies the catch arms.
  __setSdkOverrideForTests({
    query() {
      return {
        async supportedCommands() { throw new Error('boom') },
        async supportedAgents() { throw new Error('boom') },
        async accountInfo() { throw new Error('boom') },
      }
    },
  })
  try {
    const r1 = await dispatch({ jsonrpc: '2.0', id: 276, method: 'claude.getSupportedCommands' })
    assert.deepEqual(r1.result, [])
    const r2 = await dispatch({ jsonrpc: '2.0', id: 277, method: 'claude.getSupportedAgents' })
    assert.deepEqual(r2.result, [])
    const r3 = await dispatch({ jsonrpc: '2.0', id: 278, method: 'claude.getAccountInfo' })
    assert.equal(r3.result, null)
  } finally {
    __setSdkOverrideForTests(undefined)
  }

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
