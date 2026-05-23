# Remote WebSocket Protocol V2

Last updated: 2026-05-23

This document records the intended Better Agent Terminal remote WebSocket v2 protocol.

Implementation entry points:

- Server: `src-tauri/src/remote_server.rs`
- Client: `src-tauri/src/remote_client.rs`
- Shared protocol helpers: `src-tauri/src/remote_core.rs`

## Transport

- Scheme: `wss://`
- Default port: `9876`
- Server TLS: self-signed certificate generated and persisted by the host.
- Client TLS validation: certificate fingerprint pinning.
- Frame encoding: one JSON object per WebSocket text message.

The client accepts the self-signed certificate only after comparing the server certificate SHA-256 fingerprint with the fingerprint stored in the remote profile or connection URL.

## Connection URL

Copy/paste URL format:

```text
wss://<host>:<port>?token=<token>&fp=<sha256-fingerprint>
```

Rules:

- `host`, `token`, and `fp` are required.
- `port` defaults to `9876` when omitted by UI parser code.
- `fp` is the SHA-256 fingerprint of the server TLS certificate.
- UI output formats the fingerprint as colon-separated uppercase hex.

## Server Persistence

The remote server persists:

- Token: `<app-data>/server-token.enc.json`
- TLS certificate and private key: `<app-data>/server-cert.enc.json`

If persisted token or certificate data cannot be read, the server generates a replacement.

## Protocol Identifier

V2 protocol id:

```text
bat-remote/v2
```

New clients should send this in the auth frame:

```json
{
  "type": "auth",
  "id": "1700000000000-auth",
  "token": "<server-token>",
  "protocols": ["bat-remote/v2"],
  "args": ["Client Label", { "windowId": "optional-window-id" }]
}
```

Server success response:

```json
{
  "type": "auth-result",
  "id": "1700000000000-auth",
  "result": true,
  "protocol": "bat-remote/v2"
}
```

Server error response:

```json
{
  "type": "auth-result",
  "id": "1700000000000-auth",
  "error": "Invalid token"
}
```

Rules:

- `token` must exactly match the server token.
- `protocols` must include `bat-remote/v2`.
- `args[0]` is the client label displayed in server status.
- `args[1].windowId` is optional and recorded in the server connected-client list when present.

## Frame Types

### `ping`

Client to server:

```json
{ "type": "ping", "id": "1" }
```

Server response:

```json
{ "type": "pong", "id": "1" }
```

### `invoke`

Client to server:

```json
{
  "type": "invoke",
  "id": "1700000000000-1",
  "channel": "agent:get-supported-models",
  "params": {
    "sessionId": "session-id"
  }
}
```

Server success response:

```json
{
  "type": "invoke-result",
  "id": "1700000000000-1",
  "result": {}
}
```

Server error response:

```json
{
  "type": "invoke-error",
  "id": "1700000000000-1",
  "error": "Remote invoke failed"
}
```

Rules:

- `id` is an opaque request id and must be echoed by the server.
- `channel` is required.
- `params` is the named parameter object.
- New v2 channels must use named params. Do not add new positional argument shapes.

### `event`

Server to client:

```json
{
  "type": "event",
  "channel": "agent:message",
  "params": {
    "sessionId": "session-id",
    "message": {
      "type": "assistant",
      "content": "..."
    }
  }
}
```

Rules:

- Events are broadcast by the host runtime to connected remote clients.
- `channel` must be allowlisted by the remote client before being published to renderer listeners.
- `params` must match the existing renderer event payload shape.
- Renderer-facing event names remain stable.

## Runtime Channel Normalization

V2 uses `agent:*` as the canonical remote namespace for agent runtime calls and events.

Runtime behavior:

- Outbound remote agent invokes are sent as `agent:*`.
- Inbound `agent:*` and `claude:*` agent runtime channels are accepted and normalized to the same runtime handler.
- Broadcast agent runtime events are sent as `agent:*`.
- Renderer-facing event names remain the existing local contract; normalization happens below the renderer API.
- Runtime normalization is not tied to protocol negotiation.

## Dispatch Model

Server dispatch order for invoke frames:

1. Validate auth and v2 protocol selection.
2. Read `channel` and named `params`.
3. Try Rust-native remote handling in `invoke_rust_for_remote`.
4. If Rust does not own the channel, translate the channel name to a sidecar method.
5. Call the Node sidecar compatibility bridge.

Channel to sidecar method conversion:

```text
agent:start-session -> claude.startSession
image:read-as-data-url -> image.readAsDataUrl
git:getRoot -> git.getRoot
```

Timeouts:

- Default server invoke timeout: 15 seconds.
- Long Claude session calls (`agent:start-session`, `agent:resume-session`, `agent:send-message`, `agent:fork-session`): 300 seconds.
- Client pending invoke timeout: 30 seconds.

## Current Channel Groups

App metadata:

```text
app:get-version
```

Result:

```json
{
  "version": "3.0.0",
  "protocol": "bat-remote/v2"
}
```

Remote runtime metadata:

```text
agent:get-supported-models
agent:get-supported-efforts
agent:get-supported-codex-sandbox-modes
agent:get-supported-codex-approval-policies
agent:get-supported-commands
agent:get-supported-agents
agent:get-session-state
agent:get-session-meta
agent:get-context-usage
agent:get-worktree-status
```

Claude / Codex session control:

```text
agent:start-session
agent:resume-session
agent:send-message
agent:stop-session
agent:abort-session
agent:reset-session
agent:set-model
agent:set-effort
agent:set-codex-sandbox-mode
agent:set-codex-approval-policy
```

PTY:

```text
pty:create
pty:write
pty:read-buffer
pty:resize
pty:get-viewport-state
pty:set-viewport-mode
pty:set-viewport-size
pty:kill
pty:get-cwd
pty:restart
```

Workspace / profile:

```text
workspace:load
workspace:save
profile:list
profile:get-active-ids
profile:load
profile:load-snapshot
profile:activate
profile:deactivate
```

Files, Git, GitHub, and snippets use the same `invoke` frame pattern.

## Event Allowlist

Currently expected proxied event families:

```text
pty:output
pty:exit
pty:viewport-state
agent:message
agent:tool-use
agent:tool-result
agent:stream
agent:result
agent:turn-end
agent:error
agent:status
agent:permission-request
agent:permission-resolved
agent:ask-user
agent:ask-user-resolved
agent:modeChange
agent:history
agent:resume-loading
agent:prompt-suggestion
agent:session-reset
agent:worktree-info
agent:rate-limit
fs:changed
workspace:detached
workspace:reattached
workspace:reload
system:resume
```

When adding a server broadcast event:

1. Add the event to the remote event allowlist.
2. Send named `params` matching the renderer event shape.
3. Keep the renderer event name and payload shape compatible.

## Compatibility Policy

- V2 is the canonical protocol shape.
- New requests and events use named `params`.
- Renderer-facing IPC names and event payloads remain additive-only unless a coordinated migration explicitly says otherwise.
- Protocol adapters should stay below the renderer contract.

## Checklist For Adding A Remote Capability

1. Add or update the renderer host API method.
2. Add the Tauri command or route it through an existing command.
3. If the command is remote-aware, call `remote_client.invoke(channel, params, timeout)` from the Tauri command when the current window is a remote profile.
4. Add the server-side `invoke_rust_for_remote` branch when Rust owns the capability.
5. If sidecar owns it, ensure `channel_to_sidecar_method` maps to an existing sidecar method.
6. If the capability emits events, add it to the event allowlist and emit named params.
7. Add or update tests for host API routing and remote invoke normalization.
