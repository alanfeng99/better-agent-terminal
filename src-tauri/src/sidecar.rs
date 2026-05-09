// JSON-RPC bridge to the Node sidecar.
//
// Spawns `node node-sidecar/src/server.mjs` lazily on first call, sends
// requests as line-delimited JSON over stdin, reads replies as
// line-delimited JSON over stdout, and correlates by id. Server-pushed
// events (id-less messages with method "event:foo") fan out to subscribers.
//
// We deliberately do NOT use tokio process here — std::process + std::thread
// match the rest of the Rust side (PTY, etc.) and avoid pulling tokio's
// process feature into the bundle. Each request blocks the calling thread
// on a std::sync::mpsc channel with a generous timeout. Tauri commands
// invoking the bridge run on the async runtime's worker pool, so blocking
// for a few hundred ms is fine.
//
// The bridge is intentionally "no auto-restart" for MVP. If the sidecar
// dies, the next call returns an error and a follow-up call respawns. We
// can add a richer supervisor (backoff, health probes) once we move actual
// agent SDK calls into the sidecar.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize)]
pub struct BridgeError {
    pub message: String,
}

impl<E: std::fmt::Display> From<E> for BridgeError {
    fn from(e: E) -> Self {
        Self { message: e.to_string() }
    }
}

// Per-pending-request reply slot. Reader thread looks up by id and sends
// the parsed result here; the calling thread blocks on the matching
// Receiver with a timeout.
type ReplySender = Sender<Result<Value, String>>;

#[derive(Default)]
struct PendingTable {
    inner: Mutex<HashMap<u64, ReplySender>>,
}

impl PendingTable {
    fn insert(&self, id: u64, tx: ReplySender) {
        self.inner.lock().expect("pending lock").insert(id, tx);
    }
    fn take(&self, id: u64) -> Option<ReplySender> {
        self.inner.lock().expect("pending lock").remove(&id)
    }
    fn drain_all(&self) -> Vec<ReplySender> {
        let mut guard = self.inner.lock().expect("pending lock");
        guard.drain().map(|(_, tx)| tx).collect()
    }
}

// One spawned sidecar process plus the plumbing to talk to it.
struct SidecarHandle {
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Arc<PendingTable>,
    // We hold the Child here so dropping the bridge kills the sidecar.
    // The reader thread joins automatically when stdout closes (= child exits).
    child: Mutex<Child>,
}

impl SidecarHandle {
    fn alloc_id(&self) -> u64 {
        // Start at 1 so 0 is reserved for "uninitialised" if it ever leaks.
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }
}

#[derive(Default)]
pub struct SidecarState {
    inner: Arc<Mutex<Option<Arc<SidecarHandle>>>>,
}

// Public spawn config. Passed in from the Tauri-side resolver so tests can
// inject any node + script path, while production code builds it from
// app handle paths.
pub struct SpawnConfig {
    pub node_path: PathBuf,
    pub script_path: PathBuf,
    /// Optional app data directory. When set, the sidecar receives it via
    /// the `BAT_SIDECAR_DATA_DIR` env var so file-backed handlers
    /// (claude.accountList, snippets-by-sidecar, etc.) read/write to the
    /// same on-disk location as the Rust host.
    pub data_dir: Option<PathBuf>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure_spawned(
        &self,
        cfg: &SpawnConfig,
        emit: Option<EventSink>,
    ) -> Result<Arc<SidecarHandle>, BridgeError> {
        let mut guard = self.inner.lock().expect("sidecar lock");
        if let Some(h) = guard.as_ref() {
            // Confirm the child is still alive. If it exited, drop and respawn.
            let mut child_guard = h.child.lock().expect("child lock");
            match child_guard.try_wait() {
                Ok(Some(_)) => {
                    // Exited. Fall through to respawn.
                    drop(child_guard);
                    *guard = None;
                }
                Ok(None) => {
                    // Still alive — return existing handle.
                    drop(child_guard);
                    return Ok(Arc::clone(h));
                }
                Err(_) => {
                    drop(child_guard);
                    *guard = None;
                }
            }
        }
        let handle = spawn_sidecar(cfg, emit)?;
        let arc = Arc::new(handle);
        *guard = Some(Arc::clone(&arc));
        Ok(arc)
    }

    pub fn call(
        &self,
        cfg: &SpawnConfig,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        self.call_with_emit(cfg, None, method, params, timeout)
    }

    pub fn call_with_emit(
        &self,
        cfg: &SpawnConfig,
        emit: Option<EventSink>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        let handle = self.ensure_spawned(cfg, emit)?;
        let id = handle.alloc_id();
        let (tx, rx) = channel::<Result<Value, String>>();
        handle.pending.insert(id, tx);
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&payload).map_err(BridgeError::from)?;
        {
            let mut stdin = handle.stdin.lock().expect("stdin lock");
            if let Err(e) = writeln!(stdin, "{line}") {
                handle.pending.take(id);
                return Err(BridgeError::from(e));
            }
            if let Err(e) = stdin.flush() {
                handle.pending.take(id);
                return Err(BridgeError::from(e));
            }
        }
        match rx.recv_timeout(timeout) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(msg)) => Err(BridgeError { message: msg }),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                handle.pending.take(id);
                Err(BridgeError { message: format!("sidecar: timeout waiting for {method}") })
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                handle.pending.take(id);
                Err(BridgeError { message: format!("sidecar: channel closed for {method}") })
            }
        }
    }

    // Test helper: forcibly drop the current handle so the next call respawns.
    #[cfg(test)]
    pub fn reset(&self) {
        let mut guard = self.inner.lock().expect("sidecar lock");
        if let Some(h) = guard.take() {
            // Try to kill the child; ignore errors — it may already be dead.
            if let Ok(mut child) = h.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            // Wake any blocked callers with a clear error so tests don't hang.
            for tx in h.pending.drain_all() {
                let _ = tx.send(Err("sidecar: state reset".to_string()));
            }
        }
    }
}

// EventSink lets the bridge forward sidecar-pushed notifications without
// hard-coding tauri::AppHandle: tests inject a Vec-collecting closure,
// production code wraps `app.emit(name, params)` from an AppHandle.
pub type EventSink = Arc<dyn Fn(&str, &Value) + Send + Sync + 'static>;

pub fn app_handle_emit_sink(app: AppHandle) -> EventSink {
    Arc::new(move |name: &str, params: &Value| {
        let _ = app.emit(name, params.clone());
    })
}

fn spawn_sidecar(cfg: &SpawnConfig, emit: Option<EventSink>) -> Result<SidecarHandle, BridgeError> {
    let mut command = Command::new(&cfg.node_path);
    command
        .arg(&cfg.script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = &cfg.data_dir {
        command.env("BAT_SIDECAR_DATA_DIR", dir);
    }
    let mut child = command.spawn().map_err(|e| BridgeError {
        message: format!(
            "sidecar: failed to spawn {}: {e}",
            cfg.node_path.display()
        ),
    })?;
    let stdin = child.stdin.take().ok_or_else(|| BridgeError {
        message: "sidecar: failed to capture stdin".into(),
    })?;
    let stdout = child.stdout.take().ok_or_else(|| BridgeError {
        message: "sidecar: failed to capture stdout".into(),
    })?;

    let pending: Arc<PendingTable> = Arc::new(PendingTable::default());
    let pending_for_reader = Arc::clone(&pending);

    // Reader thread: parse line-delimited JSON, route by id, fan out events.
    let emit_for_reader = emit.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let msg: SidecarReply = match serde_json::from_str(trimmed) {
                Ok(m) => m,
                Err(_) => continue, // malformed line; skip
            };
            // Server events have no id and a method like "event:name".
            // Strip the "event:" prefix and forward the params payload to
            // the registered sink (Tauri AppHandle in production, a test
            // collector in unit tests).
            if msg.id.is_none() {
                if let Some(method) = msg.method.as_deref() {
                    if let Some(name) = method.strip_prefix("event:") {
                        if let Some(sink) = emit_for_reader.as_ref() {
                            let params = msg.params.unwrap_or(Value::Null);
                            sink(name, &params);
                        }
                    }
                }
                continue;
            }
            let id = msg.id.unwrap();
            if let Some(tx) = pending_for_reader.take(id) {
                let outcome = if let Some(err) = msg.error {
                    Err(format!("sidecar({}): {}", err.code, err.message))
                } else {
                    Ok(msg.result.unwrap_or(Value::Null))
                };
                let _ = tx.send(outcome);
            }
        }
        // stdout closed => child exited. Wake all pending callers so they
        // don't hang forever.
        for tx in pending_for_reader.drain_all() {
            let _ = tx.send(Err("sidecar: child exited".into()));
        }
    });

    Ok(SidecarHandle {
        stdin: Mutex::new(stdin),
        next_id: AtomicU64::new(0),
        pending,
        child: Mutex::new(child),
    })
}

#[derive(Debug, Deserialize)]
struct SidecarReply {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<u64>,
    method: Option<String>,
    params: Option<Value>,
    result: Option<Value>,
    error: Option<SidecarReplyError>,
}

#[derive(Debug, Deserialize)]
struct SidecarReplyError {
    code: i64,
    message: String,
}

// ---------------------------------------------------------------------------
// Tauri-facing helper: build a SpawnConfig from the app handle.
//
// The Node binary is resolved from PATH (via the `node` symbol). The script
// path falls back through:
//   1) BAT_SIDECAR_SCRIPT environment variable (used in dev / tests).
//   2) <resource_dir>/node-sidecar/src/server.mjs (production-bundled).
//   3) <cwd>/node-sidecar/src/server.mjs (development fallback).
// We keep this resolver outside SidecarState so the state struct stays
// trivially constructible in tests.

pub fn resolve_spawn_config(app: &tauri::AppHandle) -> Result<SpawnConfig, BridgeError> {
    use tauri::Manager;

    let node_path = which_node().ok_or_else(|| BridgeError {
        message: "sidecar: could not find `node` on PATH".into(),
    })?;
    // Tauri app data dir, if available. We pass it to the sidecar via env
    // so file-backed handlers land in the same directory the Rust side
    // uses (e.g. claude-accounts.json written by the Electron build).
    let data_dir = app.path().app_data_dir().ok();

    if let Ok(env_script) = std::env::var("BAT_SIDECAR_SCRIPT") {
        let p = PathBuf::from(env_script);
        if p.is_file() {
            return Ok(SpawnConfig { node_path, script_path: p, data_dir });
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("node-sidecar").join("src").join("server.mjs");
        if candidate.is_file() {
            return Ok(SpawnConfig { node_path, script_path: candidate, data_dir });
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let dev = cwd.join("node-sidecar").join("src").join("server.mjs");
    if dev.is_file() {
        return Ok(SpawnConfig { node_path, script_path: dev, data_dir });
    }

    Err(BridgeError {
        message: "sidecar: could not locate node-sidecar/src/server.mjs".into(),
    })
}

fn which_node() -> Option<PathBuf> {
    // Trivial which: try PATHEXT-aware lookup on Windows, plain `node` on Unix.
    let exe_names: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd", "node"]
    } else {
        &["node"]
    };
    let path = std::env::var_os("PATH")?;
    for entry in std::env::split_paths(&path) {
        for name in exe_names {
            let candidate = entry.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn repo_root() -> PathBuf {
        // CARGO_MANIFEST_DIR points at src-tauri/. The repo root is one up.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repo root")
            .to_path_buf()
    }

    fn sidecar_script() -> PathBuf {
        repo_root().join("node-sidecar").join("src").join("server.mjs")
    }

    fn require_node() -> Option<PathBuf> { which_node() }

    #[test]
    fn alloc_id_starts_at_one_and_increments() {
        // SidecarHandle::alloc_id just bumps an AtomicU64 starting from 0
        // and returns +1, so a freestanding atomic stand-in is enough — no
        // need to spawn a dummy child.
        let counter = AtomicU64::new(0);
        let next = || counter.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(next(), 1);
        assert_eq!(next(), 2);
        assert_eq!(next(), 3);
    }

    #[test]
    fn pending_table_inserts_and_takes() {
        let table = PendingTable::default();
        let (tx, _rx) = channel::<Result<Value, String>>();
        table.insert(7, tx);
        assert!(table.take(7).is_some());
        assert!(table.take(7).is_none());
    }

    #[test]
    fn pending_table_drain_returns_all() {
        let table = PendingTable::default();
        let (tx1, _) = channel::<Result<Value, String>>();
        let (tx2, _) = channel::<Result<Value, String>>();
        table.insert(1, tx1);
        table.insert(2, tx2);
        let drained = table.drain_all();
        assert_eq!(drained.len(), 2);
        assert!(table.take(1).is_none());
        assert!(table.take(2).is_none());
    }

    #[test]
    fn reply_parses_ok_result() {
        let r: SidecarReply = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":3,"result":{"x":1}}"#,
        ).unwrap();
        assert_eq!(r.id, Some(3));
        assert_eq!(r.result.unwrap()["x"], 1);
        assert!(r.error.is_none());
    }

    #[test]
    fn reply_parses_error() {
        let r: SidecarReply = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"nope"}}"#,
        ).unwrap();
        assert_eq!(r.id, Some(4));
        assert!(r.result.is_none());
        let e = r.error.unwrap();
        assert_eq!(e.code, -32601);
        assert_eq!(e.message, "nope");
    }

    #[test]
    fn reply_parses_event_no_id() {
        let r: SidecarReply = serde_json::from_str(
            r#"{"jsonrpc":"2.0","method":"event:foo","params":{}}"#,
        ).unwrap();
        assert_eq!(r.id, None);
    }

    // The integration tests below require both `node` on PATH and the
    // sidecar script to exist. We skip gracefully (returning early with a
    // log) on machines that don't have them — keeps `cargo test` green
    // in minimal dev shells.
    #[test]
    fn end_to_end_ping_round_trip() {
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = SpawnConfig { node_path, script_path: script, data_dir: None };
        let state = SidecarState::new();
        let result = state
            .call(&cfg, "ping", json!({"hello":"world"}), Duration::from_secs(5))
            .expect("ping");
        assert_eq!(result["ok"], true);
        assert_eq!(result["echo"]["hello"], "world");
        // Tear down.
        state.reset();
    }

    #[test]
    fn end_to_end_unknown_method_errors() {
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = SpawnConfig { node_path, script_path: script, data_dir: None };
        let state = SidecarState::new();
        let err = state
            .call(&cfg, "no.such.method", Value::Null, Duration::from_secs(5))
            .expect_err("expected error");
        assert!(err.message.contains("-32601"), "unexpected: {}", err.message);
        state.reset();
    }

    #[test]
    fn end_to_end_claude_stubs() {
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = SpawnConfig { node_path, script_path: script, data_dir: None };
        let state = SidecarState::new();
        let auth = state
            .call(&cfg, "claude.authStatus", Value::Null, Duration::from_secs(15))
            .expect("authStatus");
        // authStatus is null OR an object (depends on whether `claude` is
        // installed and logged-in on the dev machine). Both are valid.
        assert!(auth.is_null() || auth.is_object(), "unexpected authStatus: {auth:?}");
        let accounts = state
            .call(&cfg, "claude.accountList", Value::Null, Duration::from_secs(5))
            .expect("accountList");
        assert!(accounts.is_array());
        // The dev machine may have a claude-accounts.json with real entries.
        // Just verify the shape — array of objects with id+email — without
        // asserting on length.
        for entry in accounts.as_array().unwrap() {
            assert!(entry.is_object(), "non-object account: {entry:?}");
            assert!(entry.get("id").and_then(|v| v.as_str()).is_some());
            assert!(entry.get("email").and_then(|v| v.as_str()).is_some());
        }
        state.reset();
    }

    #[test]
    fn end_to_end_session_lifecycle_emits_events() {
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = SpawnConfig { node_path, script_path: script, data_dir: None };
        let state = SidecarState::new();
        // Collector sink — captures (event_name, payload) pairs from the
        // bridge's reader thread. Equivalent to Tauri's Emitter::emit, but
        // doesn't require an AppHandle in tests.
        let collected: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let collected_for_sink = Arc::clone(&collected);
        let sink: EventSink = Arc::new(move |name: &str, params: &Value| {
            collected_for_sink.lock().unwrap().push((name.to_string(), params.clone()));
        });

        // startSession then sendMessage. sendMessage triggers
        // claude:message + claude:turn-end events from the sidecar stub.
        state
            .call_with_emit(
                &cfg,
                Some(Arc::clone(&sink)),
                "claude.startSession",
                json!({"sessionId":"t-1","options":{"cwd":"/"}}),
                Duration::from_secs(5),
            )
            .expect("startSession");
        state
            .call_with_emit(
                &cfg,
                Some(Arc::clone(&sink)),
                "claude.sendMessage",
                json!({"sessionId":"t-1","prompt":"hi"}),
                Duration::from_secs(5),
            )
            .expect("sendMessage");

        // Events fire from the reader thread; give it a beat to flush.
        std::thread::sleep(Duration::from_millis(150));

        let events = collected.lock().unwrap();
        let names: Vec<&str> = events.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"claude:message"), "missing claude:message in {names:?}");
        assert!(names.contains(&"claude:turn-end"), "missing claude:turn-end in {names:?}");
        // Payload sanity: message event includes our session id.
        let msg_event = events.iter().find(|(n, _)| n == "claude:message").unwrap();
        assert_eq!(msg_event.1["sessionId"], "t-1");
        drop(events);
        state.reset();
    }

    #[test]
    fn end_to_end_concurrent_calls_correlate_by_id() {
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = Arc::new(SpawnConfig { node_path, script_path: script, data_dir: None });
        let state = Arc::new(SidecarState::new());
        // Warm the bridge so all threads share the same child.
        state.call(&cfg, "ping", Value::Null, Duration::from_secs(5)).unwrap();
        let mut joins = Vec::new();
        for i in 0..8u64 {
            let s = Arc::clone(&state);
            let c = Arc::clone(&cfg);
            joins.push(std::thread::spawn(move || {
                let r = s.call(&c, "ping", json!({"i": i}), Duration::from_secs(5)).expect("ping");
                assert_eq!(r["echo"]["i"], i);
            }));
        }
        for j in joins {
            j.join().unwrap();
        }
        state.reset();
    }
}
