use crate::app_data;
use crate::commands::app::log_tauri;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const WINDOWS_FILE: &str = "windows.json";
const WORKSPACES_FILE: &str = "workspaces.json";
const PROFILES_DIR: &str = "profiles";
const DEFAULT_PROFILE_ID: &str = "default";

fn bat_debug_enabled() -> bool {
    matches!(
        std::env::var("BAT_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn debug_registry_log(app: &AppHandle, message: impl AsRef<str>) {
    if bat_debug_enabled() {
        log_tauri(app, &format!("[window-registry] {}", message.as_ref()));
    }
}

fn value_array_len(value: &Value) -> usize {
    value.as_array().map_or(0, Vec::len)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    #[serde(default)]
    pub workspaces: Value,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    #[serde(default)]
    pub active_group: Option<String>,
    #[serde(default)]
    pub terminals: Value,
    #[serde(default)]
    pub active_terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    pub id: String,
    pub profile_id: String,
    #[serde(flatten)]
    pub snapshot: WindowSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached_parent_window_id: Option<String>,
    pub last_active_at: i64,
}

#[derive(Default)]
pub struct WindowRegistryState {
    entries: Mutex<Vec<WindowEntry>>,
    // One-shot markers for windows created by app_new_window (Cmd+N) so the
    // renderer knows to skip profile.load() — those windows should land
    // empty instead of inheriting the bound profile's saved workspaces.
    // Per-window flag, consumed once on first read.
    fresh_windows: Mutex<HashSet<String>>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn empty_snapshot() -> WindowSnapshot {
    WindowSnapshot {
        workspaces: json!([]),
        active_workspace_id: None,
        active_group: None,
        terminals: json!([]),
        active_terminal_id: None,
        bounds: None,
    }
}

fn workspace_value_from_snapshot(snapshot: &WindowSnapshot) -> Value {
    json!({
        "workspaces": snapshot.workspaces,
        "activeWorkspaceId": snapshot.active_workspace_id,
        "activeGroup": snapshot.active_group,
        "terminals": snapshot.terminals,
        "activeTerminalId": snapshot.active_terminal_id,
    })
}

fn value_array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

fn value_id(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

fn value_workspace_id(value: &Value) -> Option<&str> {
    value.get("workspaceId").and_then(Value::as_str)
}

fn snapshot_from_workspace_value(value: Value) -> WindowSnapshot {
    WindowSnapshot {
        workspaces: value
            .get("workspaces")
            .cloned()
            .unwrap_or_else(|| json!([])),
        active_workspace_id: value
            .get("activeWorkspaceId")
            .and_then(Value::as_str)
            .map(str::to_string),
        active_group: value
            .get("activeGroup")
            .and_then(Value::as_str)
            .map(str::to_string),
        terminals: value.get("terminals").cloned().unwrap_or_else(|| json!([])),
        active_terminal_id: value
            .get("activeTerminalId")
            .and_then(Value::as_str)
            .map(str::to_string),
        bounds: None,
    }
}

fn move_workspace_between_entries(
    source: &mut WindowEntry,
    target: &mut WindowEntry,
    workspace_id: &str,
    insert_index: usize,
) -> bool {
    let mut source_workspaces = value_array(&source.snapshot.workspaces);
    let Some(workspace_index) = source_workspaces
        .iter()
        .position(|workspace| value_id(workspace) == Some(workspace_id))
    else {
        return false;
    };
    let workspace = source_workspaces.remove(workspace_index);

    let mut moved_terminals = Vec::new();
    let mut remaining_terminals = Vec::new();
    for terminal in value_array(&source.snapshot.terminals) {
        if value_workspace_id(&terminal) == Some(workspace_id) {
            moved_terminals.push(terminal);
        } else {
            remaining_terminals.push(terminal);
        }
    }

    let moved_terminal_ids = moved_terminals
        .iter()
        .filter_map(value_id)
        .map(str::to_string)
        .collect::<HashSet<_>>();

    let mut target_workspaces = value_array(&target.snapshot.workspaces);
    let clamped_index = insert_index.min(target_workspaces.len());
    target_workspaces.insert(clamped_index, workspace.clone());

    let mut target_terminals = value_array(&target.snapshot.terminals);
    target_terminals.extend(moved_terminals.iter().cloned());

    if source.snapshot.active_workspace_id.as_deref() == Some(workspace_id) {
        source.snapshot.active_workspace_id = source_workspaces
            .first()
            .and_then(value_id)
            .map(str::to_string);
    }
    target.snapshot.active_workspace_id = Some(workspace_id.to_string());

    if source
        .snapshot
        .active_terminal_id
        .as_ref()
        .is_some_and(|terminal_id| moved_terminal_ids.contains(terminal_id))
    {
        source.snapshot.active_terminal_id = source
            .snapshot
            .active_workspace_id
            .as_deref()
            .and_then(|active_workspace_id| {
                remaining_terminals
                    .iter()
                    .find(|terminal| value_workspace_id(terminal) == Some(active_workspace_id))
                    .and_then(value_id)
                    .map(str::to_string)
            });
    }
    target.snapshot.active_terminal_id = workspace
        .get("focusedTerminalId")
        .and_then(Value::as_str)
        .filter(|terminal_id| moved_terminal_ids.contains(*terminal_id))
        .map(str::to_string)
        .or_else(|| {
            moved_terminals
                .first()
                .and_then(value_id)
                .map(str::to_string)
        });

    source.snapshot.workspaces = json!(source_workspaces);
    source.snapshot.terminals = json!(remaining_terminals);
    target.snapshot.workspaces = json!(target_workspaces);
    target.snapshot.terminals = json!(target_terminals);
    true
}

fn app_data_dir(app: &AppHandle) -> Option<PathBuf> {
    app_data::app_data_dir_opt(app)
}

fn windows_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).map(|dir| dir.join(WINDOWS_FILE))
}

fn workspace_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).map(|dir| dir.join(WORKSPACES_FILE))
}

fn profile_path(app: &AppHandle, profile_id: &str) -> Option<PathBuf> {
    app_data_dir(app).map(|dir| dir.join(PROFILES_DIR).join(format!("{profile_id}.json")))
}

fn profile_index_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).map(|dir| dir.join(PROFILES_DIR).join("index.json"))
}

fn safe_profile_id(profile_id: &str) -> String {
    profile_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn profile_safe_id_map(
    profile_ids: impl IntoIterator<Item = String>,
) -> HashMap<String, Option<String>> {
    let mut map = HashMap::new();
    for profile_id in profile_ids {
        let safe = safe_profile_id(&profile_id);
        map.entry(safe)
            .and_modify(|existing: &mut Option<String>| {
                if existing.as_deref() != Some(profile_id.as_str()) {
                    *existing = None;
                }
            })
            .or_insert(Some(profile_id));
    }
    map
}

fn known_profile_safe_ids(app: &AppHandle) -> HashMap<String, Option<String>> {
    let profile_ids = profile_index_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| {
            value.get("profiles")?.as_array().map(|profiles| {
                profiles
                    .iter()
                    .filter_map(|profile| profile.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
        })
        .filter(|profile_ids| !profile_ids.is_empty())
        .unwrap_or_else(|| vec![DEFAULT_PROFILE_ID.into()]);
    profile_safe_id_map(profile_ids)
}

fn infer_profile_id_from_window_id(
    window_id: &str,
    profile_safe_ids: &HashMap<String, Option<String>>,
) -> Option<String> {
    let suffix = window_id.strip_prefix("profile-")?;
    profile_safe_ids
        .iter()
        .filter_map(|(safe, profile_id)| {
            let profile_id = profile_id.as_ref()?;
            if safe.is_empty() {
                return None;
            }
            if suffix == safe || suffix.starts_with(&format!("{safe}-")) {
                Some((safe.len(), profile_id.clone()))
            } else {
                None
            }
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, profile_id)| profile_id)
}

fn normalize_window_entry_profile_ids(
    entries: &mut [WindowEntry],
    profile_safe_ids: &HashMap<String, Option<String>>,
) -> HashSet<String> {
    let mut affected_profile_ids = HashSet::new();
    for entry in entries {
        if entry.detached_workspace_id.is_some() {
            continue;
        }
        let Some(profile_id) = infer_profile_id_from_window_id(&entry.id, profile_safe_ids) else {
            continue;
        };
        if entry.profile_id != profile_id {
            affected_profile_ids.insert(entry.profile_id.clone());
            affected_profile_ids.insert(profile_id.clone());
            entry.profile_id = profile_id;
        }
    }
    affected_profile_ids
}

fn prune_overlapping_profile_window_entries(
    entries: &mut Vec<WindowEntry>,
) -> (HashSet<String>, usize) {
    let mut keep = vec![true; entries.len()];
    let mut sorted_indices = (0..entries.len()).collect::<Vec<_>>();
    sorted_indices.sort_by(|a, b| entries[*b].last_active_at.cmp(&entries[*a].last_active_at));

    let mut seen_terminal_ids_by_profile: HashMap<String, HashSet<String>> = HashMap::new();
    let mut affected_profile_ids = HashSet::new();
    let mut removed_count = 0;

    for index in sorted_indices {
        let entry = &entries[index];
        if entry.detached_workspace_id.is_some() || !snapshot_has_content(&entry.snapshot) {
            continue;
        }
        let terminal_ids = snapshot_terminal_ids(&entry.snapshot);
        if terminal_ids.is_empty() {
            continue;
        }
        let seen = seen_terminal_ids_by_profile
            .entry(entry.profile_id.clone())
            .or_default();
        if terminal_ids.iter().any(|id| seen.contains(id)) {
            keep[index] = false;
            removed_count += 1;
            affected_profile_ids.insert(entry.profile_id.clone());
            continue;
        }
        seen.extend(terminal_ids);
    }

    if removed_count > 0 {
        let mut index = 0;
        entries.retain(|_| {
            let should_keep = keep[index];
            index += 1;
            should_keep
        });
    }

    (affected_profile_ids, removed_count)
}

fn write_profile_snapshots_for_ids(
    app: &AppHandle,
    entries: &[WindowEntry],
    profile_ids: &HashSet<String>,
) {
    for profile_id in profile_ids {
        let windows = profile_windows(entries, profile_id);
        write_profile_snapshot(app, profile_id, &windows);
    }
}

fn normalize_entries_for_app(app: &AppHandle, entries: &mut Vec<WindowEntry>) -> bool {
    let mut affected_profile_ids =
        normalize_window_entry_profile_ids(entries, &known_profile_safe_ids(app));
    let (pruned_profile_ids, pruned_count) = prune_overlapping_profile_window_entries(entries);
    affected_profile_ids.extend(pruned_profile_ids);
    if affected_profile_ids.is_empty() {
        return false;
    }
    if pruned_count > 0 {
        debug_registry_log(
            app,
            format!("normalize pruned overlapping window entries count={pruned_count}"),
        );
    }
    persist_entries(app, entries);
    write_profile_snapshots_for_ids(app, entries, &affected_profile_ids);
    true
}

fn load_entries(app: &AppHandle) -> Vec<WindowEntry> {
    let Some(path) = windows_path(app) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut entries = serde_json::from_str::<Vec<WindowEntry>>(&raw).unwrap_or_default();
    normalize_entries_for_app(app, &mut entries);
    entries
}

fn ensure_entries_ready(app: &AppHandle, entries: &mut Vec<WindowEntry>) {
    if entries.is_empty() {
        *entries = load_entries(app);
    } else {
        normalize_entries_for_app(app, entries);
    }
}

fn persist_entries(app: &AppHandle, entries: &[WindowEntry]) {
    let Some(path) = windows_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let persistent = entries
        .iter()
        .filter(|entry| entry.detached_workspace_id.is_none())
        .collect::<Vec<_>>();
    let _ = fs::write(
        path,
        serde_json::to_string_pretty(&persistent).unwrap_or_else(|_| "[]".into()),
    );
}

fn read_global_workspace_snapshot(app: &AppHandle) -> WindowSnapshot {
    workspace_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(snapshot_from_workspace_value)
        .unwrap_or_else(empty_snapshot)
}

fn write_global_workspace(app: &AppHandle, snapshot: &WindowSnapshot) {
    let Some(path) = workspace_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        path,
        serde_json::to_string_pretty(&workspace_value_from_snapshot(snapshot))
            .unwrap_or_else(|_| "{}".into()),
    );
}

fn read_profile_snapshot(app: &AppHandle, profile_id: &str) -> Vec<WindowSnapshot> {
    let Some(path) = profile_path(app, profile_id) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    if value.get("version").and_then(Value::as_i64) == Some(1) {
        let snapshot = snapshot_from_workspace_value(value);
        return if snapshot_has_content(&snapshot) {
            vec![snapshot]
        } else {
            Vec::new()
        };
    }
    let snapshots = value
        .get("windows")
        .and_then(Value::as_array)
        .map(|windows| {
            windows
                .iter()
                .cloned()
                .map(snapshot_from_workspace_value)
                .filter(snapshot_has_content)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    dedupe_snapshots_by_terminal_ids(snapshots)
}

fn write_profile_snapshot(app: &AppHandle, profile_id: &str, windows: &[WindowSnapshot]) {
    let Some(path) = profile_path(app, profile_id) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let name = profile_name(app, profile_id).unwrap_or_else(|| profile_id.to_string());
    let windows = dedupe_snapshots_by_terminal_ids(windows.to_vec());
    let payload = json!({
        "id": profile_id,
        "name": name,
        "version": 2,
        "windows": windows,
    });
    let _ = fs::write(
        path,
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".into()),
    );
}

fn profile_name(app: &AppHandle, profile_id: &str) -> Option<String> {
    let raw = fs::read_to_string(profile_index_path(app)?).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    value
        .get("profiles")?
        .as_array()?
        .iter()
        .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id))
        .and_then(|profile| profile.get("name").and_then(Value::as_str))
        .map(str::to_string)
}

fn profile_windows(entries: &[WindowEntry], profile_id: &str) -> Vec<WindowSnapshot> {
    let mut matching = entries
        .iter()
        .filter(|entry| {
            entry.profile_id == profile_id
                && entry.detached_workspace_id.is_none()
                && snapshot_has_content(&entry.snapshot)
        })
        .collect::<Vec<_>>();
    // Stale duplicate window entries can survive crashes or old profile bugs.
    // When snapshots overlap by terminal ids, keep the most recently active
    // entry so a fresh save cannot be overwritten by an older duplicate.
    matching.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    let snapshots = matching
        .into_iter()
        .map(|entry| entry.snapshot.clone())
        .collect();
    dedupe_snapshots_by_terminal_ids(snapshots)
}

fn latest_profile_workspace_value(entries: &[WindowEntry], profile_id: &str) -> Option<Value> {
    entries
        .iter()
        .filter(|entry| {
            entry.profile_id == profile_id
                && entry.detached_workspace_id.is_none()
                && snapshot_has_content(&entry.snapshot)
        })
        .max_by_key(|entry| entry.last_active_at)
        .map(|entry| workspace_value_from_snapshot(&entry.snapshot))
}

fn snapshot_has_content(snapshot: &WindowSnapshot) -> bool {
    !value_array(&snapshot.workspaces).is_empty()
        || !value_array(&snapshot.terminals).is_empty()
        || snapshot.active_workspace_id.is_some()
        || snapshot.active_terminal_id.is_some()
        || snapshot.active_group.is_some()
}

fn snapshot_terminal_ids(snapshot: &WindowSnapshot) -> HashSet<String> {
    value_array(&snapshot.terminals)
        .into_iter()
        .filter_map(|terminal| value_id(&terminal).map(str::to_string))
        .collect()
}

fn dedupe_snapshots_by_terminal_ids(snapshots: Vec<WindowSnapshot>) -> Vec<WindowSnapshot> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for snapshot in snapshots {
        let terminal_ids = snapshot_terminal_ids(&snapshot);
        if !terminal_ids.is_empty() && terminal_ids.iter().any(|id| seen.contains(id)) {
            continue;
        }
        seen.extend(terminal_ids);
        deduped.push(snapshot);
    }
    deduped
}

fn best_existing_profile_entry(entries: &[WindowEntry]) -> Option<WindowEntry> {
    entries
        .iter()
        .filter(|entry| {
            entry.detached_workspace_id.is_none() && snapshot_has_content(&entry.snapshot)
        })
        .max_by_key(|entry| entry.last_active_at)
        .cloned()
}

fn initial_entry_for_window(
    app: &AppHandle,
    entries: &[WindowEntry],
    window_id: &str,
) -> WindowEntry {
    let inferred_profile_id =
        infer_profile_id_from_window_id(window_id, &known_profile_safe_ids(app))
            .unwrap_or_else(|| DEFAULT_PROFILE_ID.into());
    let mut entry = WindowEntry {
        id: window_id.to_string(),
        profile_id: inferred_profile_id,
        snapshot: empty_snapshot(),
        detached_workspace_id: None,
        detached_parent_window_id: None,
        last_active_at: now_millis(),
    };
    if window_id != "main" {
        return entry;
    }

    let global_snapshot = read_global_workspace_snapshot(app);
    if snapshot_has_content(&global_snapshot) {
        entry.snapshot = global_snapshot;
        return entry;
    }

    if let Some(seed) = best_existing_profile_entry(entries) {
        entry.profile_id = seed.profile_id;
        entry.snapshot = seed.snapshot;
    }
    entry
}

fn bounds_tuple(value: &Value) -> Option<(f64, f64, f64, f64)> {
    Some((
        value.get("x")?.as_f64()?,
        value.get("y")?.as_f64()?,
        value.get("width")?.as_f64()?,
        value.get("height")?.as_f64()?,
    ))
    .filter(|(_, _, width, height)| *width >= 100.0 && *height >= 100.0)
}

fn remove_profile_window_entries(entries: &mut Vec<WindowEntry>, profile_id: &str) {
    let safe_ids = profile_safe_id_map([profile_id.to_string()]);
    entries.retain(|entry| {
        if entry.detached_workspace_id.is_some() {
            return true;
        }
        if entry.profile_id == profile_id {
            return false;
        }
        infer_profile_id_from_window_id(&entry.id, &safe_ids).as_deref() != Some(profile_id)
    });
}

fn remove_profile_window_entry_from_entries(
    entries: &mut Vec<WindowEntry>,
    window_id: &str,
) -> Option<String> {
    let index = entries
        .iter()
        .position(|entry| entry.id == window_id && entry.detached_workspace_id.is_none())?;
    Some(entries.remove(index).profile_id)
}

fn make_window_id(profile_id: &str, index: usize) -> String {
    let safe = safe_profile_id(profile_id);
    format!("profile-{safe}-{}-{index}", now_millis())
}

fn make_detached_window_id(workspace_id: &str) -> String {
    let safe = workspace_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    format!("detached-{safe}-{}", now_millis())
}

pub fn ensure_entry(app: &AppHandle, window_id: &str) -> WindowEntry {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    if let Some(index) = entries.iter().position(|entry| entry.id == window_id) {
        let entry = entries[index].clone();
        if window_id != "main" || snapshot_has_content(&entry.snapshot) {
            return entry;
        }

        let seeded = initial_entry_for_window(app, &entries, window_id);
        if snapshot_has_content(&seeded.snapshot) {
            entries[index] = seeded.clone();
            persist_entries(app, &entries);
            write_global_workspace(app, &seeded.snapshot);
            let windows = profile_windows(&entries, &seeded.profile_id);
            write_profile_snapshot(app, &seeded.profile_id, &windows);
            return seeded;
        }

        return entry;
    }
    let entry = initial_entry_for_window(app, &entries, window_id);
    entries.push(entry.clone());
    persist_entries(app, &entries);
    if window_id == "main" && snapshot_has_content(&entry.snapshot) {
        write_global_workspace(app, &entry.snapshot);
        let windows = profile_windows(&entries, &entry.profile_id);
        write_profile_snapshot(app, &entry.profile_id, &windows);
    }
    entry
}

pub fn get_entry(app: &AppHandle, window_id: &str) -> WindowEntry {
    ensure_entry(app, window_id)
}

pub fn profile_id_for_window(app: &AppHandle, window_id: &str) -> Option<String> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .find(|entry| entry.id == window_id && entry.detached_workspace_id.is_none())
        .map(|entry| entry.profile_id.clone())
}

pub fn has_other_live_profile_windows(
    app: &AppHandle,
    profile_id: &str,
    current_window_id: &str,
) -> bool {
    let live_window_ids = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries.iter().any(|entry| {
        entry.id != current_window_id
            && entry.profile_id == profile_id
            && entry.detached_workspace_id.is_none()
            && live_window_ids.contains(&entry.id)
    })
}

pub fn live_profile_window_count(app: &AppHandle, profile_id: &str) -> usize {
    let live_window_ids = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .filter(|entry| {
            entry.profile_id == profile_id
                && entry.detached_workspace_id.is_none()
                && live_window_ids.contains(&entry.id)
        })
        .count()
}

pub fn window_bounds(app: &AppHandle, window_id: &str) -> Option<(f64, f64, f64, f64)> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .find(|entry| entry.id == window_id)
        .and_then(|entry| entry.snapshot.bounds.as_ref())
        .and_then(bounds_tuple)
}

pub fn update_window_bounds(
    app: &AppHandle,
    window_id: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    if width < 100.0 || height < 100.0 {
        return;
    }
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    let Some(entry) = entries.iter_mut().find(|entry| entry.id == window_id) else {
        return;
    };
    entry.snapshot.bounds = Some(json!({
        "x": x,
        "y": y,
        "width": width,
        "height": height,
    }));
    entry.last_active_at = now_millis();
    let profile_id = entry.profile_id.clone();
    persist_entries(app, &entries);
    let windows = profile_windows(&entries, &profile_id);
    write_profile_snapshot(app, &profile_id, &windows);
}

pub fn mark_window_active(app: &AppHandle, window_id: &str) {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    if let Some(entry) = entries.iter_mut().find(|entry| entry.id == window_id) {
        entry.last_active_at = now_millis();
    } else {
        let entry = initial_entry_for_window(app, &entries, window_id);
        entries.push(entry);
    }
    persist_entries(app, &entries);
}

pub fn latest_live_window_id(app: &AppHandle) -> Option<String> {
    let live_window_ids = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    latest_live_window_id_for_entries(&entries, &live_window_ids)
}

fn latest_live_window_id_for_entries(
    entries: &[WindowEntry],
    live_window_ids: &HashSet<String>,
) -> Option<String> {
    entries
        .iter()
        .filter(|entry| live_window_ids.contains(&entry.id))
        .max_by_key(|entry| entry.last_active_at)
        .map(|entry| entry.id.clone())
}

pub fn window_index(app: &AppHandle, window_id: &str) -> u32 {
    let entry = ensure_entry(app, window_id);
    let live_window_ids = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let state = app.state::<WindowRegistryState>();
    let entries = state.entries.lock().unwrap();
    window_index_for_entries(&entries, &live_window_ids, &entry)
}

fn window_index_for_entries(
    entries: &[WindowEntry],
    live_window_ids: &HashSet<String>,
    entry: &WindowEntry,
) -> u32 {
    entries
        .iter()
        .filter(|candidate| {
            candidate.profile_id == entry.profile_id
                && candidate.detached_workspace_id.is_none()
                && live_window_ids.contains(&candidate.id)
        })
        .position(|candidate| candidate.id == entry.id)
        .map(|idx| idx as u32 + 1)
        .unwrap_or_else(|| {
            entries
                .iter()
                .filter(|candidate| {
                    candidate.profile_id == entry.profile_id
                        && candidate.detached_workspace_id.is_none()
                })
                .position(|candidate| candidate.id == entry.id)
                .map(|idx| idx as u32 + 1)
                .unwrap_or(1)
        })
}

pub fn workspace_json(app: &AppHandle, window_id: &str) -> Option<String> {
    let entry = ensure_entry(app, window_id);
    serde_json::to_string_pretty(&workspace_value_from_snapshot(&entry.snapshot)).ok()
}

pub fn save_workspace_json(app: &AppHandle, window_id: &str, data: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        debug_registry_log(
            app,
            format!(
                "save ignored window={window_id} reason=parse-failed bytes={}",
                data.len()
            ),
        );
        return false;
    };
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    // Ignore saves from windows that no longer have a registry entry.
    // A "Remove from profile" close fires one last workspace.save while the
    // webview tears down — resurrecting the entry there would re-add the
    // window to the profile snapshot and the next launch would restore it.
    let Some(slot_index) = entries.iter().position(|entry| entry.id == window_id) else {
        debug_registry_log(
            app,
            format!(
                "save ignored window={window_id} reason=missing-registry-entry workspaces={} terminals={}",
                value.get("workspaces").map_or(0, value_array_len),
                value.get("terminals").map_or(0, value_array_len)
            ),
        );
        return false;
    };
    let mut entry = entries[slot_index].clone();
    entry.snapshot = snapshot_from_workspace_value(value);
    entry.last_active_at = now_millis();
    entries[slot_index] = entry.clone();
    persist_entries(app, &entries);
    if window_id == "main" {
        write_global_workspace(app, &entry.snapshot);
    }
    let windows = profile_windows(&entries, &entry.profile_id);
    write_profile_snapshot(app, &entry.profile_id, &windows);
    debug_registry_log(
        app,
        format!(
            "save wrote window={} profile={} profileWindows={} snapshotWorkspaces={} snapshotTerminals={}",
            window_id,
            entry.profile_id,
            windows.len(),
            value_array_len(&entry.snapshot.workspaces),
            value_array_len(&entry.snapshot.terminals)
        ),
    );
    true
}

pub fn load_profile_workspace_into_window(
    app: &AppHandle,
    window_id: &str,
    profile_id: &str,
    workspace: Value,
) -> bool {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    let mut entry = entries
        .iter()
        .find(|entry| entry.id == window_id)
        .cloned()
        .unwrap_or_else(|| WindowEntry {
            id: window_id.to_string(),
            profile_id: profile_id.to_string(),
            snapshot: empty_snapshot(),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: now_millis(),
        });
    entry.profile_id = profile_id.to_string();
    entry.snapshot = snapshot_from_workspace_value(workspace);
    entry.detached_workspace_id = None;
    entry.detached_parent_window_id = None;
    entry.last_active_at = now_millis();
    if let Some(slot) = entries
        .iter_mut()
        .find(|candidate| candidate.id == window_id)
    {
        *slot = entry.clone();
    } else {
        entries.push(entry.clone());
    }
    persist_entries(app, &entries);
    if window_id == "main" {
        write_global_workspace(app, &entry.snapshot);
    }
    true
}

pub fn profile_workspace_from_existing_window(app: &AppHandle, profile_id: &str) -> Option<Value> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    latest_profile_workspace_value(&entries, profile_id)
}

// Window id whose snapshot `profile_workspace_from_existing_window` would serve,
// so a remote save can target the same window the matching load reads back.
// Keep the predicate in sync with `latest_profile_workspace_value`.
pub fn latest_profile_window_id(app: &AppHandle, profile_id: &str) -> Option<String> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .filter(|entry| {
            entry.profile_id == profile_id
                && entry.detached_workspace_id.is_none()
                && snapshot_has_content(&entry.snapshot)
        })
        .max_by_key(|entry| entry.last_active_at)
        .map(|entry| entry.id.clone())
}

pub fn move_workspace(
    app: &AppHandle,
    source_window_id: &str,
    target_window_id: &str,
    workspace_id: &str,
    insert_index: usize,
) -> Option<(String, String)> {
    if source_window_id == target_window_id {
        debug_registry_log(
            app,
            format!(
                "move workspace ignored reason=same-window source={} target={} workspace={}",
                source_window_id, target_window_id, workspace_id
            ),
        );
        return None;
    }
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);

    let Some(source_index) = entries
        .iter()
        .position(|entry| entry.id == source_window_id)
    else {
        debug_registry_log(
            app,
            format!(
                "move workspace failed reason=missing-source source={} target={} workspace={} entries={}",
                source_window_id,
                target_window_id,
                workspace_id,
                entries.len()
            ),
        );
        return None;
    };
    let Some(target_index) = entries
        .iter()
        .position(|entry| entry.id == target_window_id)
    else {
        debug_registry_log(
            app,
            format!(
                "move workspace failed reason=missing-target source={} target={} workspace={} entries={}",
                source_window_id,
                target_window_id,
                workspace_id,
                entries.len()
            ),
        );
        return None;
    };
    let mut source = entries[source_index].clone();
    let mut target = entries[target_index].clone();

    let source_profile_id = source.profile_id.clone();
    let target_profile_id = target.profile_id.clone();
    if !move_workspace_between_entries(&mut source, &mut target, workspace_id, insert_index) {
        debug_registry_log(
            app,
            format!(
                "move workspace failed reason=missing-workspace source={} target={} workspace={} sourceProfile={} targetProfile={} sourceWorkspaces={} targetWorkspaces={}",
                source_window_id,
                target_window_id,
                workspace_id,
                source_profile_id,
                target_profile_id,
                value_array_len(&source.snapshot.workspaces),
                value_array_len(&target.snapshot.workspaces)
            ),
        );
        return None;
    }

    source.last_active_at = now_millis();
    target.last_active_at = now_millis();
    entries[source_index] = source.clone();
    entries[target_index] = target.clone();

    persist_entries(app, &entries);
    if source_window_id == "main" {
        write_global_workspace(app, &source.snapshot);
    }
    if target_window_id == "main" {
        write_global_workspace(app, &target.snapshot);
    }
    let source_windows = profile_windows(&entries, &source_profile_id);
    write_profile_snapshot(app, &source_profile_id, &source_windows);
    if target_profile_id != source_profile_id {
        let target_windows = profile_windows(&entries, &target_profile_id);
        write_profile_snapshot(app, &target_profile_id, &target_windows);
    }
    debug_registry_log(
        app,
        format!(
            "move workspace wrote source={} target={} workspace={} sourceProfile={} targetProfile={} sourceWorkspaces={} targetWorkspaces={}",
            source_window_id,
            target_window_id,
            workspace_id,
            source_profile_id,
            target_profile_id,
            value_array_len(&source.snapshot.workspaces),
            value_array_len(&target.snapshot.workspaces)
        ),
    );

    let source_json =
        serde_json::to_string_pretty(&workspace_value_from_snapshot(&source.snapshot))
            .unwrap_or_else(|_| "{}".into());
    let target_json =
        serde_json::to_string_pretty(&workspace_value_from_snapshot(&target.snapshot))
            .unwrap_or_else(|_| "{}".into());
    Some((source_json, target_json))
}

pub fn detached_entry_for_workspace(app: &AppHandle, workspace_id: &str) -> Option<WindowEntry> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .find(|entry| entry.detached_workspace_id.as_deref() == Some(workspace_id))
        .cloned()
}

pub fn create_detached_entry(
    app: &AppHandle,
    parent_window_id: &str,
    workspace_id: &str,
) -> Option<WindowEntry> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    if let Some(entry) = entries
        .iter()
        .find(|entry| entry.detached_workspace_id.as_deref() == Some(workspace_id))
        .cloned()
    {
        return Some(entry);
    }
    let parent = entries
        .iter()
        .find(|entry| entry.id == parent_window_id)
        .cloned()
        .unwrap_or_else(|| WindowEntry {
            id: parent_window_id.to_string(),
            profile_id: DEFAULT_PROFILE_ID.into(),
            snapshot: if parent_window_id == "main" {
                read_global_workspace_snapshot(app)
            } else {
                empty_snapshot()
            },
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: now_millis(),
        });
    if !value_array(&parent.snapshot.workspaces)
        .iter()
        .any(|workspace| value_id(workspace) == Some(workspace_id))
    {
        return None;
    }
    let entry = WindowEntry {
        id: make_detached_window_id(workspace_id),
        profile_id: parent.profile_id,
        snapshot: parent.snapshot,
        detached_workspace_id: Some(workspace_id.to_string()),
        detached_parent_window_id: Some(parent_window_id.to_string()),
        last_active_at: now_millis(),
    };
    entries.push(entry.clone());
    Some(entry)
}

pub fn remove_detached_entry(app: &AppHandle, workspace_id: &str) -> Option<WindowEntry> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    let index = entries
        .iter()
        .position(|entry| entry.detached_workspace_id.as_deref() == Some(workspace_id))?;
    Some(entries.remove(index))
}

pub fn entries_for_profile(app: &AppHandle, profile_id: &str) -> Vec<WindowEntry> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .filter(|entry| entry.profile_id == profile_id && entry.detached_workspace_id.is_none())
        .cloned()
        .collect()
}

pub fn live_window_ids_for_profile(app: &AppHandle, profile_id: &str) -> Vec<String> {
    let live_window_ids = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    entries_for_profile(app, profile_id)
        .into_iter()
        .filter(|entry| live_window_ids.contains(&entry.id))
        .map(|entry| entry.id)
        .collect()
}

pub fn create_entries_for_profile(app: &AppHandle, profile_id: &str) -> Vec<WindowEntry> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    let snapshots = {
        let loaded = read_profile_snapshot(app, profile_id);
        if !loaded.is_empty() {
            loaded
        } else {
            let existing = profile_windows(&entries, profile_id);
            if !existing.is_empty() {
                write_profile_snapshot(app, profile_id, &existing);
                existing
            } else {
                vec![empty_snapshot()]
            }
        }
    };
    remove_profile_window_entries(&mut entries, profile_id);
    let mut created = Vec::new();
    for (idx, snapshot) in snapshots.into_iter().enumerate() {
        let entry = WindowEntry {
            id: make_window_id(profile_id, idx + 1),
            profile_id: profile_id.to_string(),
            snapshot,
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: now_millis(),
        };
        entries.push(entry.clone());
        created.push(entry);
    }
    persist_entries(app, &entries);
    created
}

pub fn create_empty_entry_for_profile(app: &AppHandle, profile_id: &str) -> WindowEntry {
    let state = app.state::<WindowRegistryState>();
    let entry = {
        let mut entries = state.entries.lock().unwrap();
        ensure_entries_ready(app, &mut entries);
        let entry = WindowEntry {
            id: make_window_id(profile_id, entries.len() + 1),
            profile_id: profile_id.to_string(),
            snapshot: empty_snapshot(),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: now_millis(),
        };
        entries.push(entry.clone());
        persist_entries(app, &entries);
        entry
    };
    state.fresh_windows.lock().unwrap().insert(entry.id.clone());
    entry
}

pub fn create_empty_entry_with_id_for_profile(
    app: &AppHandle,
    window_id: &str,
    profile_id: &str,
) -> WindowEntry {
    let state = app.state::<WindowRegistryState>();
    let entry = {
        let mut entries = state.entries.lock().unwrap();
        ensure_entries_ready(app, &mut entries);
        let entry = WindowEntry {
            id: window_id.to_string(),
            profile_id: profile_id.to_string(),
            snapshot: empty_snapshot(),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: now_millis(),
        };
        if let Some(slot) = entries
            .iter_mut()
            .find(|candidate| candidate.id == window_id)
        {
            *slot = entry.clone();
        } else {
            entries.push(entry.clone());
        }
        persist_entries(app, &entries);
        entry
    };
    state.fresh_windows.lock().unwrap().insert(entry.id.clone());
    entry
}

pub fn take_fresh_window_flag(app: &AppHandle, window_id: &str) -> bool {
    let state = app.state::<WindowRegistryState>();
    let mut fresh = state.fresh_windows.lock().unwrap();
    fresh.remove(window_id)
}

pub fn remove_profile_window_entry(app: &AppHandle, window_id: &str) -> Option<String> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    let profile_id = remove_profile_window_entry_from_entries(&mut entries, window_id)?;
    persist_entries(app, &entries);
    let windows = profile_windows(&entries, &profile_id);
    write_profile_snapshot(app, &profile_id, &windows);
    Some(profile_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_snapshot_round_trips_shape() {
        let snapshot = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "w1"}],
            "activeWorkspaceId": "w1",
            "activeGroup": "g1",
            "terminals": [{"id": "t1"}],
            "activeTerminalId": "t1",
        }));
        let value = workspace_value_from_snapshot(&snapshot);
        assert_eq!(value["workspaces"][0]["id"], "w1");
        assert_eq!(value["activeWorkspaceId"], "w1");
        assert_eq!(value["terminals"][0]["id"], "t1");
    }

    #[test]
    fn window_ids_are_profile_scoped() {
        let id = make_window_id("my profile", 1);
        assert!(id.starts_with("profile-my-profile-"));
        assert!(id.ends_with("-1"));
    }

    #[test]
    fn infers_profile_id_from_profile_window_id() {
        let safe_ids = profile_safe_id_map(vec![
            "default".into(),
            "bat".into(),
            "hyper".into(),
            "tonyq.org".into(),
        ]);

        assert_eq!(
            infer_profile_id_from_window_id("profile-bat-1779344644785-23", &safe_ids).as_deref(),
            Some("bat")
        );
        assert_eq!(
            infer_profile_id_from_window_id("profile-hyper-1778574296888-2", &safe_ids).as_deref(),
            Some("hyper")
        );
        assert_eq!(
            infer_profile_id_from_window_id("profile-tonyq-org-1778574296888-1", &safe_ids)
                .as_deref(),
            Some("tonyq.org")
        );
        assert_eq!(
            infer_profile_id_from_window_id("main", &safe_ids).as_deref(),
            None
        );
    }

    #[test]
    fn ambiguous_safe_profile_ids_are_not_inferred() {
        let safe_ids = profile_safe_id_map(vec!["a/b".into(), "a:b".into()]);

        assert_eq!(
            infer_profile_id_from_window_id("profile-a-b-1779344644785-1", &safe_ids).as_deref(),
            None
        );
    }

    #[test]
    fn normalize_window_entry_profile_ids_repairs_migrated_profile_mismatch() {
        let safe_ids = profile_safe_id_map(vec!["default".into(), "bat".into()]);
        let mut entries = vec![
            WindowEntry {
                id: "main".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-bat-1779344644785-23".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-bat-detached".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: Some("w1".into()),
                detached_parent_window_id: Some("profile-bat-1779344644785-23".into()),
                last_active_at: 0,
            },
        ];

        let affected = normalize_window_entry_profile_ids(&mut entries, &safe_ids);
        assert!(affected.contains("default"));
        assert!(affected.contains("bat"));
        assert_eq!(entries[0].profile_id, "default");
        assert_eq!(entries[1].profile_id, "bat");
        assert_eq!(entries[2].profile_id, "default");
    }

    #[test]
    fn prune_overlapping_profile_window_entries_removes_stale_duplicates() {
        let old = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "old"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let recent = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "recent"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let other_profile = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "other-profile"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let unrelated = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "unrelated"}],
            "terminals": [{"id": "t3"}],
        }));
        let mut entries = vec![
            WindowEntry {
                id: "old".into(),
                profile_id: "default".into(),
                snapshot: old,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 10,
            },
            WindowEntry {
                id: "recent".into(),
                profile_id: "default".into(),
                snapshot: recent,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 20,
            },
            WindowEntry {
                id: "other-profile".into(),
                profile_id: "other".into(),
                snapshot: other_profile,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 5,
            },
            WindowEntry {
                id: "unrelated".into(),
                profile_id: "default".into(),
                snapshot: unrelated,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 1,
            },
        ];

        let (affected, removed_count) = prune_overlapping_profile_window_entries(&mut entries);
        let ids = entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(removed_count, 1);
        assert!(affected.contains("default"));
        assert_eq!(ids, vec!["recent", "other-profile", "unrelated"]);
    }

    #[test]
    fn bounds_tuple_rejects_missing_or_tiny_bounds() {
        assert_eq!(
            bounds_tuple(&json!({"x": 10, "y": 20, "width": 1200, "height": 800})),
            Some((10.0, 20.0, 1200.0, 800.0))
        );
        assert_eq!(
            bounds_tuple(&json!({"x": 10, "y": 20, "width": 80, "height": 800})),
            None
        );
        assert_eq!(bounds_tuple(&json!({"x": 10, "width": 1200})), None);
    }

    #[test]
    fn remove_profile_window_entries_keeps_other_profiles_and_detached_entries() {
        let mut entries = vec![
            WindowEntry {
                id: "profile-a-1".into(),
                profile_id: "a".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "detached-a".into(),
                profile_id: "a".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: Some("w1".into()),
                detached_parent_window_id: Some("profile-a-1".into()),
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-b-1".into(),
                profile_id: "b".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
        ];

        remove_profile_window_entries(&mut entries, "a");

        let ids = entries
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["detached-a", "profile-b-1"]);
    }

    #[test]
    fn remove_profile_window_entry_removes_one_regular_window() {
        let mut entries = vec![
            WindowEntry {
                id: "w1".into(),
                profile_id: "a".into(),
                snapshot: snapshot_from_workspace_value(json!({
                    "workspaces": [{"id": "ws1"}],
                    "terminals": [{"id": "t1", "workspaceId": "ws1"}],
                })),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 1,
            },
            WindowEntry {
                id: "w2".into(),
                profile_id: "a".into(),
                snapshot: snapshot_from_workspace_value(json!({
                    "workspaces": [{"id": "ws2"}],
                    "terminals": [{"id": "t2", "workspaceId": "ws2"}],
                })),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 2,
            },
            WindowEntry {
                id: "d1".into(),
                profile_id: "a".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: Some("ws-detached".into()),
                detached_parent_window_id: Some("w1".into()),
                last_active_at: 3,
            },
        ];

        assert_eq!(
            remove_profile_window_entry_from_entries(&mut entries, "w1").as_deref(),
            Some("a")
        );
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["w2", "d1"]
        );
        assert_eq!(profile_windows(&entries, "a").len(), 1);
    }

    #[test]
    fn profile_windows_ignores_empty_snapshots() {
        let mut filled = empty_snapshot();
        filled.workspaces = json!([{"id": "w1"}]);
        let entries = vec![
            WindowEntry {
                id: "main".into(),
                profile_id: "default".into(),
                snapshot: filled,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-default-stale".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
        ];

        assert_eq!(profile_windows(&entries, "default").len(), 1);
    }

    #[test]
    fn profile_windows_dedupes_overlapping_terminal_snapshots() {
        let first = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "w1"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let duplicate = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "w1-copy"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let second = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "w2"}],
            "terminals": [{"id": "t3"}],
        }));
        let entries = vec![
            WindowEntry {
                id: "first".into(),
                profile_id: "default".into(),
                snapshot: first,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "duplicate".into(),
                profile_id: "default".into(),
                snapshot: duplicate,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "second".into(),
                profile_id: "default".into(),
                snapshot: second,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
        ];

        let windows = profile_windows(&entries, "default");
        assert_eq!(windows.len(), 2);
        assert_eq!(
            value_id(&value_array(&windows[0].workspaces)[0]),
            Some("w1")
        );
        assert_eq!(
            value_id(&value_array(&windows[1].workspaces)[0]),
            Some("w2")
        );
    }

    #[test]
    fn profile_windows_dedupes_overlapping_terminal_snapshots_by_recency() {
        let old = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "old"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let recent = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "recent"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let entries = vec![
            WindowEntry {
                id: "old".into(),
                profile_id: "default".into(),
                snapshot: old,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 10,
            },
            WindowEntry {
                id: "recent".into(),
                profile_id: "default".into(),
                snapshot: recent,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 20,
            },
        ];

        let windows = profile_windows(&entries, "default");
        assert_eq!(windows.len(), 1);
        assert_eq!(
            value_id(&value_array(&windows[0].workspaces)[0]),
            Some("recent")
        );
    }

    #[test]
    fn latest_profile_workspace_value_uses_matching_recent_non_empty_window() {
        let older = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "older"}],
            "activeWorkspaceId": "older",
            "terminals": [{"id": "old-term", "workspaceId": "older"}],
            "activeTerminalId": "old-term",
        }));
        let latest = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "latest"}],
            "activeWorkspaceId": "latest",
            "terminals": [{"id": "new-term", "workspaceId": "latest"}],
            "activeTerminalId": "new-term",
        }));
        let other_profile = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "other"}],
            "terminals": [{"id": "other-term", "workspaceId": "other"}],
        }));
        let entries = vec![
            WindowEntry {
                id: "older".into(),
                profile_id: "n".into(),
                snapshot: older,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 100,
            },
            WindowEntry {
                id: "latest-detached".into(),
                profile_id: "n".into(),
                snapshot: snapshot_from_workspace_value(
                    json!({"workspaces": [{"id": "detached"}]}),
                ),
                detached_workspace_id: Some("detached".into()),
                detached_parent_window_id: Some("older".into()),
                last_active_at: 300,
            },
            WindowEntry {
                id: "other".into(),
                profile_id: "default".into(),
                snapshot: other_profile,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 400,
            },
            WindowEntry {
                id: "latest".into(),
                profile_id: "n".into(),
                snapshot: latest,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 200,
            },
        ];

        let workspace = latest_profile_workspace_value(&entries, "n").unwrap();
        assert_eq!(
            workspace.get("activeWorkspaceId").and_then(Value::as_str),
            Some("latest")
        );
        assert_eq!(
            workspace.get("activeTerminalId").and_then(Value::as_str),
            Some("new-term")
        );
    }

    #[test]
    fn best_existing_profile_entry_uses_latest_non_empty_regular_window() {
        let mut older = empty_snapshot();
        older.workspaces = json!([{"id": "older"}]);
        let mut latest_detached = empty_snapshot();
        latest_detached.workspaces = json!([{"id": "detached"}]);
        let mut latest = empty_snapshot();
        latest.workspaces = json!([{"id": "latest"}]);
        let entries = vec![
            WindowEntry {
                id: "empty".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 100,
            },
            WindowEntry {
                id: "older".into(),
                profile_id: "default".into(),
                snapshot: older,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 200,
            },
            WindowEntry {
                id: "detached".into(),
                profile_id: "default".into(),
                snapshot: latest_detached,
                detached_workspace_id: Some("w-detached".into()),
                detached_parent_window_id: Some("older".into()),
                last_active_at: 400,
            },
            WindowEntry {
                id: "latest".into(),
                profile_id: "lineage".into(),
                snapshot: latest,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 300,
            },
        ];

        let entry = best_existing_profile_entry(&entries).unwrap();
        assert_eq!(entry.id, "latest");
        assert_eq!(entry.profile_id, "lineage");
    }

    #[test]
    fn window_index_counts_only_live_profile_windows() {
        let entries = vec![
            WindowEntry {
                id: "main".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-default-stale".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-default-live".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
        ];
        let live_window_ids = ["main".to_string(), "profile-default-live".to_string()]
            .into_iter()
            .collect::<HashSet<_>>();

        assert_eq!(
            window_index_for_entries(&entries, &live_window_ids, &entries[2]),
            2
        );
    }

    #[test]
    fn latest_live_window_id_uses_most_recent_live_entry() {
        let entries = vec![
            WindowEntry {
                id: "main".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 100,
            },
            WindowEntry {
                id: "profile-default-live".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 300,
            },
            WindowEntry {
                id: "profile-default-stale".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 900,
            },
        ];
        let live_window_ids = ["main".to_string(), "profile-default-live".to_string()]
            .into_iter()
            .collect::<HashSet<_>>();

        assert_eq!(
            latest_live_window_id_for_entries(&entries, &live_window_ids).as_deref(),
            Some("profile-default-live")
        );
    }

    #[test]
    fn move_workspace_between_entries_moves_workspace_and_terminals() {
        let mut source = WindowEntry {
            id: "source".into(),
            profile_id: "default".into(),
            snapshot: snapshot_from_workspace_value(json!({
                "workspaces": [
                    {"id": "w1", "focusedTerminalId": "t1"},
                    {"id": "w2", "focusedTerminalId": "t3"}
                ],
                "activeWorkspaceId": "w1",
                "terminals": [
                    {"id": "t1", "workspaceId": "w1"},
                    {"id": "t2", "workspaceId": "w1"},
                    {"id": "t3", "workspaceId": "w2"}
                ],
                "activeTerminalId": "t1"
            })),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: 0,
        };
        let mut target = WindowEntry {
            id: "target".into(),
            profile_id: "default".into(),
            snapshot: snapshot_from_workspace_value(json!({
                "workspaces": [{"id": "w3"}],
                "activeWorkspaceId": "w3",
                "terminals": [{"id": "t4", "workspaceId": "w3"}],
                "activeTerminalId": "t4"
            })),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: 0,
        };

        assert!(move_workspace_between_entries(
            &mut source,
            &mut target,
            "w1",
            0
        ));

        assert_eq!(source.snapshot.workspaces[0]["id"], "w2");
        assert_eq!(source.snapshot.active_workspace_id.as_deref(), Some("w2"));
        assert_eq!(source.snapshot.active_terminal_id.as_deref(), Some("t3"));
        assert_eq!(source.snapshot.terminals.as_array().unwrap().len(), 1);
        assert_eq!(target.snapshot.workspaces[0]["id"], "w1");
        assert_eq!(target.snapshot.workspaces[1]["id"], "w3");
        assert_eq!(target.snapshot.active_workspace_id.as_deref(), Some("w1"));
        assert_eq!(target.snapshot.active_terminal_id.as_deref(), Some("t1"));
        assert_eq!(target.snapshot.terminals.as_array().unwrap().len(), 3);
    }
}
