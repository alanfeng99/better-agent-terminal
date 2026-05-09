// remote.* / tunnel.* — server lifecycle is now real.
//
// startServer / stopServer / serverStatus boot the WebSocketServer port
// from `lib/remote-server-impl.mjs`. The remote *client* side (connect /
// disconnect / clientStatus / testConnection / listProfiles) is still
// stubbed — that's a separate slice (port of electron/remote/remote-client.ts).
//
// `tunnel.getConnection` returns the live address list once the server
// is running, otherwise the same {error, addresses} shape from #45 so
// SettingsPanel can show usable IPs even before startServer is called.

import { networkInterfaces } from 'node:os'
import { registerHandler } from '../lib/protocol.mjs'
import { resolveDataDir } from '../lib/data-paths.mjs'
import { RemoteServer } from '../lib/remote-server-impl.mjs'

const REMOTE_CLIENT_STUB_ERR = 'remote client ops not yet wired through Tauri sidecar'

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

// Client-side ops still stubs — port lands separately.
registerHandler('remote.connect', async () => ({ error: REMOTE_CLIENT_STUB_ERR }))
registerHandler('remote.disconnect', async () => false)
registerHandler('remote.clientStatus', async () => ({ connected: false, info: null }))
registerHandler('remote.testConnection', async () => ({ ok: false, error: REMOTE_CLIENT_STUB_ERR }))
registerHandler('remote.listProfiles', async () => ({ error: REMOTE_CLIENT_STUB_ERR }))

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
