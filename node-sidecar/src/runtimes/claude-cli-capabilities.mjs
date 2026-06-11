// Capability probe + schema-drift guard for the Claude CLI (subscription) path.
//
// Cheap, no-token probes: `claude --version` and `claude --help` (flag
// detection), plus a transcript-schema probe over an existing session file so
// we can detect format drift and fall back cleanly. Mirrors the pattern in
// claude-channel-capabilities.mjs but is self-contained.

import { spawn } from 'node:child_process'
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs'

import { resolveProjectsDir } from './claude-cli-transcript.mjs'
import { parseTranscriptLine, FRAME_KINDS } from './claude-cli-frames.mjs'

const MIN_VERSION = [2, 1, 80]

const PROBED_FLAGS = Object.freeze({
  supportsModel: '--model',
  supportsPermissionMode: '--permission-mode',
  supportsEffort: '--effort',
  supportsSessionId: '--session-id',
  supportsResume: '--resume',
  supportsForkSession: '--fork-session',
  supportsSettings: '--settings',
  supportsAppendSystemPrompt: '--append-system-prompt',
})

export function parseClaudeVersion(raw) {
  const m = String(raw || '').match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], text: `${m[1]}.${m[2]}.${m[3]}` }
}

export function compareVersion(v, target) {
  if (!v) return -1
  const p = [v.major, v.minor, v.patch]
  for (let i = 0; i < target.length; i++) {
    if (p[i] > target[i]) return 1
    if (p[i] < target[i]) return -1
  }
  return 0
}

function runCli(cliPath, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    if (!cliPath) return resolve({ ok: false, stdout: '', stderr: 'missing cliPath', code: null })
    let child
    try {
      child = spawn(cliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cliPath),
      })
    } catch (err) {
      return resolve({ ok: false, stdout: '', stderr: String(err?.message || err), code: null })
    }
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', d => { stdout += d })
    child.stderr?.on('data', d => { stderr += d })
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: err.message, code: null }) })
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr, code }) })
  })
}

function newestTranscript(projectsDir) {
  const out = []
  const stack = [projectsDir]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { out.push({ full, mtime: statSync(full).mtimeMs }) } catch {}
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out[0]?.full || null
}

// Confirm the transcript still produces the frame kinds we depend on. Reads
// only structure (counts), never returns content.
export function probeTranscriptSchema({ projectsDir = resolveProjectsDir() } = {}) {
  const file = newestTranscript(projectsDir)
  if (!file) return { supportsTranscript: false, reason: 'no transcript found', sampleFile: null, kinds: {} }
  let raw
  try { raw = readFileSync(file, 'utf8') } catch (err) {
    return { supportsTranscript: false, reason: String(err?.message || err), sampleFile: file, kinds: {} }
  }
  const kinds = {}
  let frames = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    for (const fr of parseTranscriptLine(line)) {
      frames++
      kinds[fr.kind] = (kinds[fr.kind] || 0) + 1
    }
  }
  // We require at least the assistant + usage shape to be intact; tool/thinking
  // depend on session content so are not required for "supported".
  const ok = frames > 0 && (kinds[FRAME_KINDS.ASSISTANT] > 0 || kinds[FRAME_KINDS.USER] > 0)
  return { supportsTranscript: ok, reason: ok ? null : 'no classifiable frames', sampleFile: file, kinds }
}

export async function probeClaudeCliCapabilities({ cliPath, projectsDir } = {}) {
  const base = {
    supported: false, versionOk: false, cliPath: cliPath || null, cliVersion: null,
    supportsModel: false, supportsPermissionMode: false, supportsEffort: false,
    supportsSessionId: false, supportsResume: false, supportsForkSession: false,
    supportsSettings: false, supportsAppendSystemPrompt: false,
    projectsDir: projectsDir || resolveProjectsDir(), supportsTranscript: false, schemaKinds: {}, error: null,
  }
  if (!cliPath) return { ...base, error: 'Claude CLI path is not available.' }
  try { accessSync(cliPath, constants.X_OK) } catch {
    return { ...base, error: `Claude CLI is not executable: ${cliPath}` }
  }

  const versionRes = await runCli(cliPath, ['--version'])
  const version = parseClaudeVersion(versionRes.stdout || versionRes.stderr)
  const helpRes = await runCli(cliPath, ['--help'])
  const help = `${helpRes.stdout}\n${helpRes.stderr}`

  const flags = {}
  for (const [key, flag] of Object.entries(PROBED_FLAGS)) flags[key] = help.includes(flag)

  const versionOk = compareVersion(version, MIN_VERSION) >= 0
  const schema = probeTranscriptSchema({ projectsDir: base.projectsDir })

  return {
    ...base,
    ...flags,
    cliVersion: version?.text || null,
    versionOk,
    supported: versionOk && schema.supportsTranscript,
    supportsTranscript: schema.supportsTranscript,
    schemaKinds: schema.kinds,
    error: !versionOk
      ? `Claude CLI ${version?.text || '?'} is older than required ${MIN_VERSION.join('.')}.`
      : (schema.supportsTranscript ? null : `Transcript schema probe failed: ${schema.reason}`),
  }
}
