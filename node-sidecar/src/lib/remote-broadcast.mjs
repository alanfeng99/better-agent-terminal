// Port of electron/remote/broadcast-hub.ts.
//
// A trivial event multiplexer the host uses to fan host→remote events
// out to all connected WebSocket clients. The Electron version sits
// between IPC senders (electron-side handlers) and the remote server's
// frame writer; the sidecar version plays the same role for the Phase-3
// WebSocket server. Single shared instance — same as Electron — so any
// sidecar handler can `broadcastHub.broadcast(channel, ...args)` and
// the server's `broadcastHub.on('broadcast', ...)` listener picks it up.
//
// Until the WebSocket server lands the hub is a sink with no listener
// (broadcasts no-op). Tests below exercise the multi-listener / args-
// preservation contract so the future server can rely on it.

import { EventEmitter } from 'node:events'

class BroadcastHub extends EventEmitter {
  broadcast(channel, ...args) {
    this.emit('broadcast', channel, ...args)
  }
}

export const broadcastHub = new BroadcastHub()

// Reset hook for tests — clears all subscribers without dropping the
// shared singleton reference (consumers may have already imported it).
export function __resetBroadcastHubForTests() {
  broadcastHub.removeAllListeners()
}
