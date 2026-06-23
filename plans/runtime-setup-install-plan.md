# Runtime Setup Install Plan

## Goal

Move BAT toward setup-time runtime installation without breaking current Tauri
releases. Codex, Claude Code / Claude Agent SDK native runtime, and Node should
be reusable across app updates when the user already has a working runtime.

This migration should happen across several pre-release tags. Each step should
be observable and reversible before bundled runtimes are removed from any build.

## Product Rules

- Prefer a working user-managed PATH runtime when present.
- PATH runtime checks should be intentionally shallow:
  - `node --version` exits successfully.
  - `codex --version` exits successfully.
  - `claude --version` exits successfully.
- Do not require PATH runtime versions to match BAT's catalog.
- Do not run login, network, model list, or agent protocol checks during setup.
- Diagnostics must show `source=system`, path, and detected version for PATH
  runtimes.
- BAT-managed downloads must still be pinned by exact URL and SHA-256.
- BAT-managed installs live under app-data and are validated before activation.
- Remote clients do not install local runtimes for remote sessions. Runtime
  status for remote sessions is host-owned and reported by the host.
- Windows and macOS arm64 must offer both all-in-one builds and lightweight
  setup-install builds.

## Build Modes

BAT should support two packaging modes:

1. All-in-one
   - Includes Node, Codex, and Claude native runtimes in the app bundle.
   - Required release artifact for Windows.
   - Required release artifact for macOS arm64.
   - Remains the lowest-friction install path.

2. Lightweight
   - Includes minimal app resources.
   - Uses app-data managed runtimes or PATH runtimes.
   - Missing runtime prompts appear during first-run setup.
   - Required release artifact for Windows after the setup flow is stable.
   - Required release artifact for macOS arm64 after the setup flow is stable.

The runtime resolver should work for both modes. All-in-one builds are simply
expected to resolve `bundled` when `managed` and `system` are unavailable.

Artifact naming should make the choice explicit:

```text
BetterAgentTerminal.Setup.<version>.all-in-one.exe
BetterAgentTerminal.Setup.<version>.lightweight.exe
BetterAgentTerminal-<version>-arm64.all-in-one.dmg
BetterAgentTerminal-<version>-arm64.lightweight.dmg
```

The exact naming can follow the existing release asset conventions, but
`all-in-one` and `lightweight` must be visible in the asset name.

## Implemented Build Split

The first implementation step is a packaging split that can be exercised across
pre-release tags before runtime setup changes are enabled.

- `src-tauri/tauri.conf.json` is the lightweight base config.
- `src-tauri/tauri.all-in-one.conf.json` overlays bundled runtime resources.
- `scripts/tauri-build-mode.mjs --mode all-in-one` builds with the overlay.
- `scripts/tauri-build-mode.mjs --mode lightweight` builds with only the base
  config.
- `pnpm run tauri:build:*:all-in-one` keeps the previous self-contained bundle
  behavior.
- `pnpm run tauri:build:*:lightweight` produces a runtime-separated app bundle.
- Pre-release GitHub Actions build Windows x64 and macOS arm64 in both modes.
- Release asset normalization appends `.all-in-one` or `.lightweight` to split
  artifacts.

## Runtime Sources

Resolution order:

1. `managed`: app-data runtime installed by BAT.
2. `system`: user-managed PATH runtime.
3. `bundled`: runtime shipped inside the app resources.
4. `missing`: setup prompt can install BAT-managed runtime when available.

The order intentionally puts PATH before bundled so users who already maintain
their own runtime can avoid the bundled copy. If this creates regressions during
pre-release testing, the order can be switched to `managed -> bundled -> system`
without changing the status API shape.

## App-Data Layout

Managed runtimes live under the active Tauri app-data directory:

```text
<app-data>/
  runtimes/
    manifest.json
    codex/
      0.133.0/
        darwin-arm64/
          codex
          path/rg
    node/
      22.22.1/
        darwin-arm64/
          bin/node
    claude-agent-sdk/
      0.3.150/
        darwin-arm64/
          claude
```

Manifest entries record tool, version, platform, source artifact URL, SHA-256,
install path, install time, and last verification time.

## Runtime Catalog

BAT embeds a runtime catalog for BAT-managed downloads. The catalog points at
`tonyq-org/bat-runtime-cache` release assets.

For BAT-managed artifacts:

- Download from exact catalog URL, never `latest`.
- Validate archive SHA-256 before extraction.
- Extract to a temporary app-data path.
- Run the minimal executable check.
- Atomic move into the final runtime path.
- Write manifest only after all checks pass.

PATH runtimes do not use catalog SHA-256. They are user-managed and validated
only by the shallow command check.

## Runtime Status API

Add Tauri commands under a new runtime namespace:

```ts
runtime.getStatus(): Promise<RuntimeStatus>
runtime.install(tool: RuntimeTool): Promise<RuntimeInstallResult>
runtime.openRuntimeFolder(): Promise<void>
runtime.clearManaged(tool?: RuntimeTool): Promise<void>
```

Types:

```ts
type RuntimeTool = 'node' | 'codex' | 'claude'

type RuntimeSource = 'managed' | 'system' | 'bundled' | 'missing'

type RuntimeState = 'ready' | 'missing' | 'installing' | 'broken'

type RuntimeItemStatus = {
  tool: RuntimeTool
  state: RuntimeState
  source: RuntimeSource
  path?: string
  version?: string
  message?: string
  canInstallManaged: boolean
}

type RuntimeStatus = {
  node: RuntimeItemStatus
  codex: RuntimeItemStatus
  claude: RuntimeItemStatus
}
```

## First-Run Setup UX

First-run setup should appear only when a required runtime is missing and no
acceptable `managed`, `system`, or `bundled` source exists.

Recommended setup rows:

- Node runtime
- Codex runtime
- Claude runtime

Each row shows:

- Status: ready, missing, installing, broken.
- Source: managed, system, bundled, missing.
- Version/path when available.
- Install action when BAT-managed install is available.

All-in-one builds should normally skip setup because bundled runtimes are ready.

## Pre-Release Rollout

### Pre 1: Runtime Diagnostics Only

Add `RuntimeManager` and `runtime.getStatus`.

Scope:

- Detect managed, system PATH, and bundled runtimes.
- Add Settings diagnostics UI.
- Do not change launch behavior.
- Do not download runtimes.

Validation:

- Confirm all-in-one builds report bundled runtimes.
- Confirm PATH runtimes report `source=system`.
- Confirm missing runtimes are visible without blocking the app.

### Pre 2: Codex Resolver

Route Codex app-server launch through `RuntimeManager.resolve("codex")`.

Scope:

- Prefer managed, then system, then bundled.
- Keep existing bundled Codex runtime.
- Missing Codex should show a setup/status prompt but not break unrelated
  workflows.

Validation:

- Existing bundled Codex still works.
- PATH Codex can be used without extra install.
- Diagnostics show the actual Codex path.

### Pre 3: Codex Managed Install

Implement `runtime.install("codex")` using `tonyq-org/bat-runtime-cache`.

Scope:

- Embed Codex catalog.
- Download exact release asset.
- Validate SHA-256.
- Extract and install atomically.
- Keep bundled fallback.

Validation:

- Clean machine can install Codex during setup.
- Install failure does not corrupt existing runtime.
- App restart reuses managed Codex.

### Pre 4: Node Resolver

Route sidecar Node selection through `RuntimeManager.resolve("node")`.

Scope:

- System PATH Node can satisfy setup if `node --version` succeeds.
- Managed Node can be added later.
- Bundled Node remains fallback.

Validation:

- Sidecar still starts on all-in-one builds.
- PATH Node works in lightweight/dev builds.
- Missing Node produces a clear setup prompt.

### Pre 5: Claude Resolver

Route Claude native runtime selection through `RuntimeManager.resolve("claude")`.

Scope:

- System PATH `claude` can satisfy setup if `claude --version` succeeds.
- Bundled Claude native remains fallback.
- Avoid setup-time login/keychain checks.

Validation:

- Existing Claude sessions still start.
- No unexpected keychain prompt during Settings/setup.
- Diagnostics show source/path/version.

### Pre 6: Lightweight Build Trial

Add lightweight build variants while keeping all-in-one builds.

Scope:

- Produce Windows all-in-one and Windows lightweight artifacts.
- Produce macOS arm64 all-in-one and macOS arm64 lightweight artifacts.
- Test lightweight variant on pre-release channel only.

Validation:

- Fresh install shows setup when no PATH runtimes exist.
- PATH-only users can skip downloads.
- Managed installs persist across app updates.

## Test Plan

Add focused tests for:

- Runtime source precedence.
- PATH runtime detection with shallow version command.
- Missing runtime status.
- Managed manifest read/write.
- SHA-256 mismatch rejection.
- Atomic install cleanup on failure.
- Codex resolver selecting managed/system/bundled paths.
- Node resolver does not require sidecar to already be running.
- All-in-one build resources remain present for Windows and macOS arm64.

Manual pre-release checks:

- macOS arm64 all-in-one fresh install.
- Windows all-in-one fresh install.
- macOS with PATH Codex/Node/Claude already installed.
- Clean machine with no PATH runtimes.
- App update after managed runtime install.
- Remote client connected to host with runtime status.
