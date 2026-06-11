# Claude CLI (Subscription) Agent — Transcript-Tail Build Spec

> Hand-off spec for an implementing agent (e.g. Codex). Self-contained.
> Read alongside `plans/claude-channel-agent-plan.md` for shared vocabulary,
> but this is a **separate, simpler path** — it does NOT use channels.

## 0. One-paragraph summary

Run the **interactive** `claude` CLI in a PTY (so it bills against the user's
Pro/Max **subscription**, not metered API credits), render its native ANSI TUI
for the conversation feel, and recover full structured message classification by
**tailing the session transcript JSONL** that Claude Code already writes to disk.
Hooks (`--settings`) are used only for live control signals (tool-start spinner,
turn boundaries, permission relay) — not for content. This gives the four message
categories **you / message / tool / thinking** plus token usage, on subscription
billing.

Empirically verified on this machine (`C:\Users\User\.claude\projects`, 205
transcripts): interactive sessions persist `"type":"thinking"`,
`"type":"tool_use"`, `"type":"tool_result"`, and `"type":"text"` content blocks.
So thinking — which the channel+hooks path could not see — is available here.

## 0.1 Status — verified building blocks (2026-06-10)

These already exist, are self-contained, and are verified offline (no `claude`
spawn, no tokens) against real transcripts. Codex should ASSEMBLE these, not
rewrite them:

| File | What | Verification |
|---|---|---|
| `node-sidecar/src/runtimes/claude-cli-frames.mjs` | transcript → frames classifier (you/message/tool/thinking/usage) | 15,909 frames over 40 real transcripts: 0 exceptions, tool_use↔tool_result pairing 3566/3566, 0 orphans |
| `node-sidecar/src/runtimes/claude-cli-transcript.mjs` | `resolveProjectsDir`, `locateTranscriptBySessionId`, `createTranscriptTailer` (incremental NDJSON, byte-offset, partial-line buffering, truncation reset) | `tests/claude-cli.test.mjs` — ALL PASS |
| `node-sidecar/src/runtimes/claude-cli-capabilities.mjs` | flag probe + transcript schema-drift guard | probed real CLI 2.1.156: all flags present, `supportsTranscript:true` |
| `node-sidecar/tests/claude-cli.test.mjs` | deterministic classifier + tailer tests | ALL PASS |
| `node-sidecar/scripts/inspect-transcript-schema.mjs` | structure-only schema inspector (redacts text) | used to derive §4 |
| `node-sidecar/scripts/verify-classify-transcripts.mjs` | run classifier over real transcripts (counts only) | PASS |

| `node-sidecar/scripts/spike-live-claude-cli.mjs` | LIVE end-to-end spike: PTY spawn + trust auto-confirm + prompt injection + http-hook bridge (deny test) + concurrent transcript tail | **PASSED live** (haiku): liveness INCREMENTAL ✓, hook deny EFFECTIVE ✓ — see §11 |
| `node-sidecar/scripts/spike-debug-pty.mjs` | raw TUI dump helper for diagnosing prompt/dialog changes | used to find the no-spaces lesson (§11) |

**Phase 0 is DONE.** The live spike proved the full loop: typed prompt →
UserPromptSubmit hook → transcript user frame mid-turn → PreToolUse deny →
error tool_result → model retry → allowed → PostToolUse → Stop → final
assistant text. The spike script is the reference implementation for the
runtime's PTY/prompt/hook handling.

Still TODO for assembly: `claude-cli-runtime.mjs` (PTY spawn + bridge + wiring;
start from the spike script), `ClaudeCliAgentPanel.tsx`, host API +
registration. See §8/§10.

## 1. Why this design (billing)

From Anthropic's plan-vs-SDK policy (effective 2026-06-15): **interactive**
Claude Code (terminal/IDE) stays on subscription limits; **programmatic** use
(`claude -p`, the Agent SDK, GitHub Actions) draws from a separate metered
credit. `claude -p --output-format stream-json` would give perfect structured
output but is metered. This spec deliberately uses the **interactive** binary
(human typing in an input box) and reads only **local files + hooks**, which is
the strongest defensible "interactive use" position for subscription billing.

## 2. Goals / Non-goals

Goals (target capability):
1. Select **permission mode**, **model**, **thinking/effort** (at launch; change
   mid-session via resume-relaunch).
2. Input box: type + send (multi-line via bracketed paste).
3. Paste image: temp-file + path injection. **Best-effort; OK to degrade.**
4. Classify every message into **you / message / tool / thinking**; also surface
   token **usage**.
5. Per-turn interrupt (not session kill).
6. Stay on subscription billing.

Non-goals:
- Do not modify the SDK path (`claude-send.mjs`) or the channel path.
- Do not depend on `--dangerously-load-development-channels`, the channel MCP
  server, or the experimental `MessageDisplay` hook. (Content comes from the
  transcript, so only standard documented hooks are needed.)
- Do not try to rebuild the TUI from structured data — the ANSI terminal IS the
  conversation surface; the structured panel is an enrichment.
- Token-level streaming in the structured panel is out of scope (the ANSI pane
  provides the smooth live feel; the structured panel updates per message).

## 3. Architecture

```
                      ┌─────────────────────────────────────────────┐
 renderer             │  ClaudeCliAgentPanel                         │
 (ClaudeCliAgentPanel)│   - xterm view  (ANSI render + raw input)    │
                      │   - structured message list (you/msg/tool/   │
                      │     thinking) + usage + permission prompts    │
                      └───────────────▲───────────────▲──────────────┘
                          claude:* events │   host.claudeCli.* commands
                      ┌───────────────────┴───────────────────────────┐
 node-sidecar         │  claude-cli-runtime.mjs                        │
                      │   ├─ PTY: spawn interactive `claude`           │
                      │   │     (render bytes → renderer; write input) │
                      │   ├─ Transcript tailer  ──► claude-cli-frames  │──► claude:* (content)
                      │   └─ Hook bridge (HTTP) ──► PreToolUse/Stop/…  │──► claude:* (live + permission)
                      └───────────────────────────────────────────────┘
                                          │ spawns
                      ┌───────────────────▼───────────────────────────┐
                      │  interactive `claude`  (subscription billing)  │
                      │   writes ~/.claude/projects/<slug>/<id>.jsonl  │
                      └────────────────────────────────────────────────┘
```

**Authority split (each concern has exactly ONE source of truth):**

| Concern | Source | Notes |
|---|---|---|
| Conversation rendering, smooth streaming, free-text input, Ctrl-C | **PTY/ANSI** | Don't rebuild it |
| Content classification: you / message / tool / thinking, usage | **Transcript JSONL** | Per-message granularity |
| Live "tool starting" (before result lands), turn boundary | **Hooks** (PreToolUse, Stop/StopFailure) | Merge by `tool_use_id` |
| Permission allow/deny | **Hooks** (PreToolUse, blocking) | Routed to BAT permission UI; no keystroke injection |

## 4. Transcript JSONL contract (the core)

Path: `<configDir>/projects/<cwd-slug>/<session-id>.jsonl`, where `<configDir>`
is `~/.claude` unless `CLAUDE_CONFIG_DIR` is set. Each line is one JSON object,
appended as the turn progresses (NDJSON).

**Do not compute the slug.** Generate the session id yourself and locate the
file by filename:
- Primary: pass `--session-id <uuid>` to `claude` (VERIFY flag exists for the
  installed version), then `glob` `<configDir>/projects/**/<uuid>.jsonl`.
- Fallback (if `--session-id` unsupported): record `Date.now()` before spawn,
  then watch `<configDir>/projects/**/*.jsonl` and adopt the newest file
  created/modified after spawn.

**Envelope (fields used; ignore the rest):**
```jsonc
{ "type": "user" | "assistant" | "system" | "summary",
  "uuid": "...", "parentUuid": "...", "timestamp": "ISO",
  "message": {
    "role": "user" | "assistant",
    "model": "claude-...",          // assistant only
    "usage": { "input_tokens", "output_tokens",
               "cache_read_input_tokens", "cache_creation_input_tokens" },
    "content": "string"  |  [ <block>, ... ]
  } }
```

**Block → category mapping (classify per content block, not per line):**

| Envelope `type` | Block `type` | BAT category | FRAME_KIND |
|---|---|---|---|
| `user` | string / `text` | **you** | a dedicated `user`/`you` frame (NOT `assistant`) |
| `assistant` | `text` | **message** | `assistant` |
| `assistant` | `thinking` | **thinking** | `thinking` |
| `assistant` | `tool_use` | **tool** (call) | `tool_use` (id, name, input) |
| `user` | `tool_result` | **tool** (result) | `tool_result` (tool_use_id, content, is_error) |
| `assistant` | (message.usage) | usage | `usage` |

Critical rules:
- A `user`-role line whose content is `[{type:"tool_result",...}]` is a **tool
  result**, NOT a "you" message. Filter on block type, not envelope role.
- Pair `tool_use` ↔ `tool_result` by `tool_use_id` for the UI.
- `summary`/`system` lines: ignore (or use `system` for session metadata).
- Lines can be large and may contain base64 (images). Stream-parse; never assume
  one read == one line. Buffer until `\n`.

**Reuse:** `node-sidecar/src/runtimes/claude-channel-frames.mjs` already defines
`FRAME_KINDS` + `normalizeFrame` + per-kind normalizers. Implement
`parseTranscriptLine(line) -> Frame[]` in a new `claude-cli-frames.mjs` that maps
transcript blocks onto those kinds and reuses `normalizeFrame`. Emit the same
`claude:*` event contract the SDK path uses — read `claude-send.mjs` and match
its event names/shapes exactly (goal: renderer doesn't branch on transport).

**Tailer requirements:**
- Incremental: track byte offset; on file change, read only the new bytes.
- Robust: handle partial trailing lines, file-not-yet-created (poll until
  appears), and (defensively) truncation/rotation.
- Prefer `fs.watch` with a debounced re-read; fall back to interval polling
  (~150–300ms) where `fs.watch` is unreliable (some Windows/network FS cases).

## 5. Hooks (standard only) + permission relay

Per-session `settings.json` passed via `--settings`, with `http` hooks pointing
at a local bridge (reuse the loopback HTTP bridge pattern in
`claude-channel-runtime.mjs::createBridge`). Only these standard hooks:

| Hook | Use | Bridge behavior |
|---|---|---|
| `PreToolUse` | live "tool starting" + **permission relay** | See below |
| `Stop` / `StopFailure` | turn boundary → `turn-end` event | respond instantly |
| `SessionStart` | model/source metadata | respond instantly |
| `SubagentStart` / `SubagentStop` | subagent lifecycle status | respond instantly |

Latency discipline: **observability hooks must return immediately** (don't block
the turn). **Only the permission path blocks.**

Permission relay (no keystroke injection):
- `PreToolUse` http hook → bridge holds the HTTP response, emits a
  `claude:permission-request` event to the renderer, and waits for the user's
  decision from BAT's existing permission UI (reuse the SDK `canUseTool` queue).
- Respond with the hook's permission-decision JSON: `allow` / `deny` suppresses
  the TUI's own prompt; returning "ask"/empty defers to the TUI.
- Add a timeout (e.g. default to "ask"/defer-to-TUI) so a stuck UI never hangs
  the turn. VERIFY the exact `http` PreToolUse response schema for permission
  decisions against the installed CLI before relying on it.

## 6. Session lifecycle & controls

- **Start:** resolve CLI path + auth (reuse `claude-auth.mjs` + existing
  resolver). Generate `uuid`. Spawn interactive `claude` in PTY with:
  `--session-id <uuid>` (if supported), `--settings <hooks.json>`, and any of
  `--model`, `--permission-mode`, `--effort` the capability probe confirmed.
  cwd = workspace dir. Reuse the PTY first-run prompt auto-confirm helpers from
  `claude-channel-runtime.mjs` (trust folder, etc.) but keep them as a fallback.
- **Send text:** write to PTY stdin; for multi-line use bracketed paste
  (`\x1b[200~` … `\x1b[201~`) then submit with `\r`.
- **Send image (best-effort):** write the pasted bytes to a temp file, inject an
  `@<abs-path>` reference (VERIFY interactive attaches it as an image block).
- **Change model / mode / thinking mid-session:** kill PTY, relaunch
  `claude --resume <uuid> --model X` (or `--permission-mode` / `--effort`); the
  transcript is preserved, the tailer reattaches to the same file. VERIFY
  `--resume` applies the new flag.
- **Interrupt (per-turn):** write `\x03` (Ctrl-C) to PTY. Expose `write()` on the
  PTY handle (the channel runtime currently exposes only `kill()`).
- **Stop:** kill PTY, close bridge, stop tailer, cleanup temp dir.

## 7. Capability probe + drift guard + auto-fallback

Extend the `claude-channel-capabilities.mjs` pattern into
`claude-cli-capabilities.mjs`:
- `claude --version` → min version gate.
- `--help` includes `--model` / `--permission-mode` / `--effort` /
  `--session-id` / `--resume` → feature flags drive which UI controls are enabled.
- **Transcript schema probe:** locate a recent `*.jsonl`, parse the last few
  lines, confirm `message.content` is an array carrying known block types. If the
  shape is unrecognized → mark `supportsTranscript=false`.
- **Auto-fallback:** if start fails, the transcript file never appears, or the
  schema probe fails → automatically open a **plain `claude` terminal tab**
  (subscription, zero structured features) and surface a toast: "Structured mode
  unavailable — opened a plain Claude terminal." The user is never blocked.

## 8. File layout & integration

New files (isolated, removable):
- `node-sidecar/src/runtimes/claude-cli-runtime.mjs` — PTY + tailer + bridge.
- `node-sidecar/src/runtimes/claude-cli-frames.mjs` — `parseTranscriptLine`,
  reusing `claude-channel-frames.mjs`.
- `node-sidecar/src/runtimes/claude-cli-capabilities.mjs` — probe + drift guard.
- `node-sidecar/tests/claude-cli-runtime.test.mjs` — see Phase tests.
- `renderer/src/components/ClaudeCliAgentPanel.tsx` — xterm + structured list.
- `renderer/src/utils/claude-cli-events.ts` — event typing (mirror
  `claude-channel-events.ts`).
- `renderer/src/styles/claude-cli-agent.css`.

Reuse (do not fork): `claude-auth.mjs`, CLI resolver, `createBridge` loopback
pattern, `buildClaudeChannelHooksConfig` (trim to the hooks in §5), PTY spawn +
auto-confirm helpers, `FRAME_KINDS`/`normalizeFrame`, the `claude:*` contract,
the SDK permission queue.

Minimal shared touch-points (mirror how `claude-channel` registers):
- Runtime registration in `node-sidecar/src/server.mjs` + handler
  (`claude-cli.mjs` or extend an existing handler) for `host.claudeCli.*`.
- Tauri command passthrough (`src-tauri/src/commands/claude.rs` / `runtime.rs`)
  if a new namespace is needed.
- `runtime-catalog.json` entry (+ `pnpm run sync:runtime-catalog` if applicable).
- Session-type registration behind `BAT_DEBUG` initially (goal 12); later a
  settings toggle "Use Claude CLI (subscription)".

Runtime id: `claude-cli`. UI label: "Claude CLI Agent (Subscription)".
Show a "Subscription (CLI)" billing badge (plan goal 8).

## 9. host API / event contract

Commands (`host.claudeCli.*`): `start`, `sendMessage`, `sendImage`,
`setModel`/`setMode`/`setEffort` (resume-relaunch), `interrupt`, `stop`,
`getStatus`, `getCapabilities`, `respondPermission`.

Events — emit the **existing** `claude:*` shapes (align with `claude-send.mjs`):
`message` (user/you), `assistant`, `thinking`, `tool-use`, `tool-result`,
`usage`, `status`, `turn-end`, `permission-request`. Renderer reuses the SDK
panel's rendering vocabulary.

## 10. Phases (each shippable behind BAT_DEBUG)

- **Phase 0 — Spike (gates everything). VERIFY the unknowns in §11.** A throwaway
  script: spawn interactive `claude --session-id <uuid> --settings <hooks>`, tail
  the transcript, log classified frames; hit a tool to confirm tool_use/result;
  trigger thinking to confirm thinking blocks appear live; PreToolUse http hook
  returns `deny` and confirm the tool is blocked. Do not build UI yet.
- **Phase 1 — Runtime + PTY + ANSI + text input.** Working interactive terminal
  in `ClaudeCliAgentPanel`, driven from the app, on subscription. No
  classification yet.
- **Phase 2 — Transcript tailer + classifier.** `claude-cli-frames` →
  you/message/tool/thinking/usage as `claude:*` events → structured list renders.
- **Phase 3 — Hooks bridge.** PreToolUse "tool starting" merge-by-id, Stop turn
  boundary, permission relay into BAT permission UI.
- **Phase 4 — Controls.** model/mode/thinking selectors (launch + resume),
  interrupt (Ctrl-C), image paste (temp file + `@path`).
- **Phase 5 — Integration + hardening.** Workspace store / history / fast-switch
  (multiple warm sessions; switch xterm buffer + panel; metadata from frames),
  "Subscription" badge, schema-drift guard + auto-fallback, transport hardening
  (named pipe / UDS instead of loopback HTTP, optional).

## 11. Unknowns to VERIFY (status as of 2026-06-10, CLI 2.1.156)

1. ✅ **CONFIRMED (live)** `--session-id <uuid>` works end-to-end: the spike
   located `<projects>/<slug>/<uuid>.jsonl` ~100ms after `UserPromptSubmit`.
2. ✅ **CONFIRMED (live)** Transcript is appended **incrementally during the
   turn**: user frame at 5.2s, tool frames at 8.0s/10.0s, Stop at 11.5s.
   Granularity: per message/block batch (~150ms tail poll was plenty).
3. 🟡 **PARTIAL** `--resume` and `--fork-session` flags exist (probe). Still
   verify a new `--model`/`--permission-mode`/`--effort` passed with `--resume`
   actually takes effect.
4. ✅ **CONFIRMED (live)** `http` PreToolUse hook permission relay works in
   interactive mode with NO keystroke injection: bridge responded
   `{decision:'block', reason, hookSpecificOutput:{hookEventName:'PreToolUse',
   permissionDecision:'deny', permissionDecisionReason}}` → tool was blocked,
   transcript recorded `tool_result(is_error:true)`, model retried, second call
   answered `{}` (no opinion) ran normally (`PostToolUse` fired). Hooks seen
   live: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`.
   Note: explicit `allow` suppressing the TUI permission prompt for
   normally-prompting tools (e.g. Write) is still untested — verify when wiring
   the permission queue.
5. ✅ **CONFIRMED** `--effort` exists (probe).
6. ⏳ **PENDING (best-effort; OK to degrade)** Interactive image attach via
   `@<path>` produces an image content block.
7. ✅ **CONFIRMED** `message.usage` present on every assistant transcript line
   (verified across 40 real transcripts + live; usage frames emitted).

Spike harness: `node-sidecar/scripts/spike-live-claude-cli.mjs` (full loop) and
`spike-debug-pty.mjs` (raw TUI dump). Cost per run: one short haiku turn.

### Hard-won TUI lessons (bake into the runtime)

- **Stripped ANSI has no spaces.** The TUI positions glyphs with cursor moves,
  so after stripping escapes the text collapses ("Isthisaprojectyoucreated…").
  ALL prompt-detection matching must collapse whitespace on both sides
  (e.g. match `trustthisfolder`). The channel runtime's space-containing
  matchers ("trust this folder") silently never match.
- **Verify the input-box echo before submitting.** Keystrokes typed while a
  dialog (trust, etc.) is up are silently swallowed. Type the prompt, wait until
  the collapsed output echoes a needle from it, then send `\r`; retype if the
  echo doesn't appear within ~2s.
- Trust dialog: option 1 is preselected; a bare `\r` confirms ("Enter to
  confirm"), retried once 400ms later.

## 12. Verification (per CLAUDE.md)

- `pnpm exec tsc --noEmit --pretty false`
- `pnpm run compile`
- `pnpm run test:sidecar`
- `pnpm run check:tauri-rust` (if Tauri commands/runtime resolution touched)
- Manual: with `BAT_DEBUG=1`, confirm the mode is hidden without `BAT_DEBUG`;
  confirm a tool call shows tool_use→tool_result paired; confirm thinking renders;
  confirm permission prompt routes to BAT UI; confirm stop doesn't affect SDK or
  channel sessions; confirm auto-fallback opens a plain terminal on probe failure.

## 13. Risks

- **Billing classification** of an app-driven interactive session is strong but
  **unconfirmed** by Anthropic. The auto-fallback to a plain terminal is the
  strategic floor if it is ever reclassified.
- **Transcript JSONL is an internal format**, not a public API. The schema-drift
  guard (§7) + auto-fallback are mandatory, not optional.
- First-run PTY prompts (folder trust) rely on brittle text matching; pre-trust
  where possible and treat auto-confirm as fallback.
- Hook latency: keep observability hooks non-blocking; only permission blocks,
  with a timeout.
