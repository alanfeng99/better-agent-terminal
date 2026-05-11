// Remote invoke bridge — wires every PROXIED_CHANNEL to the sidecar's
// JSON-RPC dispatch.
//
// The remote WebSocket server hands incoming `invoke` frames off to
// `invokeRemoteHandler(channel, args)` (from remote-protocol.mjs). Until
// this bridge is wired the registry is empty and every allowed channel
// surfaces "Channel is allowed but not yet bridged to sidecar dispatch".
// This module fills that registry with one auto-bridge per channel that
// turns the kebab-style channel into the equivalent JSON-RPC method
// (`claude:start-session` → `claude.startSession`) and forwards the
// frame's first positional arg as the JSON-RPC `params` object.
//
// **Wire format note**: remote frames send `args` as a positional list,
// which is what Electron's IPC contract uses. The sidecar's JSON-RPC
// handlers take a single named-params object. We unwrap `args[0]` and
// pass it as `params`. Both ends in the Tauri build are produced by the
// same renderer/host-api pair, so they agree on the {params} shape; an
// Electron-built remote client sending positional args[N] would only see
// args[0] honored. That's intentional — once the Electron build retires,
// args[0] is the entire input.
//
// Channels that have no sidecar handler (e.g. `pty:*`, `git:*`, `fs:*`
// — those live in Tauri Rust commands and aren't reachable from the
// sidecar process) propagate JSON-RPC -32601 "method not found" as the
// invoke-error message. Renderer code already branches on `'error' in
// result`, so the failure surface stays identical to the "not yet
// bridged" path that preceded this slice.

import { PROXIED_CHANNELS, registerRemoteHandler, hasRemoteHandler } from './remote-protocol.mjs'
import { dispatch } from './protocol.mjs'

// kebab-style channel → camelCase JSON-RPC method.
//   'claude:start-session'    → 'claude.startSession'
//   'image:read-as-data-url'  → 'image.readAsDataUrl'
//   'snippet:toggleFavorite'  → 'snippet.toggleFavorite'  (no hyphens; pass through)
//   'git:getRoot'             → 'git.getRoot'             (no hyphens; pass through)
export function channelToMethod(channel) {
  if (typeof channel !== 'string' || !channel) {
    throw new Error('channelToMethod: channel must be a non-empty string')
  }
  return channel
    .replace(':', '.')
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

// Build the bridge handler closure once per channel. Capturing the
// translated method name avoids re-running the regex on each invoke.
function makeBridgeHandler(channel) {
  const method = channelToMethod(channel)
  return async function bridgeHandler(_ctx, ...args) {
    const params = args.length > 0 ? args[0] : null
    const reply = await dispatch({ jsonrpc: '2.0', id: 'bridge', method, params })
    if (reply && reply.error) {
      const err = new Error(reply.error.message || `Bridge dispatch failed: ${method}`)
      err.code = reply.error.code
      throw err
    }
    return reply ? reply.result : null
  }
}

// Idempotent. Re-runs are a no-op for channels already wired (skips the
// duplicate registerRemoteHandler call) so server restarts / test resets
// can call this without wiping.
export function wireRemoteBridgeHandlers() {
  let registered = 0
  for (const channel of PROXIED_CHANNELS) {
    if (hasRemoteHandler(channel)) continue
    registerRemoteHandler(channel, makeBridgeHandler(channel))
    registered++
  }
  return registered
}
