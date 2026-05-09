// remote.* / tunnel.* — partial port.
//
// Server/client lifecycle still stubs (TLS + WebSocket port lands later);
// `tunnel.getConnection` now returns the real LAN/Tailscale address list
// from `os.networkInterfaces()` so the SettingsPanel QR view can show
// usable IPs even before a server is started.

import { networkInterfaces } from 'node:os'
import { registerHandler } from '../lib/protocol.mjs'

const REMOTE_STUB_ERR = 'remote ops not yet wired through Tauri sidecar'

// Tunnel mode: where this address can be reached from.
//   localhost — loopback, same-machine only
//   tailscale — Tailscale 100.x.x.x address (private overlay)
//   lan       — any other non-internal IPv4 (e.g. 192.168.x.x)
//
// Mirrors electron/remote/tunnel-manager.ts so renderer destructuring stays
// stable when the real server lands.
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

registerHandler('remote.startServer', async () => ({ error: REMOTE_STUB_ERR }))
registerHandler('remote.stopServer', async () => false)
registerHandler('remote.serverStatus', async () => ({
  running: false, port: null, fingerprint: null, bindInterface: null, boundHost: null, clients: [],
}))
registerHandler('remote.connect', async () => ({ error: REMOTE_STUB_ERR }))
registerHandler('remote.disconnect', async () => false)
registerHandler('remote.clientStatus', async () => ({ connected: false, info: null }))
registerHandler('remote.testConnection', async () => ({ ok: false, error: REMOTE_STUB_ERR }))
registerHandler('remote.listProfiles', async () => ({ error: REMOTE_STUB_ERR }))

// Renderer's QR/mobile view auto-starts the server in Electron; in Tauri the
// server isn't wired yet so we surface the real address list with a clear
// `error` field. SettingsPanel keeps a "server not running" affordance and
// the address list is informational until startServer is implemented.
registerHandler('tunnel.getConnection', async (params) => {
  const boundHost = typeof params?.boundHost === 'string' ? params.boundHost : 'all'
  const addresses = getAllAddresses(boundHost === 'all' ? '0.0.0.0' : boundHost)
  return {
    error: 'server not running — start the remote server before generating a QR code',
    addresses,
  }
})
