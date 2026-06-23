# Auto-Update Implementation Plan (Tauri v2)

Status: **proposal / not started**. Greenfield — nothing updater-related exists yet.

## 0. Goal (as requested)

- Two channels: **stable** and **pre**.
- **pre** channel is only selectable / only checks when a **debug flag (`bat_debug`)** is enabled.
- When a newer version is detected → **download + install in the background**, then **prompt the user that the update applies on next restart** (do NOT force-relaunch).
- **Build mode**: at runtime, detect whether the running app is **lightweight** or **all-in-one** and update with the matching artifact ("有 lightweight 用 lightweight,沒有用 all-in-one").

## 1. Current state (verified)

| Piece | Status |
|---|---|
| `tauri-plugin-updater` (Rust) | ❌ not in `src-tauri/Cargo.toml` |
| `@tauri-apps/plugin-updater` (JS) | ❌ not in `package.json` |
| `plugins.updater` / `pubkey` / `endpoints` in `tauri.conf.json` | ❌ none |
| `bundle.createUpdaterArtifacts` | ❌ none (so no `.app.tar.gz`/`.sig` produced) |
| Updater signing key (minisign/ed25519) | ❌ none (`TAURI_SIGNING_*` not used) |
| Apple Developer ID + notarization | ✅ exists (`APPLE_*` secrets, all-in-one mac signed) |
| Release pipeline | ✅ `softprops/action-gh-release@v1`, `prerelease: contains(tag,'-pre')`, all assets → per-tag GitHub Release |
| Mac assets uploaded | only `.dmg` (all-in-one + lightweight). **No `.app.tar.gz`** |
| Build modes | `all-in-one` (base `tauri.conf.json` + `tauri.all-in-one.conf.json`) / `lightweight` (base only), via `scripts/tauri-build-mode.mjs` |
| Runtime mode marker | ❌ none explicit. De-facto: all-in-one bundles `<resource>/node-runtime/` (`src-tauri/src/sidecar.rs:797`), lightweight does not |
| Frontend update/channel/`bat_debug` settings | ❌ none. `renderer/src/stores/settings-store.ts` exists to extend |

Repo: `tony1223/better-agent-terminal`. (Homebrew distribution is explicitly out of scope for auto-update — see §8.)

## 2. How Tauri v2 updater works (mapping to our needs)

1. App calls `check()` → fetches a **manifest JSON** from an endpoint.
2. Manifest carries `version`, `pub_date`, `notes`, and a `platforms` map keyed by `{target}-{arch}` (e.g. `darwin-aarch64`, `windows-x86_64`, `linux-x86_64`), each with `{ url, signature }`.
3. If `manifest.version > current_version` (semver), the plugin downloads `url`, **verifies the minisign `signature` against the embedded `pubkey`**, then installs.
4. Install = swap the bundle (mac: replace `.app`; win: run NSIS `-setup.exe /UPDATE`; linux: replace AppImage). Relaunch is a **separate** call we will intentionally skip.

Our two axes — **channel** (stable/pre) and **mode** (all-in-one/lightweight) — are NOT expressible by the built-in `{{target}}`/`{{arch}}` placeholders. We resolve them at runtime by **choosing the endpoint URL** ourselves:

```
manifests/latest-{channel}-{mode}.json
  → latest-stable-all-in-one.json
  → latest-stable-lightweight.json
  → latest-pre-all-in-one.json
  → latest-pre-lightweight.json
```

Each file still contains the per-platform map inside. The Rust side builds the updater with the right single endpoint via `UpdaterBuilder::endpoints(vec![url])` based on `(channel, detected_mode)`.

## 3. Signing model — TWO independent chains (both required)

- **Apple Developer ID + notarization** → makes macOS Gatekeeper trust the `.app`. Already in place.
- **Tauri minisign key** → the updater verifies the downloaded artifact came from us. NEW.

They do not overlap. The `.app.tar.gz` contains the already-notarized+stapled `.app`, so after the updater swaps it in, Gatekeeper is still satisfied. We just additionally minisign the `.tar.gz`.

One-time setup:
```
pnpm exec tauri signer generate -w ~/.tauri/bat-updater.key
```
- Public key → `tauri.conf.json` `plugins.updater.pubkey`.
- Private key + password → CI secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep an offline backup (losing it breaks the upgrade path for already-shipped clients).

## 4. Build-mode runtime detection

Bake the mode into the binary at compile time so detection is explicit (not inferred):

- `src-tauri/build.rs`: `println!("cargo:rustc-env=BAT_BUNDLE_MODE={}", std::env::var("BAT_BUNDLE_MODE").unwrap_or_else(|_| "all-in-one".into()));`
- Rust: `const BUNDLE_MODE: &str = env!("BAT_BUNDLE_MODE");` exposed via command `get_bundle_mode() -> String`.
- `scripts/tauri-build-mode.mjs` already sets/forwards `BAT_BUNDLE_MODE`; ensure it is exported into the `tauri build` env (it drives the matrix today).
- Fallback / cross-check: `find_bundled_node()` resource presence (`sidecar.rs`) — if `BAT_BUNDLE_MODE` is somehow unset, presence of `<resource>/node-runtime/` ⇒ all-in-one.

## 5. Channels + pre gating

`settings-store.ts` additions:
- `updateChannel: 'stable' | 'pre'` (default `'stable'`).
- `autoUpdateEnabled: boolean` (default `true`).
- `batDebug: boolean` (default `false`) — the developer/debug flag. (No such flag exists today; this introduces it. Surface it in Settings → Advanced/Developer.)

Gating rule (enforced in the update controller AND in the settings UI):
- `effectiveChannel = (updateChannel === 'pre' && batDebug) ? 'pre' : 'stable'`.
- The "pre" radio is disabled/hidden unless `batDebug` is on. Turning `batDebug` off while on pre silently falls back to stable.

## 6. Manifest hosting & generation

GitHub's `releases/latest/download/...` only serves the newest **non-prerelease** release, which cannot serve the pre channel. Use a **pinned `manifests` release** whose assets are overwritten every build, giving stable URLs per channel×mode:

```
https://github.com/tony1223/better-agent-terminal/releases/download/manifests/latest-{channel}-{mode}.json
```

New script `scripts/generate-update-manifest.mjs`:
1. Inputs: the tag version, the just-built artifacts + their `.sig` files, the per-tag GitHub Release asset base URL.
2. Builds the Tauri manifest JSON (version from tag, `signature` = `.sig` file contents, `url` = per-tag release asset download URL).
3. Writes `latest-{channel}-{mode}.json` for the platforms present in this build.

CI update policy (in `release.yml`, after upload):
- On a **`-pre`** tag → regenerate/overwrite **pre** manifests only.
- On a **stable** tag → overwrite **both** stable **and** pre manifests (a stable release is also the newest build for pre users), so pre users roll forward onto stable.
- Upload manifests to the `manifests` release with `gh release upload --clobber`.

Manifest format reference:
```json
{
  "version": "3.1.13",
  "pub_date": "2026-06-02T00:00:00Z",
  "notes": "…release notes…",
  "platforms": {
    "darwin-aarch64": { "url": "https://github.com/tony1223/better-agent-terminal/releases/download/v3.1.13/BetterAgentTerminal-3.1.13-aarch64.app.tar.gz", "signature": "<contents of .sig>" },
    "darwin-x86_64":  { "url": "…x86_64.app.tar.gz", "signature": "…" },
    "windows-x86_64": { "url": "…_x64-setup.exe", "signature": "…" },
    "linux-x86_64":   { "url": "…amd64.AppImage.tar.gz", "signature": "…" }
  }
}
```

## 7. UX flow (background install + restart prompt)

Frontend update controller (new module, e.g. `renderer/src/lib/auto-update.ts`):
1. On app launch (+ every N hours, configurable) and `autoUpdateEnabled`:
2. Resolve `(effectiveChannel, mode=get_bundle_mode())` → call Rust `check_update`.
3. If an update is available → `downloadAndInstall()` with progress, **but do not relaunch**.
4. On success → persist `pendingUpdate = { version }` and show a **non-blocking banner**: "新版本 vX 已就緒,下次重啟自動套用" + an optional "立即重啟" button (calls `relaunch()`).
5. On next normal launch the new bundle is already in place; clear `pendingUpdate`.

Rust commands (`src-tauri/src/commands/updater.rs`):
- `get_bundle_mode() -> String`
- `check_update(channel: String) -> Option<UpdateInfo>` — builds endpoint from `(channel, BUNDLE_MODE)`, returns version/notes/available.
- `download_and_install_update() -> Result<()>` — downloads + installs, emits progress events, **does not relaunch**.
- (relaunch handled by the existing app relaunch path or `app.restart()`).

Remote/headless note: gate the controller to the host/desktop app only; do not trigger from remote clients.

## 8. Homebrew — explicitly out of scope (decided)

**We do not accommodate Homebrew at all.** In-app auto-update is for users who install via *our* artifacts (DMG / installer). If someone instead installs via the `brew` cask and a later `brew upgrade` reverts our self-applied update, that is the user's problem — we add **no** cask special-casing (no `auto_updates true`), no Homebrew-aware branching in the updater, and no "leave stable to brew" path.

Consequence for the plan: the updater behaves identically for stable and pre regardless of how the app was installed. There is no Homebrew work item anywhere below.

## 9. Phased rollout

### Phase 0 — keys & secrets (one-time, no user impact)
- Generate minisign keypair; add `pubkey` to `tauri.conf.json`; add `TAURI_SIGNING_*` CI secrets; back up the private key offline.

### Phase 1 — pre channel end-to-end (low risk; only affects `batDebug` users)
1. Add `tauri-plugin-updater` (Rust) + `@tauri-apps/plugin-updater` (JS); register plugin in `lib.rs`; add `updater:default` to the capability file.
2. `bundle.createUpdaterArtifacts: true` in base `tauri.conf.json`.
3. `build.rs` bake `BAT_BUNDLE_MODE`; `get_bundle_mode` command.
4. **macOS lightweight signing**: no change needed — the bundler step already signs + notarizes both modes (see §13). Slice 3 just adds the `TAURI_SIGNING_*` env so the bundler also emits the minisign `.app.tar.gz`/`.sig`.
5. CI: pass `TAURI_SIGNING_*`; upload `.app.tar.gz`/`.sig` (mac), nsis `.sig` (win), `.AppImage.tar.gz`/`.sig` (linux); run `generate-update-manifest.mjs` for **pre** manifests; upload to `manifests` release.
6. Frontend: settings (`updateChannel`, `autoUpdateEnabled`, `batDebug`) + update controller + restart banner. Pre gated by `batDebug`.
7. Verify by shipping two consecutive `-pre` tags and confirming a real device updates pre→pre, lightweight→lightweight and all-in-one→all-in-one (mac included).

### Phase 2 — stable channel
1. Extend the manifest script/CI policy to also write stable manifests on non-pre tags (and roll pre forward onto stable).
2. Ship a stable tag; confirm stable users (installed via our DMG/installer) update in place. (Homebrew users are out of scope — see §8.)

## 10. File-by-file change list

New:
- `src-tauri/build.rs` (or extend) — bake `BAT_BUNDLE_MODE`.
- `src-tauri/src/commands/updater.rs` — updater commands.
- `scripts/generate-update-manifest.mjs` — manifest builder.
- `renderer/src/lib/auto-update.ts` — update controller.
- (optional) `tests/update-manifest.test.mjs` — manifest generation unit test (fits the existing `test:*` gate style).

Edit:
- `src-tauri/Cargo.toml` — `tauri-plugin-updater = "2"`.
- `package.json` — `@tauri-apps/plugin-updater`.
- `src-tauri/tauri.conf.json` — `bundle.createUpdaterArtifacts: true`, `plugins.updater.pubkey` (+ optional default endpoint).
- `src-tauri/capabilities/*.json` — `updater:default` permission.
- `src-tauri/src/lib.rs` — register plugin + new commands.
- `.github/workflows/release.yml` — signing env, upload updater artifacts, manifest step.
- `renderer/src/stores/settings-store.ts` + Settings UI — channel / auto-update / `batDebug`.
- (No Homebrew/cask changes — out of scope, see §8.)

## 11. Security

- Updater verifies minisign signature before install → tampered/MITM artifacts rejected.
- Private key never in the repo; CI secret + offline backup; rotation = ship new pubkey, but old clients can't verify new key (plan a migration if ever rotated).
- Endpoints over HTTPS (GitHub).
- `batDebug` gates only channel selection, not signature verification (pre builds are still signed).

## 12. Testing / verification

- Unit: `generate-update-manifest.mjs` output shape + version/sig wiring.
- `pnpm exec tsc --noEmit` / `pnpm run compile` / `pnpm run check:tauri-rust` for the Rust + TS pieces.
- Manual device matrix: mac arm/intel, win, linux; lightweight vs all-in-one; pre→pre and pre→stable roll-forward; "install now" vs "next restart"; offline/failed-download handling (must not block app start).
- Confirm an updated mac bundle still passes Gatekeeper (notarization survives the tar.gz round-trip).

## 13. Open risks / decisions

- **Lightweight macOS signing — DECIDED: option A (sign + notarize both modes). On re-reading CI, this is ALREADY TRUE at the app level.** The earlier "only all-in-one is signed" reading was wrong: the `all-in-one`-gated steps in `release.yml` (~305/310/321/332/411) are the resource caches + `scripts/sign-macos-resource-binaries.sh`, which sign the *bundled node-runtime binaries* that only exist in all-in-one. The app's own Developer-ID signing + notarization happens in the **"Build Tauri release bundle"** step (line ~432), which runs for every mac (`matrix.platform != 'linux'`, no mode gate) and has been succeeding for `mac-arm64-lightweight` in recent `-pre` builds. So lightweight mac `.app` is already signed + notarized + stapled. **No signing-gate change is needed** — slice 3 only adds (a) `TAURI_SIGNING_*` env to the build steps so the bundler also emits the minisign-signed `.app.tar.gz`/`.sig`, and (b) uploading those + the manifest. "lightweight 用 lightweight" therefore holds on macOS with no extra notarization work.
- **Manifests release** (`manifests` pinned tag) must be created once and never deleted; `--clobber` overwrites assets. Alternative: GitHub Pages.
- **Windows perMachine NSIS** updates require elevation; confirm the `/UPDATE` silent path works without a UAC dead-end.
- **Key loss** = no upgrade path for shipped clients → enforce offline backup.

## 14. Effort estimate

- Phase 0: ~0.5 day (keys/secrets).
- Phase 1: ~2–4 days (plugin wiring + CI artifacts/manifest + frontend UI + device testing).
- Phase 2: ~1 day (stable manifests + cask).

Medium effort, controllable risk because Phase 1 is confined to `batDebug`/pre users.
