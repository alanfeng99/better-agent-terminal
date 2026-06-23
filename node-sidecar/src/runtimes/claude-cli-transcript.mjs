// Transcript locator + incremental tailer for the Claude CLI agent path.
//
// The interactive `claude` CLI writes the session transcript to
//   <configDir>/projects/<cwd-slug>/<session-id>.jsonl
// as NDJSON, appended while the turn runs. We never compute the slug: we
// generate the session id, pass it to the CLI (--session-id), then locate the
// file by its <session-id>.jsonl name. This module then tails it, parsing
// complete lines into frames via claude-cli-frames.
//
// Self-contained; no dependency on the channel path.

import { openSync, readSync, closeSync, statSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseTranscriptLine } from './claude-cli-frames.mjs'

const NEWLINE = 0x0a

export function resolveConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function resolveProjectsDir(env = process.env) {
  return join(resolveConfigDir(env), 'projects')
}

// Find <session-id>.jsonl anywhere under projects/. Returns the path or null.
export function locateTranscriptBySessionId(sessionId, { projectsDir = resolveProjectsDir() } = {}) {
  if (!sessionId) return null
  const target = `${sessionId}.jsonl`
  const stack = [projectsDir]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name === target) return full
    }
  }
  return null
}

function readNewBytes(filePath, offset, size) {
  const len = size - offset
  if (len <= 0) return Buffer.alloc(0)
  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(len)
    const read = readSync(fd, buf, 0, len, offset)
    return read === len ? buf : buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

// createTranscriptTailer
//   opts.filePath   absolute path to the transcript (may not exist yet)
//   opts.onFrames   (frames[], { raw }) => void   — called per complete line
//   opts.onError    (err) => void                 — optional
//   opts.pollMs     poll interval (default 150)
//   opts.startAtEnd if true, ignore existing content; only tail new lines
// Returns { stop() }.
export function createTranscriptTailer(opts) {
  const { filePath, onFrames, onError, pollMs = 150, startAtEnd = false } = opts || {}
  if (!filePath) throw new Error('createTranscriptTailer: filePath required')
  if (typeof onFrames !== 'function') throw new Error('createTranscriptTailer: onFrames required')

  let offset = 0
  let leftover = Buffer.alloc(0)
  let initialized = false
  let stopped = false

  function init() {
    if (initialized) return
    if (!existsSync(filePath)) return // wait for the CLI to create it
    initialized = true
    if (startAtEnd) {
      try { offset = statSync(filePath).size } catch { offset = 0 }
    }
  }

  function emitLine(buf) {
    const line = buf.toString('utf8')
    let frames
    try {
      frames = parseTranscriptLine(line)
    } catch (err) {
      onError?.(err)
      return
    }
    if (frames.length) onFrames(frames, { raw: line })
  }

  function tick() {
    if (stopped) return
    init()
    if (!initialized) return
    let size
    try { size = statSync(filePath).size } catch { return }
    if (size < offset) { // truncation / rotation → restart
      offset = 0
      leftover = Buffer.alloc(0)
    }
    if (size === offset) return
    let chunk
    try { chunk = readNewBytes(filePath, offset, size) } catch (err) { onError?.(err); return }
    offset = size
    const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk
    let start = 0
    for (let i = 0; i < data.length; i++) {
      if (data[i] === NEWLINE) {
        emitLine(data.subarray(start, i))
        start = i + 1
      }
    }
    leftover = start < data.length ? data.subarray(start) : Buffer.alloc(0)
  }

  const timer = setInterval(tick, pollMs)
  if (typeof timer.unref === 'function') timer.unref()
  // Prime once synchronously so a fully-written file is picked up promptly.
  tick()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    // exposed for tests/diagnostics
    _flushNow: tick,
  }
}
