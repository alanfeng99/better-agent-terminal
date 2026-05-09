// profile:* — single-window MVP stub.
//
// The Electron impl (electron/profile-manager.ts) is a substantial
// piece of work: per-profile JSON snapshots under
// `<userData>/profiles/{id}.json`, a top-level index, encrypted
// remote tokens, per-window active profile tracking. None of that
// is needed for the Tauri MVP — we ship one window, no remote
// support, and workspace state already persists through
// `host.workspace.{load,save}` (`<app-data>/workspaces.json`).
//
// So this module exposes the renderer-visible surface but reduces
// it to a single immutable default profile:
//   - `profile_list` / `profile_list_local` return one entry.
//   - `profile_get` returns the entry by id (or None for unknown).
//   - `profile_get_active_ids` returns ["default"].
//   - `profile_load` / `profile_save` collapse to no-ops because
//     the workspace store already round-trips through Tauri.
//   - mutating commands (`create`, `delete`, `rename`, `update`,
//     `duplicate`, `activate`, `deactivate`) succeed silently or
//     hand back the existing default — never error so the renderer
//     keeps running while the full impl is rebuilt under Tauri.
//
// Once we add multi-window or remote profiles, this gets replaced
// by a real on-disk index keyed off the same JSON layout the
// Electron side uses (so an in-place migration is a copy).

use serde::{Deserialize, Serialize};

const DEFAULT_PROFILE_ID: &str = "default";
const DEFAULT_PROFILE_NAME: &str = "Default";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_port: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_profile_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileListResponse {
    pub profiles: Vec<ProfileEntry>,
    pub active_profile_ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProfileOptions {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub remote_host: Option<String>,
    pub remote_port: Option<u32>,
    pub remote_token: Option<String>,
    pub remote_fingerprint: Option<String>,
    pub remote_profile_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileOptions {
    pub remote_host: Option<String>,
    pub remote_port: Option<u32>,
    pub remote_token: Option<String>,
    pub remote_fingerprint: Option<String>,
    pub remote_profile_id: Option<String>,
}

fn default_entry() -> ProfileEntry {
    ProfileEntry {
        id: DEFAULT_PROFILE_ID.into(),
        name: DEFAULT_PROFILE_NAME.into(),
        kind: "local".into(),
        remote_host: None,
        remote_port: None,
        remote_token: None,
        remote_fingerprint: None,
        remote_profile_id: None,
        // Use 0 rather than `now` so the constants are stable across
        // tests and reboots. The renderer doesn't surface
        // createdAt/updatedAt for the default profile.
        created_at: 0,
        updated_at: 0,
    }
}

fn list_response() -> ProfileListResponse {
    ProfileListResponse {
        profiles: vec![default_entry()],
        active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
    }
}

#[tauri::command]
pub fn profile_list() -> ProfileListResponse {
    list_response()
}

#[tauri::command]
pub fn profile_list_local() -> ProfileListResponse {
    list_response()
}

#[tauri::command]
pub fn profile_get(profile_id: String) -> Option<ProfileEntry> {
    if profile_id == DEFAULT_PROFILE_ID {
        Some(default_entry())
    } else {
        None
    }
}

#[tauri::command]
pub fn profile_get_active_ids() -> Vec<String> {
    vec![DEFAULT_PROFILE_ID.into()]
}

#[tauri::command]
pub fn profile_create(
    name: String,
    _options: Option<CreateProfileOptions>,
) -> ProfileEntry {
    // We accept the call so the ProfilePanel UI doesn't choke,
    // but only the default profile is real. Echo back a synthetic
    // entry that uses the supplied name; it won't persist across
    // reloads. Once profile.* gets a real Rust impl this becomes
    // an actual create.
    ProfileEntry {
        id: DEFAULT_PROFILE_ID.into(),
        name,
        ..default_entry()
    }
}

#[tauri::command]
pub fn profile_save(_profile_id: String) -> bool {
    // Workspace state already round-trips through host.workspace —
    // there's nothing additional to persist for the default profile.
    true
}

#[tauri::command]
pub fn profile_load(_profile_id: String) -> serde_json::Value {
    // Renderer reads the snapshot via the workspace store, not via
    // the return value here. Returning null is the same shape the
    // Electron handler returns when there is no saved snapshot.
    serde_json::Value::Null
}

#[tauri::command]
pub fn profile_delete(_profile_id: String) -> bool {
    // The default profile is intentionally non-deletable.
    false
}

#[tauri::command]
pub fn profile_rename(_profile_id: String, _new_name: String) -> bool {
    false
}

#[tauri::command]
pub fn profile_update(
    _profile_id: String,
    _updates: Option<UpdateProfileOptions>,
) -> bool {
    false
}

#[tauri::command]
pub fn profile_duplicate(
    _profile_id: String,
    _new_name: String,
) -> Option<ProfileEntry> {
    None
}

#[tauri::command]
pub fn profile_activate(_profile_id: String) {
    // Single-window MVP: the active profile is always "default".
}

#[tauri::command]
pub fn profile_deactivate(_profile_id: String) {
    // Single-window MVP: deactivation is a no-op.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_returns_single_default_entry() {
        let r = profile_list();
        assert_eq!(r.profiles.len(), 1);
        assert_eq!(r.profiles[0].id, DEFAULT_PROFILE_ID);
        assert_eq!(r.profiles[0].name, DEFAULT_PROFILE_NAME);
        assert_eq!(r.profiles[0].kind, "local");
        assert_eq!(r.active_profile_ids, vec![DEFAULT_PROFILE_ID.to_string()]);
    }

    #[test]
    fn list_serializes_camel_case() {
        // The renderer expects `activeProfileIds` (camelCase). Guard
        // the serde rename so a refactor doesn't silently break the
        // App.tsx mount path.
        let r = list_response();
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"activeProfileIds\":[\"default\"]"));
        assert!(json.contains("\"createdAt\":0"));
        assert!(json.contains("\"updatedAt\":0"));
    }

    #[test]
    fn get_returns_entry_only_for_default_id() {
        assert!(profile_get(DEFAULT_PROFILE_ID.into()).is_some());
        assert!(profile_get("missing".into()).is_none());
    }

    #[test]
    fn get_active_ids_always_default() {
        assert_eq!(profile_get_active_ids(), vec![DEFAULT_PROFILE_ID.to_string()]);
    }

    #[test]
    fn create_echoes_name_into_synthetic_entry() {
        // We don't persist new profiles, but the UI flow expects the
        // returned entry to carry the requested name (it'll display
        // the toast based on that). The id stays "default" because
        // there's only one slot.
        let e = profile_create("My Profile".into(), None);
        assert_eq!(e.name, "My Profile");
        assert_eq!(e.id, DEFAULT_PROFILE_ID);
    }

    #[test]
    fn delete_rename_update_duplicate_are_rejected() {
        // The default profile is non-deletable / non-renameable in
        // the MVP. Once the full Rust impl lands these commands
        // will start mutating. Until then they reject so the
        // renderer's existing "operation failed" toast trips.
        assert!(!profile_delete("anything".into()));
        assert!(!profile_rename("anything".into(), "new".into()));
        assert!(!profile_update("anything".into(), None));
        assert!(profile_duplicate("anything".into(), "copy".into()).is_none());
    }

    #[test]
    fn save_returns_true_load_returns_null() {
        // Workspace state goes through host.workspace, so save/load
        // here are intentionally trivial. Save returns true so the
        // renderer's success path engages; load returns Null so the
        // "no snapshot for this profile" branch engages.
        assert!(profile_save("default".into()));
        assert_eq!(profile_load("default".into()), serde_json::Value::Null);
    }
}
