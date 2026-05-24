# Claude Channel Agent Plan

## Goal

Add an experimental `Claude Channel Agent` session type that keeps a Claude-agent-style workflow, but uses Claude Code Channels as the transport between Better Agent Terminal and a running Claude Code agent session.

This is not a replacement for the existing Claude SDK agent. It is a debug-only experiment that must be easy to remove if the channel approach is not viable.

## Product Shape

- UI label: `Claude Channel Agent`
- Internal session type: `claude-channel`
- Runtime id: `claude-channel`
- Visibility: `BAT_DEBUG` only
- Stability: experimental
- Primary framing: channel is the transport, Claude Code is still the agent

The user should experience it as a separate session UI, not as a branch inside the current Claude Agent panel. The UI can look familiar, but it should make channel-specific behavior visible.

## Source Docs

- Remote Control docs: https://code.claude.com/docs/zh-TW/remote-control
- Channels docs: https://code.claude.com/docs/zh-TW/channels
- Channels reference: https://code.claude.com/docs/zh-TW/channels-reference

Relevant constraints from the docs:

- Remote Control drives a local Claude Code session from Claude web or mobile. It is not the primary protocol for embedding BAT's own UI.
- Channels push external events into a running Claude Code agent session.
- A channel is an MCP server spawned by Claude Code and connected over stdio.
- The channel server declares `capabilities.experimental['claude/channel']`.
- Events are sent through `notifications/claude/channel`.
- Claude can reply through a normal MCP tool exposed by the channel server.
- Custom channels are research-preview functionality and may require development flags during local testing.

## Non-Goals

- Do not replace the existing Claude SDK runtime.
- Do not mix channel transport code into existing SDK handlers such as `claude-send.mjs`.
- Do not promise feature parity with the current Claude Agent.
- Do not expose this outside `BAT_DEBUG` until the runtime semantics are proven.
- Do not rely on parsing human-oriented TUI text as the primary protocol.

## High-Level Architecture

```text
ClaudeChannelAgentPanel
  -> host.claudeChannel.*
  -> node-sidecar claude-channel runtime
  -> launches claude with --channels / development channel flags
  -> Claude Code spawns BAT channel MCP server
  -> BAT UI prompt becomes notifications/claude/channel
  -> Claude Code agent handles the event
  -> Claude replies with BAT channel reply tool
  -> BAT runtime emits UI events for ClaudeChannelAgentPanel
```

Channel remains an ingress/egress mechanism. The actual reasoning and tool execution still belongs to the Claude Code agent session.

## File Isolation

Keep implementation under clearly named files so the experiment can be removed cleanly.

Suggested files:

- `renderer/src/components/ClaudeChannelAgentPanel.tsx`
- `renderer/src/components/ClaudeChannelSessionHeader.tsx`
- `renderer/src/styles/claude-channel-agent.css`
- `renderer/src/utils/claude-channel-events.ts`
- `node-sidecar/src/runtimes/claude-channel-runtime.mjs`
- `node-sidecar/src/runtimes/claude-channel-server.mjs`
- `node-sidecar/src/runtimes/claude-channel-capabilities.mjs`
- `node-sidecar/tests/claude-channel-runtime.test.mjs`

Minimal shared integration points:

- Session type registration behind `BAT_DEBUG`
- Host API namespace for `claudeChannel`
- Workspace/session store fields only if needed to persist the new session type

## Debug Gate

The feature must be invisible unless `BAT_DEBUG` is enabled.

Gate these surfaces:

- New session creation option
- Session type registration
- Host API calls if possible
- Sidecar runtime registration
- Any settings or capability UI

If `BAT_DEBUG` is off, existing app behavior should be unchanged.

## Runtime Behavior

The runtime manages a Claude CLI process with channel support enabled.

Initial launch strategy:

```text
claude --dangerously-load-development-channels server:bat
```

Later package/plugin strategy:

```text
claude --channels plugin:bat@better-agent-terminal
```

The first version should favor local development channel mode to avoid committing to a plugin packaging story too early.

The runtime is responsible for:

- Resolving the Claude CLI path through the existing runtime resolver where possible.
- Verifying the CLI supports channels.
- Spawning and stopping the Claude process.
- Starting or coordinating the BAT channel MCP server.
- Delivering BAT prompts as channel events.
- Receiving reply tool calls from Claude and turning them into UI messages.
- Logging debug details through existing project logging helpers.

## BAT Channel Server

The BAT channel server should be an MCP server with:

- `capabilities.experimental['claude/channel']`
- `capabilities.tools` for the reply path
- Clear instructions telling Claude:
  - BAT messages arrive as `<channel source="bat" ...>`.
  - Treat them as user instructions for this agent session.
  - Use the BAT reply tool to send visible responses back to BAT.
  - Include routing metadata such as `session_id` or `message_id` when replying.

Suggested channel event shape:

```json
{
  "content": "User prompt text",
  "meta": {
    "bat_session_id": "session-id",
    "bat_message_id": "message-id",
    "workspace_id": "workspace-id"
  }
}
```

Suggested reply tool input:

```json
{
  "bat_session_id": "session-id",
  "bat_message_id": "message-id",
  "text": "Claude response text",
  "status": "final"
}
```

Streaming can be added later if the reply path can reliably emit partial responses. The MVP can be final-message based.

## UI Behavior

Create a separate `ClaudeChannelAgentPanel`.

The first version should show:

- Experimental badge
- CLI/channel status
- Current Claude CLI path and detected version
- Whether channel capability probe passed
- Prompt input and response history
- Stop button for the whole channel session
- Model/mode controls only when capabilities are known

Do not force this UI to match every current Claude Agent control. It should expose the channel runtime's real capabilities.

## Capability Model

Use capability detection instead of assuming parity.

Suggested capability shape:

```ts
type ClaudeChannelCapabilities = {
  supported: boolean
  cliVersion: string | null
  supportsChannels: boolean
  supportsModel: boolean
  supportsPermissionMode: boolean
  supportsThinkingEffort: boolean
  supportsCompactWindow: boolean
  supportsStopTask: boolean
  supportsStreaming: boolean
}
```

Initial expected support:

- `supportsChannels`: required
- `supportsModel`: likely, but must be probed
- `supportsPermissionMode`: maybe
- `supportsThinkingEffort`: maybe
- `supportsCompactWindow`: unknown; do not promise in MVP
- `supportsStopTask`: probably false for MVP
- `supportsStreaming`: probably false or limited for MVP

UI controls should disable unsupported capabilities with clear tooltips.

## Session Semantics

This session type should not reuse the existing Claude SDK session object internally.

It can reuse presentation patterns, but channel-specific state should remain separate:

```ts
type ClaudeChannelSession = {
  id: string
  workspaceId: string
  cwd: string
  status: 'starting' | 'ready' | 'running' | 'stopped' | 'error'
  cliPath: string | null
  cliVersion: string | null
  channelStatus: 'unknown' | 'connecting' | 'connected' | 'disconnected'
  messages: ClaudeChannelMessage[]
  capabilities: ClaudeChannelCapabilities
}
```

Stop semantics:

- MVP stop kills or interrupts the whole Claude CLI/channel session.
- Do not claim sub-agent `stopTask` parity.
- If a future CLI/channel control supports task-level cancellation, add it behind capability detection.

## Open Questions

- Can the channel reply tool provide incremental partial responses, or only final responses?
- Which Claude CLI versions expose stable model/mode/thinking controls through flags or commands?
- Can permission relay be used cleanly enough for BAT to approve/deny prompts in the app?
- Should the BAT channel server communicate with the sidecar over localhost HTTP, stdio, Unix socket, or an in-process bridge?
- How should channel sessions interact with existing workspace persistence and archive/history?
- Can we package this as a Claude plugin later without requiring Bun for BAT users?

## Implementation Phases

### Phase 1: Probe and Skeleton

- Add `BAT_DEBUG` gated session type registration.
- Add empty `ClaudeChannelAgentPanel`.
- Add sidecar runtime skeleton with capability probe.
- Detect Claude CLI version and channels support.
- No message sending yet.

### Phase 2: Local Development Channel

- Implement `claude-channel-server.mjs` as a development MCP channel.
- Launch Claude with development channel flag.
- Send BAT prompt as `notifications/claude/channel`.
- Receive final reply through a reply tool.
- Render final replies in the new UI.

### Phase 3: Controls and Lifecycle

- Add stop/restart lifecycle controls.
- Add capability-gated model/mode controls.
- Add robust logs and user-facing error states.
- Handle CLI missing, unsupported version, not logged in, and channel policy disabled.

### Phase 4: Hardening

- Add tests for capability probe, message routing, and process lifecycle.
- Add recovery behavior for dropped CLI process.
- Evaluate permission relay.
- Evaluate plugin packaging only after the development-channel path works.

## Verification

For implementation work, run the relevant project checks:

- `pnpm exec tsc --noEmit --pretty false`
- `pnpm run compile`
- `pnpm run test:sidecar`
- `pnpm run check:tauri-rust` if Tauri commands or runtime resolution are touched

For the channel experiment specifically:

- Start with `BAT_DEBUG=1`.
- Confirm `Claude Channel Agent` does not appear without `BAT_DEBUG`.
- Confirm a missing or unsupported Claude CLI produces a clear error.
- Confirm a prompt reaches Claude as a channel event.
- Confirm Claude's reply tool result appears in the BAT UI.
- Confirm stop kills the channel session without affecting existing Claude SDK sessions.
