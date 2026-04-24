import { WebSocketServer, WebSocket } from 'ws'
import { randomBytes } from 'crypto'
import * as https from 'https'
import * as path from 'path'
import * as fs from 'fs'
import type { IncomingMessage } from 'http'
import type { AddressInfo } from 'net'
import { invokeHandler } from './handler-registry'
import { logger } from '../logger'
import { broadcastHub } from './broadcast-hub'
import { PROXIED_CHANNELS, PROXIED_EVENTS, type RemoteFrame } from './protocol'
import { ensureCertificate, type ServerCertificate } from './certificate'
import { readEncryptedString, writeEncryptedString } from './secrets'

interface AuthenticatedClient {
  ws: WebSocket
  label: string
  connectedAt: number
}

export type BindInterface = 'localhost' | 'tailscale' | 'all'

export interface StartServerOptions {
  port?: number
  token?: string
  bindInterface?: BindInterface
}

export interface StartServerResult {
  port: number
  token: string
  fingerprint: string
  bindInterface: BindInterface
  boundHost: string
}

const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024 // 32MB — payloads larger than this are dropped
const AUTH_TIMEOUT_MS = 5_000
const HEARTBEAT_MS = 30_000

// Brute-force protection: per-IP failed auth tracking.
// After MAX_AUTH_FAILURES within AUTH_FAIL_WINDOW_MS, the IP is rejected for AUTH_BAN_MS.
const MAX_AUTH_FAILURES = 5
const AUTH_FAIL_WINDOW_MS = 60_000
const AUTH_BAN_MS = 10 * 60_000

interface FailureEntry {
  count: number
  firstFailAt: number
  bannedUntil: number
}

function resolveBindHost(iface: BindInterface): string {
  if (iface === 'localhost') return '127.0.0.1'
  if (iface === 'all') return '0.0.0.0'
  // tailscale: pick the first 100.x.x.x IPv4, fallback to localhost if not present.
  const nets = require('os').networkInterfaces() as Record<string, Array<{ address: string; family: string; internal: boolean }> | undefined>
  for (const iface of Object.values(nets)) {
    if (!iface) continue
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal && net.address.startsWith('100.')) return net.address
    }
  }
  logger.warn('[RemoteServer] tailscale interface requested but no 100.x.x.x found — falling back to localhost')
  return '127.0.0.1'
}

export class RemoteServer {
  private wss: WebSocketServer | null = null
  private httpsServer: https.Server | null = null
  private token: string = ''
  private clients: Map<WebSocket, AuthenticatedClient> = new Map()
  private broadcastListener: ((...args: unknown[]) => void) | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private certificate: ServerCertificate | null = null
  private authFailures: Map<string, FailureEntry> = new Map()
  private _bindInterface: BindInterface = 'localhost'
  private _boundHost: string = '127.0.0.1'
  configDir: string = '' // Set by main.ts to app.getPath('userData')

  get port(): number | null {
    const addr = this.httpsServer?.address() as AddressInfo | null
    if (addr && typeof addr === 'object') return addr.port
    return null
  }

  get isRunning(): boolean {
    return this.httpsServer !== null
  }

  get fingerprint(): string | null {
    return this.certificate?.fingerprint256 ?? null
  }

  get bindInterface(): BindInterface {
    return this._bindInterface
  }

  get boundHost(): string {
    return this._boundHost
  }

  get connectedClients(): { label: string; connectedAt: number }[] {
    return Array.from(this.clients.values()).map(c => ({
      label: c.label,
      connectedAt: c.connectedAt
    }))
  }

  private tokenPath(): string {
    return path.join(this.configDir, 'server-token.enc.json')
  }

  private loadPersistedToken(): string | null {
    if (!this.configDir) return null
    // Preferred path: encrypted file
    const encrypted = readEncryptedString(this.tokenPath())
    if (encrypted) return encrypted
    // Legacy plaintext fallback: migrate on read
    try {
      const legacyPath = path.join(this.configDir, 'server-token.json')
      if (!fs.existsSync(legacyPath)) return null
      const data = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as { token?: string }
      if (data.token) {
        writeEncryptedString(this.tokenPath(), data.token)
        try { fs.unlinkSync(legacyPath) } catch { /* ignore */ }
        logger.log('[RemoteServer] migrated legacy plaintext token to safeStorage')
        return data.token
      }
    } catch {
      /* ignore */
    }
    return null
  }

  private persistToken(token: string): void {
    if (!this.configDir) return
    try {
      writeEncryptedString(this.tokenPath(), token)
    } catch (e) {
      logger.warn('[RemoteServer] Failed to persist token:', e)
    }
  }

  /**
   * Read the currently persisted token without starting the server.
   * Used by tunnel:get-connection when the server is already running but the
   * caller needs the token to embed in a QR code.
   */
  getPersistedToken(): string | null {
    return this.token || this.loadPersistedToken()
  }

  private getClientIp(req: IncomingMessage): string {
    const addr = req.socket.remoteAddress ?? 'unknown'
    return addr.replace(/^::ffff:/, '')
  }

  private isBanned(ip: string): boolean {
    const entry = this.authFailures.get(ip)
    if (!entry) return false
    if (Date.now() < entry.bannedUntil) return true
    // Ban expired — reset window if stale.
    if (Date.now() - entry.firstFailAt > AUTH_FAIL_WINDOW_MS) {
      this.authFailures.delete(ip)
    }
    return false
  }

  private recordAuthFailure(ip: string): void {
    const now = Date.now()
    const entry = this.authFailures.get(ip)
    if (!entry || now - entry.firstFailAt > AUTH_FAIL_WINDOW_MS) {
      this.authFailures.set(ip, { count: 1, firstFailAt: now, bannedUntil: 0 })
      return
    }
    entry.count++
    if (entry.count >= MAX_AUTH_FAILURES) {
      entry.bannedUntil = now + AUTH_BAN_MS
      logger.warn(`[RemoteServer] IP ${ip} banned for ${AUTH_BAN_MS / 1000}s after ${entry.count} failed auth attempts`)
    }
  }

  private clearAuthFailures(ip: string): void {
    this.authFailures.delete(ip)
  }

  async start(options: StartServerOptions = {}): Promise<StartServerResult> {
    if (this.httpsServer) throw new Error('Server already running')

    const port = options.port ?? 9876
    const bindInterface = options.bindInterface ?? 'localhost'
    const host = resolveBindHost(bindInterface)

    // Priority: explicit token > persisted token > new random token
    this.token = options.token || this.loadPersistedToken() || randomBytes(16).toString('hex')
    this.persistToken(this.token)

    // Load or generate self-signed cert
    this.certificate = await ensureCertificate(this.configDir)

    this.httpsServer = https.createServer({
      cert: this.certificate.cert,
      key: this.certificate.privateKey
    })
    this.wss = new WebSocketServer({
      server: this.httpsServer,
      maxPayload: MAX_PAYLOAD_BYTES
    })

    this.wss.on('connection', (ws, req) => {
      const ip = this.getClientIp(req)

      if (this.isBanned(ip)) {
        logger.warn(`[RemoteServer] rejecting banned IP ${ip}`)
        try { ws.close(1008, 'Banned') } catch { /* ignore */ }
        return
      }

      let authenticated = false

      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          this.sendFrame(ws, { type: 'auth-result', id: '0', error: 'Auth timeout' })
          try { ws.close() } catch { /* ignore */ }
        }
      }, AUTH_TIMEOUT_MS)

      ws.on('message', async (raw) => {
        let frame: RemoteFrame
        try {
          frame = JSON.parse(raw.toString())
        } catch {
          return
        }

        if (frame.type === 'auth') {
          if (frame.token === this.token) {
            authenticated = true
            clearTimeout(authTimeout)
            this.clearAuthFailures(ip)
            this.clients.set(ws, {
              ws,
              label: (frame.args?.[0] as string) || 'Remote Client',
              connectedAt: Date.now()
            })
            this.sendFrame(ws, { type: 'auth-result', id: frame.id, result: true })
            logger.log(`[RemoteServer] Client authenticated from ${ip}: ${this.clients.get(ws)?.label}`)
          } else {
            this.recordAuthFailure(ip)
            this.sendFrame(ws, { type: 'auth-result', id: frame.id, error: 'Invalid token' })
            try { ws.close(1008, 'Invalid token') } catch { /* ignore */ }
          }
          return
        }

        if (!authenticated) {
          // Unauthenticated clients that send anything other than `auth` are
          // considered hostile — close immediately rather than replying to
          // leak error shapes or burn CPU.
          this.recordAuthFailure(ip)
          try { ws.close(1008, 'Not authenticated') } catch { /* ignore */ }
          return
        }

        if (frame.type === 'ping') {
          this.sendFrame(ws, { type: 'pong', id: frame.id })
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
            const result = await invokeHandler(frame.channel, args, null, true)
            this.sendFrame(ws, { type: 'invoke-result', id: frame.id, result })
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            this.sendFrame(ws, { type: 'invoke-error', id: frame.id, error: message })
          }
          return
        }
      })

      ws.on('close', () => {
        clearTimeout(authTimeout)
        const client = this.clients.get(ws)
        if (client) {
          logger.log(`[RemoteServer] Client disconnected: ${client.label}`)
        }
        this.clients.delete(ws)
      })

      ws.on('error', (err) => {
        logger.error('[RemoteServer] WebSocket error:', err.message)
        this.clients.delete(ws)
      })
    })

    this.broadcastListener = (channel: unknown, ...args: unknown[]) => {
      if (typeof channel !== 'string') return
      if (!PROXIED_EVENTS.has(channel)) return
      const frame: RemoteFrame = { type: 'event', id: '0', channel, args }
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
        client.ws.ping()
      }
    }, HEARTBEAT_MS)

    this.httpsServer.listen(port, host)

    this._bindInterface = bindInterface
    this._boundHost = host

    logger.log(`[RemoteServer] Started on wss://${host}:${port} (iface=${bindInterface}), fingerprint: ${this.certificate.fingerprint256.slice(0, 23)}...`)
    return {
      port,
      token: this.token,
      fingerprint: this.certificate.fingerprint256,
      bindInterface,
      boundHost: host
    }
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.broadcastListener) {
      broadcastHub.off('broadcast', this.broadcastListener)
      this.broadcastListener = null
    }
    for (const client of this.clients.values()) {
      try { client.ws.close() } catch { /* ignore */ }
    }
    this.clients.clear()
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.httpsServer) {
      this.httpsServer.close()
      this.httpsServer = null
    }
    logger.log('[RemoteServer] Stopped')
  }

  private sendFrame(ws: WebSocket, frame: RemoteFrame): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame))
    }
  }
}
