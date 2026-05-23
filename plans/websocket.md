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
- Frame encoding: one JSON object per WebSocket message. Uncompressed connections use text frames. Compressed connections use BAT gzip binary frames after authentication.

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
  "compression": ["gzip"],
  "args": ["Client Label", { "windowId": "optional-window-id" }]
}
```

Server success response:

```json
{
  "type": "auth-result",
  "id": "1700000000000-auth",
  "result": true,
  "protocol": "bat-remote/v2",
  "compression": "gzip"
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
- `compression` is optional. Omitted or unsupported values mean `none`.
- New BAT clients should advertise `["gzip"]`. Legacy clients do not advertise compression and remain fully uncompressed.
- `auth` and `auth-result` are always uncompressed text frames. After a successful `compression: "gzip"` auth result, every following BAT frame on that connection is sent as a gzip binary frame. There is no per-message threshold.
- `args[0]` is the client label displayed in server status.
- `args[1].windowId` is optional and recorded in the server connected-client list when present.

## Compression

Compression is negotiated at the BAT protocol layer, not with WebSocket `permessage-deflate`.

Supported compression ids:

```text
gzip
```

Negotiation:

1. Client sends `auth` as an uncompressed text JSON frame.
2. New clients include `compression: ["gzip"]`.
3. Legacy clients omit `compression`; this is equivalent to `compression: []`.
4. Server selects `gzip` only when the offered list contains `gzip`.
5. Server sends `auth-result` as an uncompressed text JSON frame with the selected compression:

```json
{
  "type": "auth-result",
  "id": "1700000000000-auth",
  "result": true,
  "protocol": "bat-remote/v2",
  "compression": "gzip"
}
```

If no supported compression is selected, the server uses:

```json
{
  "type": "auth-result",
  "id": "1700000000000-auth",
  "result": true,
  "protocol": "bat-remote/v2",
  "compression": "none"
}
```

Binary frame envelope for compressed frames:

```text
BATGZIP1\0<gzip-compressed-json-bytes>
```

Wire layout:

```text
offset  size  content
0       8     ASCII magic bytes: 42 41 54 47 5A 49 50 31 ("BATGZIP1")
8       1     NUL byte: 00
9       n     gzip-compressed UTF-8 JSON object bytes
```

Rules:

- Compression is explicit opt-in. A client that does not send `compression: ["gzip"]` receives and sends only text JSON frames.
- When `gzip` is negotiated, all post-auth BAT frames are gzip binary frames in both directions.
- When `none` is negotiated, all BAT frames remain uncompressed WebSocket text frames.
- There is no per-message compression threshold. The connection either compresses every post-auth BAT frame or none of them.
- A compressed binary frame without the `BATGZIP1\0` prefix is invalid.
- An uncompressed text frame received after `gzip` negotiation is invalid for protocol purposes and should be ignored or treated as a connection error by implementations.
- A compressed binary frame received after `none` negotiation is invalid for protocol purposes and should be ignored or treated as a connection error by implementations.
- `auth` and `auth-result` stay text JSON so negotiation is always readable by old clients and diagnostic tooling.

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
agent:get-supported-session-types
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

`agent:get-supported-session-types` returns the host-supported session creation type ids, such as
`none`, `claude-code`, `claude-cli`, `codex-agent`, and worktree variants. Remote clients must use
this host response to decide which add-session actions to show; they should not infer supported
session types from local renderer code. `agent:list-presets` is kept as a compatibility alias.

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
agent:list-sessions
profile:list
profile:get-active-ids
profile:load
profile:load-snapshot
profile:activate
profile:deactivate
```

Files, Git, GitHub, and snippets use the same `invoke` frame pattern.

## Host-Owned State Sync

The host is the source of truth for shared remote state. Remote clients may request changes, but the host must apply the change first and then broadcast the resulting state or invalidation event to every connected client.

General principle:

- Except for purely local presentation state, clients do not own remote state.
- Message filters are client-only presentation state. They may be applied locally without host round trips because they do not change host data.
- All other actions must be sent to the host as `invoke` frames.
- The host executes or rejects the requested action, then returns an `invoke-result` / `invoke-error`.
- When the action changes shared state, the host broadcasts the canonical result or an invalidation event back to all connected clients.
- Clients should render the host response/reflection, not their own optimistic final state. Temporary local loading/pending UI is allowed while waiting for host confirmation.

Workspace state:

- `workspace:load` returns the current host workspace JSON for the selected remote profile.
- `workspace:save` is client-to-host. A client must not assume its local state is accepted until the host returns success.
- After a successful `workspace:save`, the host broadcasts `workspace:reload` with the saved workspace JSON.
- Clients receiving `workspace:reload` must replace/reload their workspace state from the payload.
- Host-side window/workspace changes that affect the serialized workspace view should also broadcast `workspace:reload`.

Profile/window state:

- `profile:list` and `profile:get-active-ids` always read from the host.
- Host-side profile/window changes, including opening a profile window, closing the last window for a profile, activating/deactivating profiles, creating, updating, renaming, deleting, duplicating, or remote workspace saves that activate a profile, broadcast `profile:changed`.
- Profile creation is reflected by `profile:changed`; clients should add it to profile lists only after it appears in the host payload.
- Profile deletion is reflected by `profile:changed`; clients should remove it from profile lists when absent from the host payload.
- If the remote profile backing the current client window is deleted or becomes inaccessible, the client must stop mutating that profile, show a disconnected/unavailable state, and require the user to select another profile or reconnect. It must not keep writing to the deleted profile id.
- If a profile remains present but is no longer active, clients may keep an already-open view read/write-capable only if the host continues accepting its invokes. Profile list UI must still display the host's active state from `activeProfileIds`.
- `profile:changed` payload:

```json
{
  "profiles": [
    {
      "id": "default",
      "name": "Default",
      "type": "local",
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000
    }
  ],
  "activeProfileIds": ["default"]
}
```

- Clients that display profile/window lists should refresh from the host when they receive `profile:changed`.

Workspace lifecycle:

- Workspace creation, deletion, reorder, rename, group changes, terminal add/remove, and window detach/reattach are host-owned workspace mutations.
- Clients request these mutations through the relevant invoke path, usually ending in `workspace:save` or a workspace/window command.
- After the host accepts a workspace mutation, it broadcasts `workspace:reload` with the canonical serialized workspace state for that profile/window scope.
- Clients must reconcile local UI to the `workspace:reload` payload.
- If the currently selected workspace is removed in the host payload, the client must switch to the payload's `activeWorkspaceId` when present.
- If no `activeWorkspaceId` is present and workspaces remain, the client should select the first host-provided workspace.
- If no workspaces remain, the client should show an empty workspace state and wait for the user/host to create a workspace. It must not continue sending terminal/session actions tied to the removed workspace.
- If the currently selected terminal/session panel is removed from the host workspace payload, the client must close that panel locally and stop sending actions for the removed terminal/session id.

Session lists:

- `agent:list-sessions` returns the host's current session list for the requested `cwd` and optional agent kind.
- Session list UI must fetch from the host when the client switches into the list view. Clients should not rely on cached session lists.
- Session mutations remain host-owned. If a future session-list invalidation event is added, clients should still re-fetch with `agent:list-sessions` when opening the list.
- A session appearing in the list means the host can offer it for resume/restore. Clients should not invent list entries locally.
- A session absent from the latest host list should be removed from the visible list.
- If the user is viewing a resume list and the selected session disappears before selection, the client should disable/remove that row and require a fresh selection.
- If the currently open running session is stopped/aborted/removed by the host, the host should emit the corresponding agent status/error/turn-end event. The client must stop accepting input for that session until it receives or requests a fresh host-owned session state.

Required remote implementation behavior:

```text
host profile created/updated/deleted/activated/deactivated
  -> host broadcasts profile:changed
  -> client refreshes any visible profile/window list from host payload or profile:list
  -> if current backing profile is gone, client enters unavailable state and stops profile mutations

client requests profile/window mutation
  -> client sends invoke to host
  -> host applies or rejects
  -> host returns invoke-result/invoke-error
  -> on success host broadcasts profile:changed when profile/window membership changed
  -> all clients render host-reflected state

host workspace changed
  -> host broadcasts workspace:reload with canonical workspace JSON
  -> client applies payload, preserving only local presentation state
  -> if active workspace/terminal/session no longer exists, client exits that view and selects host fallback when available

client requests workspace mutation
  -> client sends invoke to host, commonly workspace:save
  -> host writes canonical state or rejects
  -> host returns invoke-result/invoke-error
  -> on success host broadcasts workspace:reload
  -> all clients apply the host payload

client opens session/resume list
  -> client invokes agent:list-sessions against host
  -> host returns current list
  -> client renders that list and discards stale local entries

host session state changed
  -> host emits the existing agent event family such as agent:status, agent:error, agent:turn-end, agent:history, or agent:resume-loading
  -> client updates the open session from the host event
  -> if the session is no longer usable, client disables input until a new host-owned session is selected or created
```

Implementation notes:

- `profile:changed` is the profile/window list invalidation and reflection event.
- `workspace:reload` is the workspace reflection event.
- Session lists are pull-based today: opening the list must call `agent:list-sessions`.
- Existing agent runtime events remain the session-state reflection mechanism.
- Message filter state is the exception: it is client-only and is not sent to the host.

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
profile:changed
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
