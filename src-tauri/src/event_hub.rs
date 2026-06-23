// Runtime event hub for renderer-facing pub-sub.
//
// The renderer-facing event contract is compatibility-sensitive: existing
// event names and payload shapes must stay stable. This hub centralizes the
// publish point in Rust without changing what JavaScript receives.

#[cfg(feature = "desktop")]
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
// The publish path emits to local webviews (desktop only); the headless server
// pushes events straight to RemoteServer::broadcast_event instead. Keep the
// tauri-free RuntimeEventHubState struct compiling in both.
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, Manager};

#[cfg(feature = "desktop")]
use crate::commands::notification;
#[cfg(feature = "desktop")]
use crate::remote_core::is_proxied_remote_event;
#[cfg(feature = "desktop")]
use crate::remote_server::RustRemoteServerState;

#[derive(Clone, Default)]
pub struct RuntimeEventHubState {
    next_seq: Arc<AtomicU64>,
}

#[cfg(feature = "desktop")]
impl RuntimeEventHubState {
    pub fn publish(&self, app: &AppHandle, topic: &str, payload: Value, origin: &'static str) {
        // Keep a monotonic sequence internally so future buffering/replay can
        // be added without changing renderer event payloads.
        let _seq = self.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = app.emit(topic, payload.clone());
        notification::update_agent_session_meta_from_event(app, topic, &payload);
        notification::update_agent_session_worktree_from_event(app, topic, &payload);
        notification::add_agent_completion_from_event(app, topic, &payload);
        if origin != "node-sidecar"
            && origin != "rust-remote-client"
            && is_proxied_remote_event(topic)
        {
            if let Some(remote_state) = app.try_state::<RustRemoteServerState>() {
                remote_state.broadcast_event(topic, &payload);
            }
        }
    }
}

#[cfg(feature = "desktop")]
pub fn publish_runtime_event(app: &AppHandle, topic: &str, payload: Value, origin: &'static str) {
    let hub = app.state::<RuntimeEventHubState>();
    hub.publish(app, topic, payload, origin);
}
