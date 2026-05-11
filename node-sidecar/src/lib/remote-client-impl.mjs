// WebSocket client for the remote namespace, ported from
// electron/remote/remote-client.ts.
//
// Differences from the Electron version:
//   - No `BrowserWindow` fan-out. Server-pushed `event` frames are
//     re-emitted to the Tauri renderer via the sidecar's `sendEvent`
//     JSON-RPC notification stream (replaces webContents.send).
//   - Default logger writes to stderr so it never pollutes the stdout
//     JSON-RPC channel; tests can swap it via __setRemoteClientLoggerForTests.
//   - Uses `remote-fingerprint.mjs::normalizeFingerprint` for pin parity
//     with the server side.

import WebSocket from 'ws'
import { randomBytes } from 'node:crypto'

import { sendEvent } from './protocol.mjs'
import { PROXIED_EVENTS } from './remote-protocol.mjs'
import { normalizeFingerprint } from './remote-fingerprint.mjs'

const BACKOFF_BASE_MS = 3_000
const BACKOFF_MAX_MS = 30_000
const AUTH_TIMEOUT_MS = 6_000
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000

// Default emitter forwards server-pushed event frames out to the Tauri
// renderer through the sidecar's JSON-RPC notification stream.
let _emitToRenderer = (channel, args) => {
  sendEvent(channel, normalizeRemoteEvent(channel, args))
}

// Test seam — swap the emitter to capture event frames in-process.
export function __setRemoteClientEmitForTests(fn) {
  const prev = _emitToRenderer
  _emitToRenderer = typeof fn === 'function' ? fn : prev
  return () => { _emitToRenderer = prev }
}

let _logger = {
  log: (...args) => { try { console.error('[RemoteClient]', ...args) } catch { /* ignore */ } },
  error: (...args) => { try { console.error('[RemoteClient]', ...args) } catch { /* ignore */ } },
}
export function __setRemoteClientLoggerForTests(fn) {
  const prev = _logger
  _logger = fn || prev
  return () => { _logger = prev }
}

const CLAUDE_EVENT_PAYLOAD_KEYS = {
  'claude:message': 'message',
  'claude:tool-use': 'toolCall',
  'claude:tool-result': 'result',
  'claude:stream': 'data',
  'claude:result': 'result',
  'claude:turn-end': 'payload',
  'claude:error': 'error',
  'claude:status': 'meta',
  'claude:permission-request': 'data',
  'claude:permission-resolved': 'toolUseId',
  'claude:ask-user': 'data',
  'claude:ask-user-resolved': 'toolUseId',
  'claude:modeChange': 'mode',
  'claude:history': 'items',
  'claude:resume-loading': 'loading',
  'claude:prompt-suggestion': 'suggestion',
  'claude:worktree-info': 'payload',
  'claude:rate-limit': 'info',
}

function normalizeRemoteEvent(channel, args) {
  const values = Array.isArray(args) ? args : []
  if (channel === 'pty:output') return { id: values[0], data: values[1] }
  if (channel === 'pty:exit') return { id: values[0], exitCode: values[1] }
  if (channel === 'claude:session-reset') return { sessionId: values[0] }
  const payloadKey = CLAUDE_EVENT_PAYLOAD_KEYS[channel]
  if (payloadKey) return { sessionId: values[0], [payloadKey]: values[1] }
  if (channel === 'fs:changed') return values[0] ?? null
  if (channel === 'workspace:detached' || channel === 'workspace:reattached' || channel === 'workspace:reload') {
    return values[0] ?? null
  }
  if (channel === 'system:resume') return values[0] ?? null
  return { args: values }
}

export const __normalizeRemoteEventForTests = normalizeRemoteEvent

export class RemoteClient {
  constructor() {
    this.ws = null
    this.pending = new Map()
    this._connected = false
    this.reconnectTimer = null
    this.reconnectAttempt = 0
    this.host = ''
    this.port = 0
    this.token = ''
    this.label = ''
    this.pinnedFingerprint = ''
    this.shouldReconnect = false
    // Bumped by every connect() / disconnect() so a stale in-flight
    // reconnect can detect it was superseded and abandon itself.
    this.generation = 0
    this._counter = 0
  }

  get isConnected() {
    return this._connected && this.ws?.readyState === WebSocket.OPEN
  }

  get connectionInfo() {
    if (!this._connected) return null
    return { host: this.host, port: this.port }
  }

  connect(options) {
    if (this.ws) this.disconnect()

    if (!options || typeof options !== 'object') {
      return Promise.reject(new Error('connect: options is required'))
    }
    const host = typeof options.host === 'string' ? options.host : ''
    const port = typeof options.port === 'number' ? options.port : 0
    const token = typeof options.token === 'string' ? options.token : ''
    if (!host) return Promise.reject(new Error('connect: host is required'))
    if (!port) return Promise.reject(new Error('connect: port is required'))
    if (!token) return Promise.reject(new Error('connect: token is required'))

    this.host = host
    this.port = port
    this.token = token
    this.label = (typeof options.label === 'string' && options.label) || `Client-${randomBytes(3).toString('hex')}`
    this.pinnedFingerprint = normalizeFingerprint(options.fingerprint || '')
    if (!this.pinnedFingerprint) {
      return Promise.reject(new Error('fingerprint is required for TLS pinning'))
    }
    this.shouldReconnect = true
    this.generation++

    return this._doConnect(this.generation)
  }

  _doConnect(generation) {
    return new Promise((resolve) => {
      if (generation !== this.generation) {
        resolve(false)
        return
      }
      const url = `wss://${this.host}:${this.port}`
      // rejectUnauthorized:false because we use fingerprint pinning instead
      // of CA trust. Verification of the cert happens manually on 'open'.
      const ws = new WebSocket(url, {
        rejectUnauthorized: false,
        handshakeTimeout: AUTH_TIMEOUT_MS,
      })
      this.ws = ws

      let authResolved = false
      const finish = (ok) => {
        if (authResolved) return
        authResolved = true
        if (!ok) {
          this._connected = false
          try { ws.close() } catch { /* ignore */ }
        }
        resolve(ok)
      }

      const authTimeout = setTimeout(() => finish(false), AUTH_TIMEOUT_MS)
      if (authTimeout.unref) authTimeout.unref()

      ws.on('open', () => {
        // Pin check via the underlying TLS socket.
        const rawSocket = ws._socket
        const peerCert = rawSocket?.getPeerCertificate?.(false)
        const peerFingerprint = peerCert ? normalizeFingerprint(peerCert.fingerprint256 ?? '') : ''
        if (!peerFingerprint || peerFingerprint !== this.pinnedFingerprint) {
          _logger.error(
            `fingerprint mismatch: expected ${this.pinnedFingerprint.slice(0, 16)}..., got ${peerFingerprint.slice(0, 16) || '(none)'}`,
          )
          clearTimeout(authTimeout)
          finish(false)
          return
        }

        const authFrame = {
          type: 'auth',
          id: this._nextId(),
          token: this.token,
          args: [this.label],
        }
        try { ws.send(JSON.stringify(authFrame)) }
        catch { finish(false) }
      })

      ws.on('message', (raw) => {
        let frame
        try { frame = JSON.parse(raw.toString()) }
        catch { return }

        if (frame.type === 'auth-result') {
          clearTimeout(authTimeout)
          if (frame.error) {
            _logger.error(`Auth failed: ${frame.error}`)
            finish(false)
          } else {
            this._connected = true
            this.reconnectAttempt = 0
            _logger.log(`Connected to ${this.host}:${this.port}`)
            finish(true)
          }
          return
        }

        if (frame.type === 'invoke-result' || frame.type === 'invoke-error') {
          const pending = this.pending.get(frame.id)
          if (pending) {
            clearTimeout(pending.timer)
            this.pending.delete(frame.id)
            if (frame.type === 'invoke-error') {
              pending.reject(new Error(frame.error || 'Remote invoke failed'))
            } else {
              pending.resolve(frame.result)
            }
          }
          return
        }

        if (frame.type === 'pong') return

        if (frame.type === 'event' && frame.channel && PROXIED_EVENTS.has(frame.channel)) {
          try { _emitToRenderer(frame.channel, frame.args || []) }
          catch (err) {
            _logger.error('event emit failed', err instanceof Error ? err.message : String(err))
          }
          return
        }
      })

      ws.on('close', () => {
        clearTimeout(authTimeout)
        const wasConnected = this._connected
        this._connected = false

        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer)
          pending.reject(new Error('Connection closed'))
          this.pending.delete(id)
        }

        if (wasConnected) _logger.log('Disconnected')

        // Only reconnect if this close belongs to the current generation
        // AND the previous attempt had authenticated at least once.
        if (this.shouldReconnect && generation === this.generation && wasConnected) {
          this._scheduleReconnect(generation)
        }
        if (!authResolved) finish(false)
      })

      ws.on('error', (err) => {
        _logger.error('WebSocket error:', err?.message ?? String(err))
        if (!authResolved) {
          clearTimeout(authTimeout)
          finish(false)
        }
      })
    })
  }

  _scheduleReconnect(generation) {
    if (this.reconnectTimer) return
    if (generation !== this.generation) return

    this.reconnectAttempt++
    // Exponential backoff with jitter: base * 2^(n-1), capped, ±25%.
    const exp = Math.min(BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempt - 1), BACKOFF_MAX_MS)
    const jitter = exp * (0.75 + Math.random() * 0.5)
    const delay = Math.round(jitter)

    _logger.log(`Reconnect attempt ${this.reconnectAttempt} in ${delay}ms`)
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (!this.shouldReconnect || generation !== this.generation) return
      try {
        const ok = await this._doConnect(generation)
        if (!ok && this.shouldReconnect && generation === this.generation) {
          this._scheduleReconnect(generation)
        }
      } catch {
        if (this.shouldReconnect && generation === this.generation) {
          this._scheduleReconnect(generation)
        }
      }
    }, delay)
    if (this.reconnectTimer.unref) this.reconnectTimer.unref()
  }

  disconnect() {
    this.shouldReconnect = false
    this._connected = false
    this.reconnectAttempt = 0
    this.generation++

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Disconnected'))
      this.pending.delete(id)
    }

    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }

    _logger.log('Disconnected (explicit)')
  }

  invoke(channel, args = [], timeout = DEFAULT_INVOKE_TIMEOUT_MS) {
    if (!this.isConnected) {
      return Promise.reject(new Error('Not connected to remote server'))
    }
    if (typeof channel !== 'string' || !channel) {
      return Promise.reject(new Error('invoke: channel must be a non-empty string'))
    }

    const id = this._nextId()
    const frame = { type: 'invoke', id, channel, args: Array.isArray(args) ? args : [] }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Remote invoke timeout: ${channel}`))
      }, timeout)
      if (timer.unref) timer.unref()

      this.pending.set(id, { resolve, reject, timer })
      try { this.ws.send(JSON.stringify(frame)) }
      catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  _nextId() {
    return `${Date.now()}-${++this._counter}`
  }
}
