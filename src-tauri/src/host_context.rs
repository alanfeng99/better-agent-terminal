// The decoupling seam between the RemoteServer / agent-session backend and
// Tauri.
//
// Goal (issue #117): build a truly headless `bat-server` that links no
// wry/webkit2gtk, so it runs on enterprise Linux (glibc 2.34 / EL9) and needs
// no display server. Today the headless server reuses `tauri::Builder` purely
// as a runtime + state registry + event bus — nothing in its job actually
// needs a GUI (the remote server is plain TCP/websocket, the sidecar and codex
// app-server are `std::process` subprocesses, and `app.emit` to local webviews
// is a no-op when there are no windows).
//
// Migration strategy: every server-reachable function moves from taking a
// `tauri::AppHandle` to taking `&HostContext`. While that migration is in
// flight `HostContext` is backed by an `AppHandle` and reproduces today's
// behaviour exactly, so `cargo check` stays green after every batch. Once no
// server-reachable code touches `tauri::` directly, the backing is swapped for
// a GUI-free implementation and `tauri`/`wry` become a `desktop`-only feature.
//
// `app()` is a deliberate escape hatch for not-yet-migrated callers; the final
// batch removes it.

use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

use crate::app_data;
use crate::sidecar::{self, BridgeError, EventSink, SidecarState, SpawnConfig};

/// Host capabilities the agent-session / remote-server backend depends on,
/// exposed without leaking `tauri::` into callers. Cheap to clone (the backing
/// `AppHandle` is itself a handle).
#[derive(Clone)]
pub struct HostContext {
    // Backing is intentionally private. It is an `AppHandle` for the duration
    // of the migration; it will become a GUI-free implementation later without
    // changing this module's public API.
    app: AppHandle,
}

impl HostContext {
    /// Wrap the live Tauri app handle. Call sites at the Tauri boundary build
    /// one of these and hand `&HostContext` to the backend.
    pub fn from_app(app: AppHandle) -> Self {
        Self { app }
    }

    /// Escape hatch for code paths not yet migrated off `AppHandle`. New code
    /// should prefer the typed accessors below; this only exists so a partly
    /// migrated call graph still compiles. Removed in the final batch.
    #[allow(dead_code)]
    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    /// Push a renderer-facing event. On a headless host (no windows) the local
    /// emit is a no-op; remote clients receive events via RemoteServer
    /// broadcast (see `event_hub`).
    #[allow(dead_code)]
    pub fn emit(&self, topic: &str, payload: Value) {
        let _ = self.app.emit(topic, payload);
    }

    /// Resolve the persistent app-data directory.
    #[allow(dead_code)]
    pub fn data_dir(&self) -> Result<PathBuf, String> {
        app_data::app_data_dir(&self.app)
    }

    // ---- sidecar seam (already abstracted via EventSink; migrated first) ----

    /// The shared Node sidecar bridge state.
    #[allow(dead_code)]
    pub fn sidecar(&self) -> SidecarState {
        use tauri::Manager;
        self.app.state::<SidecarState>().inner().clone()
    }

    /// Resolve the node binary + sidecar script + cwd for spawning the sidecar.
    pub fn sidecar_spawn_config(&self) -> Result<SpawnConfig, BridgeError> {
        sidecar::resolve_spawn_config(&self.app)
    }

    /// An event sink that forwards sidecar-emitted events to the host's
    /// renderer/remote event path.
    pub fn sidecar_emit_sink(&self) -> EventSink {
        sidecar::app_handle_emit_sink(self.app.clone())
    }
}
