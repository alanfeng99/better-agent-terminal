// WebSocket server for the remote namespace, ported from
// electron/remote/remote-server.ts.
//
// Hosts:
//   - HTTPS server with self-signed cert from ensureCertificate()
//   - WebSocketServer on top
//   - Per-connection auth using a shared bearer token persisted via
//     remote-secrets envelope
//   - Per-IP brute-force tracking (5 fails / 60s window → 10min ban)
//   - Heartbeat ping every 30s
//   - Broadcast fan-out from broadcastHub for PROXIED_EVENTS
//   - Ping/pong app-level frames for the client's own keepalive
//
// Invoke handler bridge is **not** wired in this slice — frames with
// type:'invoke' return invoke-error('Channel is not exposed remotely:
// ...') for now. The Phase-3 follow-up slice plumbs invoke frames into
// the sidecar's JSON-RPC dispatch.

import { randomBytes } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { WebSocketServer, WebSocket } from 'ws'

import { broadcastHub } from './remote-broadcast.mjs'
import { PROXIED_CHANNELS, PROXIED_EVENTS, invokeRemoteHandler, hasRemoteHandler } from './remote-protocol.mjs'
import { ensureCertificate } from './remote-certificate.mjs'
import { readEncryptedString, writeEncryptedString } from './remote-secrets.mjs'

const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
const AUTH_TIMEOUT_MS = 5_000
const HEARTBEAT_MS = 30_000
const MAX_AUTH_FAILURES = 5
const AUTH_FAIL_WINDOW_MS = 60_000
const AUTH_BAN_MS = 10 * 60_000
const TOKEN_FILE = 'server-token.enc.json'
const LEGACY_TOKEN_FILE = 'server-token.json'

function resolveBindHost(iface) {
  if (iface === 'localhost') return '127.0.0.1'
  if (iface === 'all') return '0.0.0.0'
  // tailscale: pick the first 100.x.x.x IPv4, fallback to localhost.
  const nets = networkInterfaces()
  for (const list of Object.values(nets)) {
    if (!list) continue
    for (const net of list) {
      if (net.family === 'IPv4' && !net.internal && net.address.startsWith('100.')) return net.address
    }
  }
  return '127.0.0.1'
}

export class RemoteServer {
  constructor(configDir) {
    if (typeof configDir !== 'string' || !configDir) {
      throw new Error('RemoteServer: configDir must be a non-empty string')
    }
    this.configDir = configDir
    this.httpsServer = null
    this.wss = null
    this.token = ''
    this.certificate = null
    this.clients = new Map()
    this.authFailures = new Map()
    this.broadcastListener = null
    this.heartbeatInterval = null
    this._bindInterface = 'localhost'
    this._boundHost = '127.0.0.1'
    this.defaultWindowId = null
  }

  get isRunning() { return this.httpsServer !== null }

  get port() {
    const addr = this.httpsServer?.address?.()
    if (addr && typeof addr === 'object') return addr.port
    return null
  }

  get fingerprint() { return this.certificate?.fingerprint256 ?? null }
  get bindInterface() { return this._bindInterface }
  get boundHost() { return this._boundHost }

  get connectedClients() {
    return Array.from(this.clients.values()).map(c => ({
      label: c.label,
      windowId: c.windowId,
      connectedAt: c.connectedAt,
    }))
  }

  setDefaultWindowId(windowId) { this.defaultWindowId = windowId }

  tokenPath() { return join(this.configDir, TOKEN_FILE) }

  loadPersistedToken() {
    const encrypted = readEncryptedString(this.tokenPath())
    if (encrypted) return encrypted
    // Legacy plaintext fallback (migrate-on-read).
    try {
      const legacyPath = join(this.configDir, LEGACY_TOKEN_FILE)
      if (!existsSync(legacyPath)) return null
      const data = JSON.parse(readFileSync(legacyPath, 'utf-8'))
      if (data?.token) {
        writeEncryptedString(this.tokenPath(), data.token)
        try { unlinkSync(legacyPath) } catch { /* ignore */ }
        return data.token
      }
    } catch { /* ignore */ }
    return null
  }

  persistToken(token) {
    try { writeEncryptedString(this.tokenPath(), token) }
    catch { /* persist failure non-fatal */ }
  }

  getPersistedToken() { return this.token || this.loadPersistedToken() }

  getClientIp(req) {
    const addr = req?.socket?.remoteAddress ?? 'unknown'
    return addr.replace(/^::ffff:/, '')
  }

  isBanned(ip) {
    const entry = this.authFailures.get(ip)
    if (!entry) return false
    if (Date.now() < entry.bannedUntil) return true
    if (Date.now() - entry.firstFailAt > AUTH_FAIL_WINDOW_MS) {
      this.authFailures.delete(ip)
    }
    return false
  }

  recordAuthFailure(ip) {
    const now = Date.now()
    const entry = this.authFailures.get(ip)
    if (!entry || now - entry.firstFailAt > AUTH_FAIL_WINDOW_MS) {
      this.authFailures.set(ip, { count: 1, firstFailAt: now, bannedUntil: 0 })
      return
    }
    entry.count++
    if (entry.count >= MAX_AUTH_FAILURES) {
      entry.bannedUntil = now + AUTH_BAN_MS
    }
  }

  clearAuthFailures(ip) { this.authFailures.delete(ip) }

  async start(options = {}) {
    if (this.httpsServer) throw new Error('Server already running')
    const port = options.port ?? 0 // 0 = OS-assigned; tests rely on this
    const bindInterface = options.bindInterface ?? 'localhost'
    const host = resolveBindHost(bindInterface)

    // ensureCertificate first so configDir is mkdir'd; persistToken
    // requires the directory to exist (writeEncryptedString writes
    // unconditionally and silently swallows ENOENT in the fallback).
    this.certificate = await ensureCertificate(this.configDir)

    this.token = options.token || this.loadPersistedToken() || randomBytes(16).toString('hex')
    this.persistToken(this.token)

    this.httpsServer = createHttpsServer({
      cert: this.certificate.cert,
      key: this.certificate.privateKey,
    })
    this.wss = new WebSocketServer({
      server: this.httpsServer,
      maxPayload: MAX_PAYLOAD_BYTES,
    })

    this.wss.on('connection', (ws, req) => this._onConnection(ws, req))

    this.broadcastListener = (channel, ...args) => {
      if (typeof channel !== 'string') return
      if (!PROXIED_EVENTS.has(channel)) return
      const frame = { type: 'event', id: '0', channel, args }
      const data = JSON.stringify(frame)
      for (const client of this.clients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(data)
        }
      }
    }
    broadcastHub.on('broadcast', this.broadcastListener)

    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return
      for (const client of this.clients.values()) {
        if (client.ws.readyState !== WebSocket.OPEN) {
          this.clients.delete(client.ws)
          continue
        }
        try { client.ws.ping() } catch { /* ignore */ }
      }
    }, HEARTBEAT_MS)
    // Don't keep the event loop alive just for the heartbeat — sidecar
    // exits when the parent process closes stdin, the server should
    // not block that.
    if (this.heartbeatInterval.unref) this.heartbeatInterval.unref()

    await new Promise(resolve => this.httpsServer.listen(port, host, resolve))

    this._bindInterface = bindInterface
    this._boundHost = host

    return {
      port: this.port,
      token: this.token,
      fingerprint: this.certificate.fingerprint256,
      bindInterface,
      boundHost: host,
    }
  }

  _onConnection(ws, req) {
    const ip = this.getClientIp(req)
    if (this.isBanned(ip)) {
      try { ws.close(1008, 'Banned') } catch { /* ignore */ }
      return
    }

    let authenticated = false
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        this._send(ws, { type: 'auth-result', id: '0', error: 'Auth timeout' })
        try { ws.close() } catch { /* ignore */ }
      }
    }, AUTH_TIMEOUT_MS)
    if (authTimeout.unref) authTimeout.unref()

    ws.on('message', async (raw) => {
      let frame
      try { frame = JSON.parse(raw.toString()) }
      catch { return }

      if (frame.type === 'auth') {
        if (frame.token === this.token) {
          const requested = frame.args?.[1]
          const requestedWindowId =
            requested && typeof requested === 'object' && typeof requested.windowId === 'string'
              ? requested.windowId : null
          authenticated = true
          clearTimeout(authTimeout)
          this.clearAuthFailures(ip)
          this.clients.set(ws, {
            ws,
            label: frame.args?.[0] || 'Remote Client',
            windowId: requestedWindowId || this.defaultWindowId,
            connectedAt: Date.now(),
          })
          this._send(ws, { type: 'auth-result', id: frame.id, result: true })
        } else {
          this.recordAuthFailure(ip)
          this._send(ws, { type: 'auth-result', id: frame.id, error: 'Invalid token' })
          try { ws.close(1008, 'Invalid token') } catch { /* ignore */ }
        }
        return
      }

      if (!authenticated) {
        this.recordAuthFailure(ip)
        try { ws.close(1008, 'Not authenticated') } catch { /* ignore */ }
        return
      }

      if (frame.type === 'ping') {
        this._send(ws, { type: 'pong', id: frame.id })
        return
      }

      if (frame.type === 'invoke' && frame.channel) {
        try {
          if (!PROXIED_CHANNELS.has(frame.channel)) {
            throw new Error(`Channel is not exposed remotely: ${frame.channel}`)
          }
          let args = frame.args || []
          while (args.length > 0 && args[args.length - 1] == null) {
            args = args.slice(0, -1)
          }
          const client = this.clients.get(ws)
          // Handler bridge: if a handler is registered via
          // registerRemoteHandler we use it; otherwise the channel is
          // listed as proxied but not yet bridged to the sidecar's
          // JSON-RPC dispatch (Phase-3 follow-up). Surface a clear
          // error rather than hanging.
          if (!hasRemoteHandler(frame.channel)) {
            throw new Error(`Channel is allowed but not yet bridged to sidecar dispatch: ${frame.channel}`)
          }
          const result = await invokeRemoteHandler(frame.channel, args, client?.windowId ?? null, true)
          this._send(ws, { type: 'invoke-result', id: frame.id, result })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this._send(ws, { type: 'invoke-error', id: frame.id, error: message })
        }
        return
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimeout)
      this.clients.delete(ws)
    })
    ws.on('error', () => { this.clients.delete(ws) })
  }

  _send(ws, frame) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(frame)) } catch { /* ignore */ }
    }
  }

  async stop() {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null }
    if (this.broadcastListener) {
      broadcastHub.off('broadcast', this.broadcastListener)
      this.broadcastListener = null
    }
    for (const client of this.clients.values()) {
      try { client.ws.close() } catch { /* ignore */ }
    }
    this.clients.clear()
    if (this.wss) {
      await new Promise(r => this.wss.close(() => r()))
      this.wss = null
    }
    if (this.httpsServer) {
      await new Promise(r => this.httpsServer.close(() => r()))
      this.httpsServer = null
    }
  }

  status() {
    return {
      running: this.isRunning,
      port: this.port,
      fingerprint: this.fingerprint,
      bindInterface: this.isRunning ? this._bindInterface : null,
      boundHost: this.isRunning ? this._boundHost : null,
      clients: this.connectedClients,
    }
  }
}
