// remote.* / tunnel.* — server + client lifecycle live.
//
// startServer / stopServer / serverStatus boot the WebSocketServer port
// from `lib/remote-server-impl.mjs`. connect / disconnect / clientStatus
// / testConnection / listProfiles drive the singleton RemoteClient from
// `lib/remote-client-impl.mjs`. listProfiles invokes the server-side
// profile.list bridge and returns the remote's visible profile entries.
//
// `tunnel.getConnection` returns the live address list once the server
// is running, otherwise the same {error, addresses} shape from #45 so
// SettingsPanel can show usable IPs even before startServer is called.

import { networkInterfaces } from 'node:os'
import { registerHandler } from '../lib/protocol.mjs'
import { resolveDataDir } from '../lib/data-paths.mjs'
import { RemoteServer } from '../lib/remote-server-impl.mjs'
import { RemoteClient } from '../lib/remote-client-impl.mjs'

function getAllAddresses(boundHost) {
  if (boundHost === '127.0.0.1' || boundHost === '::1' || boundHost === 'localhost') {
    return [{ ip: '127.0.0.1', mode: 'localhost', label: 'localhost — 127.0.0.1' }]
  }
  const nets = networkInterfaces()
  const tailscale = []
  const lan = []
  for (const [name, iface] of Object.entries(nets)) {
    if (!iface) continue
    for (const net of iface) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (net.address.startsWith('100.')) {
        tailscale.push({ ip: net.address, mode: 'tailscale', label: `${name} — ${net.address} (Tailscale)` })
      } else {
        lan.push({ ip: net.address, mode: 'lan', label: `${name} — ${net.address} (LAN)` })
      }
    }
  }
  return [...tailscale, ...lan]
}

export { getAllAddresses }

// Singleton. Lazy-instantiated so resolveDataDir() runs after env is set.
let serverInstance = null
function getServer() {
  if (!serverInstance) serverInstance = new RemoteServer(resolveDataDir())
  return serverInstance
}

// Test seam — replaces the singleton (cleans up the old one if running).
export async function __setRemoteServerForTests(server) {
  if (serverInstance && serverInstance !== server && serverInstance.isRunning) {
    try { await serverInstance.stop() } catch { /* ignore */ }
  }
  serverInstance = server
}

// Single shared outgoing client. The Tauri sidecar drives one renderer
// per process, so unlike Electron's per-profile map there's only one
// active outbound connection at a time.
let clientInstance = null
function getClient() {
  if (!clientInstance) clientInstance = new RemoteClient()
  return clientInstance
}

export async function __setRemoteClientForTests(client) {
  if (clientInstance && clientInstance !== client && clientInstance.isConnected) {
    try { clientInstance.disconnect() } catch { /* ignore */ }
  }
  clientInstance = client
}

registerHandler('remote.startServer', async (params) => {
  const opts = (params && typeof params === 'object' && params.options && typeof params.options === 'object')
    ? params.options : {}
  const port = typeof opts.port === 'number' ? opts.port : undefined
  const bindInterface = typeof opts.bindInterface === 'string' ? opts.bindInterface : undefined
  const token = typeof opts.token === 'string' ? opts.token : undefined
  try {
    return await getServer().start({ port, bindInterface, token })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

registerHandler('remote.stopServer', async () => {
  try { await getServer().stop(); return true }
  catch { return false }
})

registerHandler('remote.serverStatus', async () => getServer().status())

// remote.connect — connect the singleton client. Returns
// {connected:true, info} on success, {error} otherwise. The Electron
// version returned a bare boolean from the IPC call; the sidecar wraps
// it in a structured response so the renderer's `'error' in result`
// branch stays well-defined.
registerHandler('remote.connect', async (params) => {
  const opts = params && typeof params === 'object' ? params : {}
  const host = typeof opts.host === 'string' ? opts.host : ''
  const port = typeof opts.port === 'number' ? opts.port : 0
  const token = typeof opts.token === 'string' ? opts.token : ''
  const fingerprint = typeof opts.fingerprint === 'string' ? opts.fingerprint : ''
  const label = typeof opts.label === 'string' ? opts.label : undefined
  if (!host || !port || !token || !fingerprint) {
    return { error: 'host, port, token, and fingerprint are required' }
  }
  const client = getClient()
  try {
    const ok = await client.connect({ host, port, token, fingerprint, label })
    if (!ok) return { connected: false, error: 'Connection failed' }
    return { connected: true, info: client.connectionInfo }
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) }
  }
})

registerHandler('remote.disconnect', async () => {
  try { getClient().disconnect(); return true }
  catch { return false }
})

registerHandler('remote.clientStatus', async () => {
  const client = getClient()
  const connected = client.isConnected
  return { connected, info: connected ? client.connectionInfo : null }
})

// remote.invoke — bridge a Tauri command back onto the Electron-compatible
// remote IPC channel. Electron proxies these channels in main.ts based on the
// sender window profile; Tauri resolves that in Rust and uses this generic
// sidecar hop to keep the remote protocol unchanged.
registerHandler('remote.invoke', async (params) => {
  const opts = params && typeof params === 'object' ? params : {}
  const channel = typeof opts.channel === 'string' ? opts.channel : ''
  const args = Array.isArray(opts.args) ? opts.args : []
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined
  if (!channel) throw new Error('remote.invoke: channel is required')
  const client = getClient()
  if (!client.isConnected) throw new Error('remote.invoke: not connected to remote server')
  return client.invoke(channel, args, timeoutMs)
})

// remote.testConnection — spin up an ephemeral RemoteClient, connect,
// disconnect, return {ok}. Used by SettingsPanel to validate user-pasted
// host/port/token/fingerprint before persisting the profile.
registerHandler('remote.testConnection', async (params) => {
  const opts = params && typeof params === 'object' ? params : {}
  const host = typeof opts.host === 'string' ? opts.host : ''
  const port = typeof opts.port === 'number' ? opts.port : 0
  const token = typeof opts.token === 'string' ? opts.token : ''
  const fingerprint = typeof opts.fingerprint === 'string' ? opts.fingerprint : ''
  if (!fingerprint) return { ok: false, error: 'fingerprint is required' }
  if (!host || !port || !token) return { ok: false, error: 'host, port, and token are required' }
  const tester = new RemoteClient()
  try {
    const ok = await tester.connect({ host, port, token, fingerprint })
    tester.disconnect()
    return { ok }
  } catch (err) {
    tester.disconnect()
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// remote.listProfiles — connect, invoke 'profile:list', map to the
// renderer-friendly subset, disconnect.
registerHandler('remote.listProfiles', async (params) => {
  const opts = params && typeof params === 'object' ? params : {}
  const host = typeof opts.host === 'string' ? opts.host : ''
  const port = typeof opts.port === 'number' ? opts.port : 0
  const token = typeof opts.token === 'string' ? opts.token : ''
  const fingerprint = typeof opts.fingerprint === 'string' ? opts.fingerprint : ''
  if (!fingerprint) return { error: 'fingerprint is required' }
  if (!host || !port || !token) return { error: 'host, port, and token are required' }
  const tmp = new RemoteClient()
  try {
    const ok = await tmp.connect({ host, port, token, fingerprint })
    if (!ok) { tmp.disconnect(); return { error: 'Connection failed' } }
    const result = await tmp.invoke('profile:list', [])
    tmp.disconnect()
    const profiles = Array.isArray(result?.profiles)
      ? result.profiles.map(p => ({ id: p.id, name: p.name, type: p.type }))
      : []
    const activeProfileIds = Array.isArray(result?.activeProfileIds) ? result.activeProfileIds : []
    return { profiles, activeProfileIds }
  } catch (err) {
    tmp.disconnect()
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

registerHandler('tunnel.getConnection', async (params) => {
  const server = getServer()
  if (server.isRunning) {
    const addresses = getAllAddresses(server.boundHost)
    return {
      url: `wss://${addresses[0]?.ip ?? server.boundHost}:${server.port}`,
      token: server.getPersistedToken() ?? '',
      fingerprint: server.fingerprint ?? '',
      mode: addresses[0]?.mode ?? 'localhost',
      addresses,
    }
  }
  // Server not running — surface the real address list with an
  // informative error so SettingsPanel can show usable IPs.
  const boundHost = typeof params?.boundHost === 'string' ? params.boundHost : 'all'
  const addresses = getAllAddresses(boundHost === 'all' ? '0.0.0.0' : boundHost)
  return {
    error: 'server not running — start the remote server before generating a QR code',
    addresses,
  }
})
