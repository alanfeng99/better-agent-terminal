// notification:* — in-memory notification center.
//
// The Electron host pumps notifications in from the agent managers
// (claude/codex/openai). Tauri keeps the same renderer-facing API and
// records agent sessions at the command boundary; when the Rust event
// hub sees a completed `claude:turn-end`, it inserts an entry here.
//
// State is process-local on purpose: the Electron impl
// (electron/notification-center.ts) does the same thing — entries
// are not persisted across launches.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::window_registry;

const MAX_ENTRIES: usize = 50;
static NEXT_NOTIFICATION_ID: AtomicU64 = AtomicU64::new(0);

// Mirror src/stores/notification-store.ts NotificationEntry. The
// renderer-side interface is the source of truth — bumping fields
// here means bumping the TypeScript interface too.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct NotificationEntry {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "windowId")]
    pub window_id: Option<String>,
    #[serde(rename = "profileId")]
    pub profile_id: Option<String>,
    #[serde(rename = "workspaceName")]
    pub workspace_name: String,
    pub cwd: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub timestamp: i64,
    pub read: bool,
    #[serde(rename = "agentKind", skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<String>,
}

#[derive(Default)]
pub struct NotificationState {
    inner: Mutex<Vec<NotificationEntry>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentNotificationSession {
    pub window_id: Option<String>,
    pub profile_id: Option<String>,
    pub cwd: String,
    pub agent_kind: Option<String>,
}

#[derive(Default)]
pub struct AgentNotificationState {
    inner: Mutex<HashMap<String, AgentNotificationSession>>,
}

impl NotificationState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<NotificationEntry>> {
        // Mutex poisoning here would mean a previous handler panicked
        // mid-update; we recover by treating that as "empty store"
        // rather than propagating the poison into every subsequent
        // call. The renderer can re-fetch via list() to resync.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl AgentNotificationState {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, AgentNotificationSession>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct FocusResult {
    pub id: String,
    #[serde(rename = "windowId")]
    pub window_id: String,
}

#[tauri::command]
pub fn notification_list(state: State<'_, NotificationState>) -> Vec<NotificationEntry> {
    state.lock().clone()
}

#[tauri::command]
pub fn notification_mark_read(
    app: AppHandle,
    state: State<'_, NotificationState>,
    id: String,
) -> bool {
    let updated = {
        let mut entries = state.lock();
        if let Some(e) = entries.iter_mut().find(|e| e.id == id) {
            if e.read {
                false
            } else {
                e.read = true;
                true
            }
        } else {
            false
        }
    };
    if updated {
        emit_update(&app, &state);
    }
    updated
}

#[tauri::command]
pub fn notification_mark_all_read(app: AppHandle, state: State<'_, NotificationState>) -> bool {
    let mut changed = false;
    {
        let mut entries = state.lock();
        for e in entries.iter_mut() {
            if !e.read {
                e.read = true;
                changed = true;
            }
        }
    }
    if changed {
        emit_update(&app, &state);
    }
    true
}

#[tauri::command]
pub fn notification_mark_window_read(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, NotificationState>,
) -> bool {
    let window_id = window.label().to_string();
    let mut changed = false;
    {
        let mut entries = state.lock();
        for e in entries.iter_mut() {
            if !e.read && e.window_id.as_deref() == Some(&window_id) {
                e.read = true;
                changed = true;
            }
        }
    }
    if changed {
        emit_update(&app, &state);
    }
    true
}

#[tauri::command]
pub fn notification_clear(app: AppHandle, state: State<'_, NotificationState>) -> bool {
    let cleared = {
        let mut entries = state.lock();
        if entries.is_empty() {
            false
        } else {
            entries.clear();
            true
        }
    };
    if cleared {
        emit_update(&app, &state);
    }
    true
}

#[tauri::command]
pub fn notification_focus_latest_unread(
    app: AppHandle,
    state: State<'_, NotificationState>,
) -> Option<FocusResult> {
    let (id, window_id) = {
        let entries = state.lock();
        entries
            .iter()
            .find(|entry| !entry.read && entry.window_id.is_some())
            .map(|entry| (entry.id.clone(), entry.window_id.clone().unwrap()))?
    };
    focus_notification_window(&app, &window_id)?;
    mark_entry_read_and_emit(&app, &state, &id);
    Some(FocusResult { id, window_id })
}

#[tauri::command]
pub fn notification_focus_entry(
    app: AppHandle,
    state: State<'_, NotificationState>,
    id: String,
) -> Option<FocusResult> {
    let window_id = {
        let entries = state.lock();
        entries
            .iter()
            .find(|entry| entry.id == id)
            .and_then(|entry| entry.window_id.clone())?
    };
    focus_notification_window(&app, &window_id)?;
    mark_entry_read_and_emit(&app, &state, &id);
    Some(FocusResult { id, window_id })
}

pub fn register_agent_session_from_options(
    app: &AppHandle,
    window_id: &str,
    session_id: &str,
    options: Option<&Value>,
) {
    if session_id.trim().is_empty() {
        return;
    }
    let cwd = effective_notification_cwd(options).unwrap_or_default();
    if cwd.is_empty() {
        return;
    }
    let profile_id = Some(window_registry::get_entry(app, window_id).profile_id);
    let agent_kind = options.and_then(agent_kind_from_options);
    let state = app.state::<AgentNotificationState>();
    state.lock().insert(
        session_id.to_string(),
        AgentNotificationSession {
            window_id: Some(window_id.to_string()),
            profile_id,
            cwd,
            agent_kind,
        },
    );
}

pub fn unregister_agent_session(app: &AppHandle, session_id: &str) {
    if let Some(state) = app.try_state::<AgentNotificationState>() {
        state.lock().remove(session_id);
    }
}

pub fn get_agent_session_cwd(app: &AppHandle, session_id: &str) -> Option<String> {
    let state = app.try_state::<AgentNotificationState>()?;
    let cwd = state
        .lock()
        .get(session_id)
        .map(|session| session.cwd.clone());
    cwd
}

pub fn add_agent_completion_from_event(app: &AppHandle, topic: &str, payload: &Value) {
    if topic != "claude:turn-end" {
        return;
    }
    let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let event_payload = payload.get("payload").unwrap_or(payload);
    if event_payload.get("reason").and_then(Value::as_str) != Some("completed") {
        return;
    }
    let Some(agent_state) = app.try_state::<AgentNotificationState>() else {
        return;
    };
    let Some(session) = agent_state.lock().get(session_id).cloned() else {
        return;
    };
    let Some(notification_state) = app.try_state::<NotificationState>() else {
        return;
    };
    let result = event_payload
        .get("result")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from);
    add_entry(
        app,
        &notification_state,
        NotificationEntry {
            id: next_notification_id(),
            session_id: session_id.to_string(),
            window_id: session.window_id,
            profile_id: session.profile_id,
            workspace_name: workspace_name(&session.cwd),
            cwd: session.cwd,
            reason: "completed".into(),
            result,
            error: None,
            timestamp: now_ms(),
            read: false,
            agent_kind: session.agent_kind,
        },
    );
}

fn focus_notification_window(app: &AppHandle, window_id: &str) -> Option<()> {
    let win = app.get_webview_window(window_id)?;
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    Some(())
}

fn mark_entry_read_and_emit(app: &AppHandle, state: &State<'_, NotificationState>, id: &str) {
    let changed = {
        let mut entries = state.lock();
        if let Some(entry) = entries.iter_mut().find(|entry| entry.id == id) {
            if entry.read {
                false
            } else {
                entry.read = true;
                true
            }
        } else {
            false
        }
    };
    if changed {
        emit_update(app, state);
    }
}

// Internal helper — push the current entry list to all listeners.
// Renderer subscribes via `listen("notification:update", ...)`.
fn emit_update(app: &AppHandle, state: &State<'_, NotificationState>) {
    let entries = state.lock().clone();
    let _ = app.emit("notification:update", entries);
}

// Helper used by the (future) agent sidecar to push a new entry.
// We expose it on `NotificationState` so the eventual claude/codex/
// openai modules can call it directly without re-parsing JSON.
#[allow(dead_code)]
pub fn add_entry(app: &AppHandle, state: &NotificationState, entry: NotificationEntry) {
    {
        let mut entries = state.lock();
        // Mirror the Electron behaviour: replace any existing entry
        // for the same workspace key (lowercased path on Windows).
        let key = normalize_workspace_key(&entry.cwd);
        entries.retain(|e| normalize_workspace_key(&e.cwd) != key);
        entries.insert(0, entry);
        if entries.len() > MAX_ENTRIES {
            entries.truncate(MAX_ENTRIES);
        }
    }
    let snapshot = state.lock().clone();
    let _ = app.emit("notification:update", snapshot);
}

fn next_notification_id() -> String {
    let seq = NEXT_NOTIFICATION_ID.fetch_add(1, Ordering::SeqCst) + 1;
    format!("notif-{}-{seq}", now_ms())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn workspace_name(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(String::from)
        .unwrap_or_else(|| cwd.to_string())
}

fn effective_notification_cwd(options: Option<&Value>) -> Option<String> {
    let options = options?;
    let cwd = options.get("cwd").and_then(Value::as_str)?;
    if options.get("useWorktree").and_then(Value::as_bool) == Some(true) {
        if let Some(worktree_path) = options
            .get("worktreePath")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
        {
            return Some(worktree_path.to_string());
        }
    }
    Some(cwd.to_string())
}

fn agent_kind_from_options(options: &Value) -> Option<String> {
    match options.get("agentPreset").and_then(Value::as_str) {
        Some("codex-agent" | "codex-agent-worktree" | "openai-agent") => Some("codex".into()),
        Some("claude-code" | "claude-code-v2" | "claude-code-worktree") | None => {
            Some("claude".into())
        }
        Some(_) => None,
    }
}

pub fn normalize_workspace_key(cwd: &str) -> String {
    let normalized = cwd
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        // Windows drive letter — case-insensitive comparison.
        normalized.to_lowercase()
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str, cwd: &str, read: bool) -> NotificationEntry {
        NotificationEntry {
            id: id.into(),
            session_id: "s1".into(),
            window_id: Some("main".into()),
            profile_id: None,
            workspace_name: "ws".into(),
            cwd: cwd.into(),
            reason: "completed".into(),
            result: None,
            error: None,
            timestamp: 0,
            read,
            agent_kind: None,
        }
    }

    #[test]
    fn effective_notification_cwd_prefers_worktree_path() {
        let options = serde_json::json!({
            "cwd": "/repo",
            "useWorktree": true,
            "worktreePath": "/repo/.bat-worktrees/s-1"
        });
        assert_eq!(
            effective_notification_cwd(Some(&options)).as_deref(),
            Some("/repo/.bat-worktrees/s-1")
        );
        let no_worktree = serde_json::json!({ "cwd": "/repo" });
        assert_eq!(
            effective_notification_cwd(Some(&no_worktree)).as_deref(),
            Some("/repo")
        );
    }

    #[test]
    fn agent_kind_maps_codex_and_claude_presets() {
        assert_eq!(
            agent_kind_from_options(&serde_json::json!({ "agentPreset": "codex-agent" }))
                .as_deref(),
            Some("codex")
        );
        assert_eq!(
            agent_kind_from_options(&serde_json::json!({ "agentPreset": "claude-code-v2" }))
                .as_deref(),
            Some("claude")
        );
        assert_eq!(
            agent_kind_from_options(&serde_json::json!({ "agentPreset": "unknown" })),
            None
        );
    }

    #[test]
    fn workspace_name_uses_last_path_component() {
        assert_eq!(workspace_name("C:/work/repo"), "repo");
        assert_eq!(workspace_name("/"), "/");
    }

    #[test]
    fn fresh_state_is_empty() {
        let s = NotificationState::default();
        assert!(s.lock().is_empty());
    }

    #[test]
    fn normalize_workspace_key_matches_electron() {
        // Trailing slashes are dropped, backslashes are folded to
        // forward slashes, drive letter is lowercased on Windows.
        assert_eq!(normalize_workspace_key("C:\\Users\\Me"), "c:/users/me");
        assert_eq!(normalize_workspace_key("C:/Users/Me/"), "c:/users/me");
        assert_eq!(normalize_workspace_key("/home/me/repo/"), "/home/me/repo");
        // No drive letter: case is preserved (Linux/macOS are
        // case-sensitive, so collapsing to lowercase would over-merge).
        assert_eq!(normalize_workspace_key("/Home/Me"), "/Home/Me");
    }

    #[test]
    fn entry_serializes_camel_case() {
        // Renderer-side interface uses sessionId / windowId / etc.
        // The serde rename has to land or the renderer reads
        // undefined.
        let e = sample_entry("n1", "/repo", false);
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"sessionId\":\"s1\""));
        assert!(json.contains("\"windowId\":\"main\""));
        assert!(json.contains("\"workspaceName\":\"ws\""));
        // Optional fields with None should be omitted entirely.
        assert!(!json.contains("\"result\":"));
        assert!(!json.contains("\"error\":"));
        assert!(!json.contains("\"agentKind\":"));
    }

    // We can't construct an AppHandle in unit tests, so the state
    // mutation logic is exercised through small wrapper helpers
    // that don't touch the emitter.

    fn raw_mark_read(state: &NotificationState, id: &str) -> bool {
        let mut entries = state.lock();
        match entries.iter_mut().find(|e| e.id == id) {
            Some(e) if !e.read => {
                e.read = true;
                true
            }
            _ => false,
        }
    }

    fn raw_mark_all_read(state: &NotificationState) -> bool {
        let mut entries = state.lock();
        let mut changed = false;
        for e in entries.iter_mut() {
            if !e.read {
                e.read = true;
                changed = true;
            }
        }
        changed
    }

    fn raw_mark_window_read(state: &NotificationState, window_id: &str) -> bool {
        let mut entries = state.lock();
        let mut changed = false;
        for e in entries.iter_mut() {
            if !e.read && e.window_id.as_deref() == Some(window_id) {
                e.read = true;
                changed = true;
            }
        }
        changed
    }

    fn raw_clear(state: &NotificationState) -> bool {
        let mut entries = state.lock();
        if entries.is_empty() {
            false
        } else {
            entries.clear();
            true
        }
    }

    fn raw_add(state: &NotificationState, entry: NotificationEntry) {
        let mut entries = state.lock();
        let key = normalize_workspace_key(&entry.cwd);
        entries.retain(|e| normalize_workspace_key(&e.cwd) != key);
        entries.insert(0, entry);
        if entries.len() > MAX_ENTRIES {
            entries.truncate(MAX_ENTRIES);
        }
    }

    #[test]
    fn mark_read_only_returns_true_when_changed() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("n1", "/repo", false));
        assert!(raw_mark_read(&state, "n1"));
        // Already read — second call should be a no-op.
        assert!(!raw_mark_read(&state, "n1"));
        // Missing id — also no-op.
        assert!(!raw_mark_read(&state, "missing"));
    }

    #[test]
    fn mark_all_read_returns_true_only_when_anything_changed() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("a", "/r1", false));
        raw_add(&state, sample_entry("b", "/r2", true));
        assert!(raw_mark_all_read(&state));
        // Now everything is read, so a second call reports no change.
        assert!(!raw_mark_all_read(&state));
        let entries = state.lock();
        assert!(entries.iter().all(|e| e.read));
    }

    #[test]
    fn mark_window_read_only_marks_current_window() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("main", "/r1", false));
        let mut other = sample_entry("other", "/r2", false);
        other.window_id = Some("win-2".into());
        raw_add(&state, other);

        assert!(raw_mark_window_read(&state, "main"));
        let entries = state.lock();
        assert!(
            entries
                .iter()
                .find(|entry| entry.id == "main")
                .unwrap()
                .read
        );
        assert!(
            !entries
                .iter()
                .find(|entry| entry.id == "other")
                .unwrap()
                .read
        );
    }

    #[test]
    fn clear_returns_false_when_already_empty() {
        let state = NotificationState::default();
        assert!(!raw_clear(&state));
        raw_add(&state, sample_entry("a", "/r1", false));
        assert!(raw_clear(&state));
        assert!(state.lock().is_empty());
    }

    #[test]
    fn add_dedupes_by_workspace_key() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("a", "C:/repo", false));
        // Same workspace by case-insensitive key — should replace
        // the existing entry rather than accumulate two.
        raw_add(&state, sample_entry("b", "c:\\repo\\", false));
        let entries = state.lock();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "b");
    }

    #[test]
    fn add_caps_at_max_entries() {
        let state = NotificationState::default();
        for i in 0..(MAX_ENTRIES + 10) {
            raw_add(
                &state,
                sample_entry(&format!("n{i}"), &format!("/repo/{i}"), false),
            );
        }
        assert_eq!(state.lock().len(), MAX_ENTRIES);
        // Newest entry sits at the front.
        assert_eq!(state.lock()[0].id, format!("n{}", MAX_ENTRIES + 9));
    }

    #[test]
    fn focus_latest_unread_skips_read_and_windowless() {
        let state = NotificationState::default();
        // Add a read entry with a windowId — should be skipped.
        raw_add(&state, sample_entry("read", "/r1", true));
        // Add an unread entry but windowId = None — should be skipped.
        let mut wl = sample_entry("no-window", "/r2", false);
        wl.window_id = None;
        raw_add(&state, wl);
        // Add an unread entry with a windowId — this is the match.
        raw_add(&state, sample_entry("hit", "/r3", false));

        // We can't call notification_focus_latest_unread directly
        // without a State, so reproduce the logic here.
        let entries = state.lock();
        let mut found: Option<FocusResult> = None;
        for e in entries.iter() {
            if !e.read {
                if let Some(w) = &e.window_id {
                    found = Some(FocusResult {
                        id: e.id.clone(),
                        window_id: w.clone(),
                    });
                    break;
                }
            }
        }
        assert_eq!(found.unwrap().id, "hit");
    }
}
