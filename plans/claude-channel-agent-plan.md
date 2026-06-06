# Claude Channel Agent Plan

## Strategic Reframing (2026)

Anthropic is splitting Claude Code into separate SKUs: Claude Agent SDK runs on API token billing, while Claude CLI runs on the Pro/Max subscription. A large share of BAT users want their BAT Claude Agent experience to keep running on their subscription, not on metered API tokens.

Claude Channel Agent is therefore being repromoted from "debug-only experiment" to **the alternate primary path** that keeps the Claude Agent UX while routing reasoning through the subscription-billed Claude CLI. The existing SDK path stays available for users on API billing or for SDK-only features.

This reframe changes what "MVP" means: final-text-only is no longer acceptable, because the SDK path it replaces already streams tool calls, thinking, usage, and permission prompts.

## Revised Design Goals

These are the goals every implementation decision must serve. If a goal is dropped, say so explicitly in the phase that drops it.

1. **UX parity by default.** A user who picks the Channel path must not feel they entered a worse mode. Streaming text, tool_use / tool_result, thinking blocks, usage telemetry, model / effort / permission controls — the SDK Panel's vocabulary is the target.
2. **One unified message contract.** Define a single BAT-internal agent event schema (aligned with the existing `claude:*` events emitted from `claude-send.mjs`). Both runtimes adapt to the same schema. The UI never branches on transport.
3. **Channel must carry structured frames, not just final text.** The current `bat_reply(text, status)` is the wrong shape long-term. Extend with structured tools (assistant blocks, tool_use, tool_result, thinking, usage, stop_reason) so the renderer sees the same payload either path produces.
4. **Permission relay is required, not optional.** Claude CLI's `canUseTool` decisions must round-trip to BAT's existing permission UI through the channel. Without it, `bypassPermissions` becomes the de facto default of this path and security regresses.
5. **Capability probe drives the UI, not assumptions.** Streaming, permission relay, usage telemetry, per-turn stop, model / effort / mode flags — all gated by what the detected CLI actually supports. Disable controls cleanly; never crash on missing capability.
6. **Per-turn interruption, not session kill.** Stopping the current turn must preserve the session. PTY Ctrl-C, CLI slash command, or future channel control — pick whatever works. Killing the whole CLI is a fallback, not the contract.
7. **Two panels stay separate, on purpose.** `ClaudeAgentPanel` and `ClaudeChannelAgentPanel` are kept as distinct UIs. The capability surface of the SDK path and the CLI-via-channel path will not fully converge — different controls, different telemetry, different failure modes. Maintaining two panels is cheaper than running a permanent "what does the other path support today?" decision tree inside one panel. They share the underlying message contract (goal 2) but not the rendered shell.
8. **Billing-path transparency.** The UI must visibly indicate "Subscription (CLI)" vs "API (SDK)" on the session header so users know which budget a turn spends.
9. **Session identity and history align with the SDK path.** Channel sessions enter workspace store, session list, history, archive, and remote-host ownership the same way SDK sessions do. Resume, export, and remote broadcast must keep working.
10. **Share auth and CLI resolution with the SDK path.** Reuse `claude-auth.mjs`, the CLI resolver, and the install flow. The user logs in once, installs once.
11. **Local development-channel first, plugin packaging later.** Keep the launch path simple until structured frames + permission relay are proven; only then invest in plugin distribution.
12. **Drop the BAT_DEBUG gate once stable; replace with an opt-in setting.** During implementation `BAT_DEBUG` continues to hide instability. Once parity goals 1–4 are met, expose this through a normal settings toggle (e.g. `Use Claude CLI (subscription) instead of SDK`).
13. **No regressions on the SDK path.** Per CLAUDE.md. Shared touch-points (event schema, panel, workspace store) only move in the direction of cleaner reuse — never bend the SDK path to fit channel quirks.
14. **Observability from day one.** Both ends of the channel log frames and prompt round-trips through the existing logger. CLI stderr tail stays available for diagnosing dev-channel prompts, policy rejections, login expiry.

## Path to Parity (How we get there)

Sequenced so each phase is shippable behind `BAT_DEBUG`, and each step pays down a specific goal.

- **Phase A — Structured channel frames (goals 2, 3, 14).** ✅ Done. Replaced `bat_reply` with a hybrid frame surface:
  - Dedicated tools for shape-stable, high-frequency frames: `bat_assistant`, `bat_tool_use`, `bat_tool_result`. Strict schemas.
  - Catch-all `bat_emit_frame({ kind, payload })` for `thinking`, `usage`, `result`, `status`, `error`.
  - Bridge `/frame` endpoint validates frames via `claude-channel-frames.mjs` and emits `claude-channel:*` events.
  - **Phase A retro:** the official channel protocol only supports a single "reply tool" outbound (see Channel Protocol Reality below). Asking Claude to narrate work back through `bat_assistant` / `bat_tool_use` / etc. is prompt-engineered narration outside the documented protocol. Reliable observability needed a different surface — Phase B.
- **Phase B — Hook-driven observability (goals 1, 2, 3, 14).** Use Claude Code hooks as the observability source instead of channel narration:
  - Generate a per-session `settings.json` with HTTP-type hooks for `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `MessageDisplay` / `Stop` / `StopFailure` / `SubagentStart` / `SubagentStop` / `SessionStart` / `UserPromptSubmit`, all pointing at the bridge URL.
  - Bridge `/hook/<EventName>` routes translate hook payloads into the same `claude-channel:*` events Phase A defined. Renderer is unchanged.
  - Channel MCP server instructions trim down: Claude is told observability is handled out-of-band, no need to call `bat_*` tools. The legacy tools stay registered for back-compat but are no longer recommended in `instructions`.
  - Hook is now the canonical source of truth for assistant text, tool calls, tool results, turn boundaries, and subagent lifecycle.
- **Phase C — Permission relay (goal 4).** Adopt the official `claude/channel/permission` protocol, NOT a hand-rolled tool:
  - Declare `capabilities.experimental['claude/channel/permission'] = {}` on the channel server.
  - Handle inbound `notifications/claude/channel/permission_request` (payload: `{request_id, tool_name, description, input_preview}`).
  - Emit outbound verdict via `notifications/claude/channel/permission` (`{request_id, behavior: 'allow' | 'deny'}`).
  - Plug into the existing BAT permission queue used by SDK `canUseTool`.
  - Alternative considered: `PermissionRequest` hook. Open question which one plays better with BAT's existing permission UI — to be settled when implementing.
- **Phase D — Per-turn cancel (goal 6).** Probe whether the CLI accepts a cancel signal (PTY Ctrl-C, slash command, or future channel control). Wire the existing Stop button to it. Capability flag controls UI.
- **Phase E — Session integration (goals 8, 9, 10) + transport review.** Channel sessions get the same workspace-store / history / archive treatment as SDK sessions. Add the "Subscription (CLI)" badge. Share CLI resolver and auth flow. Re-evaluate whether the bridge stays on HTTP loopback or moves to named pipe / Unix domain socket — protocol stays the same either way, this is purely a transport hardening decision.
- **Phase F — Promote out of BAT_DEBUG (goal 12).** Replace the env gate with a settings opt-in (e.g. `Use Claude CLI (subscription) instead of SDK`). Keep `BAT_DEBUG` only for diagnostic surfaces. Both panels coexist; user picks the path explicitly.

## Channel Protocol Reality (verified from official docs 2026)

What the documented `claude/channel` protocol actually gives us:
- **Inbound** (BAT → Claude): `notifications/claude/channel` with `{content, meta}`, wrapped in Claude's context as `<channel source="..." key="value">content</channel>`. Drop-and-forget; no acknowledgment.
- **Outbound** (Claude → BAT): ONE reply MCP tool. Reference impl is `reply({chat_id, text})`. Claude calls it once per turn with final text. **This is all the protocol does for outbound.**
- **Permission relay** (Claude Code → BAT, separate path): official `notifications/claude/channel/permission_request` / `notifications/claude/channel/permission`. Real protocol, not invented.

What the channel protocol does NOT give us:
- Streaming assistant text deltas.
- Tool use visibility.
- Tool result visibility.
- Thinking blocks.
- Token usage.
- Per-turn cancel.

The remote platforms in official channel examples (Telegram, Discord, fakechat) only see **the final assistant text** — the local terminal sees tool calls; the channel does not.

## Hook Protocol (the real observability surface)

Claude Code hooks fire on lifecycle events inside the CLI process and POST structured JSON to a configured handler. Used as the primary observability source from Phase B onward.

Useful hooks for BAT and what they expose:

| Hook | Payload (relevant fields) | BAT use |
| :--- | :--- | :--- |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | Render upcoming tool call |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` | Render tool result |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt`, `duration_ms` | Render tool error |
| `PostToolBatch` | `tool_calls[]` | Optional: batch parallel tool results (currently using individual PostToolUse instead) |
| `MessageDisplay` | `turn_id`, `message_id`, `index`, `final`, `delta` | Render assistant text (streamed by batches) |
| `Stop` | turn-end signal | Mark turn complete |
| `StopFailure` | `error_type`, `error_message` | Mark turn errored |
| `SubagentStart` / `SubagentStop` | `agent_id`, `agent_type` | Subagent lifecycle status |
| `SessionStart` | `model`, `source`, `agent_type` | Session metadata |
| `PermissionRequest` | `tool_name`, `tool_input`, `permission_suggestions` | Alternative to channel/permission for Phase C |

Hook configuration types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. BAT uses `http` exclusively: a per-session `settings.json` registers each hook pointing at `<bridgeUrl>/hook/<EventName>`.

## Known Limits

Even with channel + hooks combined, the following are not available to BAT and we should not promise them in UI:

- **Thinking blocks**: not exposed by either channel or hooks. The SDK path can see them; the CLI-via-channel path cannot.
- **Main-model token usage**: not exposed. `PostToolUse` for the Agent tool includes subagent usage, but the main turn's token counts are not surfaced.
- **Token-level streaming**: not available. `MessageDisplay` batches at completed lines, not individual tokens.
- **Per-turn cancel as a first-class API**: not documented. We will rely on PTY Ctrl-C or future CLI surface.

## Out of Scope

### Remote Control (`/remote`, `claude remote-control`, `claude --remote-control`)

Reviewed for observability potential and explicitly rejected:
- Mechanism: local CLI opens outbound HTTPS poll/stream to Anthropic API; claude.ai web/mobile connects to the same API; **Anthropic's servers route messages between the two**.
- Protocol: not publicly documented at the wire level. No endpoint, schema, or frame format published.
- Auth: forces `claude.ai` OAuth with a full-scope session token. API keys, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock, Vertex, Foundry all rejected.
- Traffic: traverses Anthropic cloud even though Claude runs locally. Doesn't fit BAT's "everything local, subscription billing" target.

The richer SDKMessage-like stream that claude.ai web shows almost certainly exists inside the CLI to feed Remote Control, but Anthropic only exposes it through this closed, cloud-routed surface. Hooks + channels are what we get for third parties.

## Bridge transport note

The bridge between BAT sidecar and the spawned channel MCP server currently uses HTTP loopback because:
- Claude CLI spawns the channel MCP server (via `--mcp-config`), not the sidecar — so its stdio is owned by Claude's MCP transport and Node parent-child IPC (`process.send`) is unavailable.
- The MCP server needs an out-of-band channel to BAT; environment variables carry the connection address.
- HTTP localhost is the cheapest portable choice on Windows / macOS / Linux.

Named pipe (Windows) / Unix domain socket (macOS / Linux) would be cleaner — no port allocation, no firewall prompts, per-process naming. The frame protocol (Phase A) and permission protocol (Phase C) are independent of the underlying transport, so the switch is deferred to Phase E without blocking parity work.

## Goal (legacy framing, kept for context)

Add an experimental `Claude Channel Agent` session type that keeps a Claude-agent-style workflow, but uses Claude Code Channels as the transport between Better Agent Terminal and a running Claude Code agent session.

This is not a replacement for the existing Claude SDK agent. It is a debug-only experiment that must be easy to remove if the channel approach is not viable.

> Note: the Revised Design Goals above supersede this framing. Sections below were written under the old debug-only assumption and need updating as the path-to-parity phases land. Don't treat them as authoritative when they contradict the goals.

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
