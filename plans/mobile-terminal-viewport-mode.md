# Mobile Terminal Viewport Mode Plan

## Problem

The same PTY session may be rendered by both the desktop app and the Android remote client. A PTY has one effective `cols` / `rows` size, and many terminal programs format output based on that size. If the desktop viewport is 120+ columns while the phone viewport is around 40-60 columns, allowing both sides to resize the same PTY causes unstable rendering:

- Desktop and mobile can fight over `pty:resize`.
- Output layout changes unexpectedly when the other device opens the terminal.
- Mobile can make the desktop terminal narrow without clear user intent.
- Desktop-sized terminal output is hard to read on a phone.

The goal is to introduce an explicit terminal viewport mode so both desktop and mobile agree on one PTY layout.

## Design

Treat "mobile mode" as a shared viewport profile, not as device ownership.

```ts
type TerminalViewportMode = 'desktop' | 'mobile'

interface TerminalViewportState {
  mode: TerminalViewportMode
  cols: number
  rows: number
  updatedBy: 'desktop' | 'mobile'
  updatedAt: number
}
```

### Modes

`desktop`

- Default mode.
- Desktop terminal container is the source of PTY resize.
- Mobile may render, scroll, zoom, and send input, but must not resize the PTY automatically.
- Mobile UI should show that the terminal is using desktop layout and offer a switch to mobile layout.

`mobile`

- A shared phone-width layout profile.
- Either desktop or mobile may switch the terminal into mobile mode.
- The PTY is resized to mobile-friendly dimensions.
- Desktop renders the terminal using the same mobile-sized layout, for example in a narrow terminal frame.
- Mobile and desktop both see the same terminal buffer with the same wrapping behavior.

There is intentionally no detached/mobile-owned shell in this plan. A separate mobile shell adds lifecycle and list complexity without much value once shared mobile layout exists.

## Resize Rules

Only one resize policy should be active for a PTY at a time.

- If `mode === 'desktop'`, desktop layout resize may call `pty:resize`.
- If `mode === 'mobile'`, the mobile profile size may call `pty:resize`.
- Mobile opening a desktop-mode terminal must not call `pty:resize`.
- Desktop opening a mobile-mode terminal must not call desktop fit resize until the mode is changed back to `desktop`.
- Switching modes should send exactly one authoritative `pty:resize` after the mode state is stored.

Recommended mobile profile defaults:

```ts
const MOBILE_TERMINAL_COLS = 56
const MOBILE_TERMINAL_ROWS = 24
```

The mobile app may compute a better value from font metrics, but it should still be stored as the shared viewport state so desktop renders the same size.

## Remote Protocol

Add host APIs:

```ts
pty:get-viewport-state(id): TerminalViewportState
pty:set-viewport-mode(id, mode, options?)
pty:set-viewport-size(id, cols, rows, source)
```

Suggested `set-viewport-mode` options:

```ts
interface SetViewportModeOptions {
  cols?: number
  rows?: number
  source: 'desktop' | 'mobile'
}
```

Events:

```ts
pty:viewport-state
```

Payload:

```ts
{
  id: string
  state: TerminalViewportState
}
```

Legacy remote argument mapping must include the new calls so Android legacy invoke frames do not collapse to the first argument.

## Desktop Implementation

### State

Store viewport state next to PTY session state. This can be in `PtyState` if it is purely runtime, or in terminal metadata if the mode should survive app reload.

Recommended first version: runtime state in `PtyState`, defaulting to desktop.

```rust
struct PtySession {
    ...
    viewport_mode: TerminalViewportMode,
    viewport_cols: u16,
    viewport_rows: u16,
    viewport_updated_by: String,
    viewport_updated_at: u64,
}
```

If the desktop UI needs to know the mode before PTY creation, mirror the state into terminal metadata later.

### Commands

Add Tauri commands and remote dispatch branches:

- `pty_get_viewport_state`
- `pty_set_viewport_mode`
- `pty_set_viewport_size`

`pty_set_viewport_mode(id, "mobile", options)` should:

1. Store mode as mobile.
2. Resolve `cols` / `rows` from options or mobile defaults.
3. Call the existing PTY resize implementation with those dimensions.
4. Emit `pty:viewport-state`.

`pty_set_viewport_mode(id, "desktop", options)` should:

1. Store mode as desktop.
2. Let the desktop terminal view perform its next fit resize.
3. Optionally resize immediately if desktop cols / rows are provided.
4. Emit `pty:viewport-state`.

### Desktop UI

In desktop terminal detail:

- Show a visible badge: `Desktop Layout` or `Mobile Layout`.
- Add action: `Use Mobile Layout` / `Use Desktop Layout`.
- When in mobile layout:
  - Render xterm in a narrow mobile-width container that corresponds to the shared cols.
  - Do not let desktop FitAddon resize PTY to full desktop width.
  - Keep desktop input enabled.
- When switching back to desktop layout:
  - Restore normal full-width terminal.
  - FitAddon sends desktop `pty:resize`.

The desktop should make it obvious why the terminal is narrow when mobile layout is active.

## Android Implementation

### Terminal Open Behavior

On opening a terminal:

1. Call `pty:create` if needed.
2. Call `pty:get-viewport-state`.
3. Render badge based on viewport mode.
4. If mode is desktop, do not send WebView resize as `pty:resize`.
5. If mode is mobile, use the shared state dimensions and allow mobile-profile resize updates.

### UI

Top area should show:

- Workspace name.
- Terminal title.
- Badge: `Desktop Layout` / `Mobile Layout`.
- Button: `Use Mobile Layout` / `Use Desktop Layout`.

When in desktop layout:

- Treat the terminal as a desktop-sized mirror.
- Support horizontal pan or fit-to-width rendering.
- Input is allowed.
- Resize is not sent.

When in mobile layout:

- Render using the shared mobile cols / rows.
- Input is allowed.
- Resize may be sent only through `pty:set-viewport-size`, not raw `pty:resize`, so the shared state stays authoritative.

## Minimal Implementation Sequence

1. Fix remote PTY support so Android `pty:create/write/resize` reaches Rust PTY handlers instead of sidecar.
2. Stop Android from automatically sending `pty:resize` when opening an existing desktop terminal.
3. Add `TerminalViewportState` runtime model on desktop.
4. Add remote commands and event:
   - `pty:get-viewport-state`
   - `pty:set-viewport-mode`
   - `pty:set-viewport-size`
   - `pty:viewport-state`
5. Add desktop UI badge and mobile-layout narrow render.
6. Add Android UI badge and layout switch.
7. Add tests for protocol mapping and resize ownership.

## Tests

Protocol tests:

- Legacy args map correctly for:
  - `pty:get-viewport-state(id)`
  - `pty:set-viewport-mode(id, mode, options)`
  - `pty:set-viewport-size(id, cols, rows, source)`
- Remote invoke dispatch handles the new commands without falling back to sidecar.

Desktop behavior tests:

- Desktop mode allows desktop fit resize.
- Desktop mode ignores mobile WebView resize.
- Mobile mode applies mobile cols / rows.
- Mobile mode prevents desktop full-width fit resize from changing PTY size.
- Switching back to desktop mode allows desktop fit resize again.

Android behavior tests:

- Opening a desktop-mode terminal does not send `pty:resize`.
- Pressing `Use Mobile Layout` calls `pty:set-viewport-mode(..., 'mobile')`.
- Receiving `pty:viewport-state` updates badge and render strategy.
- Pressing `Use Desktop Layout` calls `pty:set-viewport-mode(..., 'desktop')`.

Manual validation:

1. Open terminal on desktop in desktop layout.
2. Open same terminal on Android.
3. Confirm Android does not change desktop wrapping.
4. Switch to mobile layout from Android.
5. Confirm desktop terminal becomes mobile-width and Android output matches desktop output.
6. Send input from both desktop and Android.
7. Switch back to desktop layout.
8. Confirm desktop terminal returns to full width.

## Open Questions

- Should viewport mode persist across app restart, or reset to desktop?
- Should mobile cols be fixed, or computed from the current Android device width and font size?
- Should rows matter for shared layout, or only cols?
- Should multiple mobile devices share the same mobile profile, or should the latest mode switch update the profile?

Recommended defaults:

- Reset to desktop on new PTY creation.
- Persist mode only while the PTY session is alive.
- Start with fixed `56x24` mobile profile.
- Later add user-configurable mobile font size and cols.
