// profile:* — Tauri profile index persistence.
//
// Electron stores profile metadata in <userData>/profiles/index.json and keeps
// remote tokens in a separate safeStorage envelope. Tauri does not currently
// have an OS-keychain wrapper in this app, so this port uses the same envelope
// shape as the sidecar remote secrets module: {enc:false,data:<json>} with
// owner-only file permissions where the platform supports them. Keeping tokens
// out of index.json preserves the migration path for a later encrypted store.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const DEFAULT_PROFILE_ID: &str = "default";
const DEFAULT_PROFILE_NAME: &str = "Default";
const INDEX_FILE: &str = "index.json";
const TOKEN_FILE: &str = "remote-tokens.enc.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileListResponse {
    pub profiles: Vec<ProfileEntry>,
    pub active_profile_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileIndex {
    #[serde(default)]
    pub profiles: Vec<ProfileEntry>,
    #[serde(default)]
    pub active_profile_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_profile_id: Option<String>,
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

#[derive(Debug, Default, Serialize, Deserialize)]
struct RemoteTokenStore {
    tokens: HashMap<String, String>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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
        created_at: 0,
        updated_at: 0,
    }
}

fn default_index() -> ProfileIndex {
    ProfileIndex {
        profiles: vec![default_entry()],
        active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
        active_profile_id: None,
    }
}

fn profiles_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("profiles"))
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.to_lowercase().chars() {
        let keep = ch.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch);
        if keep {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "profile".into()
    } else {
        trimmed
    }
}

fn normalize_index(mut index: ProfileIndex) -> ProfileIndex {
    if index.active_profile_ids.is_empty() {
        if let Some(id) = index.active_profile_id.take() {
            index.active_profile_ids = vec![id];
        }
    }
    if index.active_profile_ids.is_empty() {
        index.active_profile_ids = vec![DEFAULT_PROFILE_ID.into()];
    }
    if !index
        .profiles
        .iter()
        .any(|profile| profile.id == DEFAULT_PROFILE_ID)
    {
        index.profiles.insert(0, default_entry());
    }
    index
        .profiles
        .retain(|profile| !profile.id.trim().is_empty() && !profile.name.trim().is_empty());
    index.active_profile_id = None;
    index
}

fn read_token_store(dir: &Path) -> RemoteTokenStore {
    let path = dir.join(TOKEN_FILE);
    let Ok(raw) = fs::read_to_string(path) else {
        return RemoteTokenStore::default();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return RemoteTokenStore::default();
    };
    if value.get("enc").and_then(Value::as_bool) == Some(true) {
        return RemoteTokenStore::default();
    }
    if value.get("enc").and_then(Value::as_bool) == Some(false) {
        if let Some(data) = value.get("data").and_then(Value::as_str) {
            return serde_json::from_str::<RemoteTokenStore>(data).unwrap_or_default();
        }
    }
    serde_json::from_value::<RemoteTokenStore>(value).unwrap_or_default()
}

fn write_owner_only(path: &Path, content: String) -> std::io::Result<()> {
    fs::write(path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn write_token_store(dir: &Path, store: &RemoteTokenStore) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let payload = json!({
        "enc": false,
        "data": serde_json::to_string(store).unwrap_or_else(|_| "{}".into()),
    });
    write_owner_only(
        &dir.join(TOKEN_FILE),
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".into()),
    )
}

fn hydrate_remote_tokens(dir: &Path, mut index: ProfileIndex) -> ProfileIndex {
    let store = read_token_store(dir);
    for profile in &mut index.profiles {
        if profile.kind == "remote" && profile.remote_token.is_none() {
            profile.remote_token = store.tokens.get(&profile.id).cloned();
        }
    }
    index
}

fn strip_and_persist_remote_tokens(
    dir: &Path,
    mut index: ProfileIndex,
) -> std::io::Result<ProfileIndex> {
    let mut store = read_token_store(dir);
    let ids = index
        .profiles
        .iter()
        .map(|profile| profile.id.clone())
        .collect::<HashSet<_>>();
    for profile in &mut index.profiles {
        if profile.kind == "remote" {
            if let Some(token) = profile.remote_token.take() {
                store.tokens.insert(profile.id.clone(), token);
            }
        } else {
            profile.remote_token = None;
            store.tokens.remove(&profile.id);
        }
    }
    store.tokens.retain(|id, _| ids.contains(id));
    write_token_store(dir, &store)?;
    Ok(index)
}

fn read_index_at(dir: &Path) -> ProfileIndex {
    let path = dir.join(INDEX_FILE);
    let Ok(raw) = fs::read_to_string(path) else {
        return default_index();
    };
    let parsed = serde_json::from_str::<ProfileIndex>(&raw).unwrap_or_else(|_| default_index());
    hydrate_remote_tokens(dir, normalize_index(parsed))
}

fn write_index_at(dir: &Path, index: ProfileIndex) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let clean = strip_and_persist_remote_tokens(dir, normalize_index(index))?;
    write_owner_only(
        &dir.join(INDEX_FILE),
        serde_json::to_string_pretty(&clean).unwrap_or_else(|_| "{}".into()),
    )
}

fn list_response_at(dir: &Path) -> ProfileListResponse {
    let index = read_index_at(dir);
    ProfileListResponse {
        profiles: index.profiles,
        active_profile_ids: index.active_profile_ids,
    }
}

fn unique_profile_id(index: &ProfileIndex, name: &str) -> String {
    let base = slugify(name);
    let ids = index
        .profiles
        .iter()
        .map(|profile| profile.id.as_str())
        .collect::<HashSet<_>>();
    if !ids.contains(base.as_str()) {
        return base;
    }
    for n in 2..10_000 {
        let candidate = format!("{base}-{n}");
        if !ids.contains(candidate.as_str()) {
            return candidate;
        }
    }
    format!("{base}-{}", now_millis())
}

fn profile_from_options(
    id: String,
    name: String,
    options: Option<CreateProfileOptions>,
) -> ProfileEntry {
    let now = now_millis();
    let options = options.unwrap_or_default();
    let kind = options.kind.unwrap_or_else(|| "local".into());
    ProfileEntry {
        id,
        name,
        kind: if kind == "remote" {
            "remote".into()
        } else {
            "local".into()
        },
        remote_host: options.remote_host,
        remote_port: options.remote_port,
        remote_token: options.remote_token,
        remote_fingerprint: options.remote_fingerprint,
        remote_profile_id: options.remote_profile_id,
        created_at: now,
        updated_at: now,
    }
}

#[tauri::command]
pub fn profile_list(app: AppHandle) -> ProfileListResponse {
    profiles_dir(&app)
        .map(|dir| list_response_at(&dir))
        .unwrap_or_else(|| ProfileListResponse {
            profiles: vec![default_entry()],
            active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
        })
}

#[tauri::command]
pub fn profile_list_local(app: AppHandle) -> ProfileListResponse {
    let mut response = profile_list(app);
    response.profiles.retain(|profile| profile.kind == "local");
    if response.profiles.is_empty() {
        response.profiles.push(default_entry());
    }
    response
}

#[tauri::command]
pub fn profile_get(app: AppHandle, profile_id: String) -> Option<ProfileEntry> {
    let dir = profiles_dir(&app)?;
    read_index_at(&dir)
        .profiles
        .into_iter()
        .find(|profile| profile.id == profile_id)
}

#[tauri::command]
pub fn profile_get_active_ids(app: AppHandle) -> Vec<String> {
    profiles_dir(&app)
        .map(|dir| read_index_at(&dir).active_profile_ids)
        .unwrap_or_else(|| vec![DEFAULT_PROFILE_ID.into()])
}

#[tauri::command]
pub fn profile_create(
    app: AppHandle,
    name: String,
    options: Option<CreateProfileOptions>,
) -> ProfileEntry {
    let Some(dir) = profiles_dir(&app) else {
        return profile_from_options(DEFAULT_PROFILE_ID.into(), name, options);
    };
    let mut index = read_index_at(&dir);
    let id = unique_profile_id(&index, &name);
    let entry = profile_from_options(id, name, options);
    index.profiles.push(entry.clone());
    let _ = write_index_at(&dir, index);
    entry
}

#[tauri::command]
pub fn profile_save(_app: AppHandle, _profile_id: String) -> bool {
    true
}

#[tauri::command]
pub fn profile_load(_app: AppHandle, _profile_id: String) -> Value {
    Value::Null
}

#[tauri::command]
pub fn profile_delete(app: AppHandle, profile_id: String) -> bool {
    if profile_id == DEFAULT_PROFILE_ID {
        return false;
    }
    let Some(dir) = profiles_dir(&app) else {
        return false;
    };
    let mut index = read_index_at(&dir);
    let before = index.profiles.len();
    index.profiles.retain(|profile| profile.id != profile_id);
    index.active_profile_ids.retain(|id| id != &profile_id);
    if before == index.profiles.len() {
        return false;
    }
    write_index_at(&dir, index).is_ok()
}

#[tauri::command]
pub fn profile_rename(app: AppHandle, profile_id: String, new_name: String) -> bool {
    let Some(dir) = profiles_dir(&app) else {
        return false;
    };
    let mut index = read_index_at(&dir);
    let Some(profile) = index
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
    else {
        return false;
    };
    profile.name = new_name;
    profile.updated_at = now_millis();
    write_index_at(&dir, index).is_ok()
}

#[tauri::command]
pub fn profile_update(
    app: AppHandle,
    profile_id: String,
    updates: Option<UpdateProfileOptions>,
) -> bool {
    let Some(dir) = profiles_dir(&app) else {
        return false;
    };
    let Some(updates) = updates else {
        return false;
    };
    let mut index = read_index_at(&dir);
    let Some(profile) = index
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
    else {
        return false;
    };
    if let Some(value) = updates.remote_host {
        profile.remote_host = Some(value);
    }
    if let Some(value) = updates.remote_port {
        profile.remote_port = Some(value);
    }
    if let Some(value) = updates.remote_token {
        profile.remote_token = Some(value);
    }
    if let Some(value) = updates.remote_fingerprint {
        profile.remote_fingerprint = Some(value);
    }
    if updates.remote_profile_id.is_some() {
        profile.remote_profile_id = updates.remote_profile_id;
    }
    if profile.remote_host.is_some() || profile.remote_fingerprint.is_some() {
        profile.kind = "remote".into();
    }
    profile.updated_at = now_millis();
    write_index_at(&dir, index).is_ok()
}

#[tauri::command]
pub fn profile_duplicate(
    app: AppHandle,
    profile_id: String,
    new_name: String,
) -> Option<ProfileEntry> {
    let dir = profiles_dir(&app)?;
    let mut index = read_index_at(&dir);
    let source = index
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)?
        .clone();
    let now = now_millis();
    let mut copy = source;
    copy.id = unique_profile_id(&index, &new_name);
    copy.name = new_name;
    copy.created_at = now;
    copy.updated_at = now;
    index.profiles.push(copy.clone());
    write_index_at(&dir, index).ok()?;
    Some(copy)
}

#[tauri::command]
pub fn profile_activate(app: AppHandle, profile_id: String) {
    let Some(dir) = profiles_dir(&app) else {
        return;
    };
    let mut index = read_index_at(&dir);
    if index
        .profiles
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        index.active_profile_ids = vec![profile_id];
        let _ = write_index_at(&dir, index);
    }
}

#[tauri::command]
pub fn profile_deactivate(app: AppHandle, profile_id: String) {
    let Some(dir) = profiles_dir(&app) else {
        return;
    };
    let mut index = read_index_at(&dir);
    index.active_profile_ids.retain(|id| id != &profile_id);
    if index.active_profile_ids.is_empty() {
        index.active_profile_ids.push(DEFAULT_PROFILE_ID.into());
    }
    let _ = write_index_at(&dir, index);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_profile_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bat-profile-test-{}-{}-{name}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_returns_single_default_entry_for_empty_dir() {
        let dir = temp_profile_dir("empty");
        let r = list_response_at(&dir);
        assert_eq!(r.profiles.len(), 1);
        assert_eq!(r.profiles[0].id, DEFAULT_PROFILE_ID);
        assert_eq!(r.profiles[0].name, DEFAULT_PROFILE_NAME);
        assert_eq!(r.profiles[0].kind, "local");
        assert_eq!(r.active_profile_ids, vec![DEFAULT_PROFILE_ID.to_string()]);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn list_serializes_camel_case() {
        let r = ProfileListResponse {
            profiles: vec![default_entry()],
            active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"activeProfileIds\":[\"default\"]"));
        assert!(json.contains("\"createdAt\":0"));
        assert!(json.contains("\"updatedAt\":0"));
    }

    #[test]
    fn profile_index_create_rename_delete_round_trips() {
        let dir = temp_profile_dir("crud");
        let mut index = read_index_at(&dir);
        let entry = profile_from_options(
            unique_profile_id(&index, "My Profile"),
            "My Profile".into(),
            None,
        );
        index.profiles.push(entry.clone());
        write_index_at(&dir, index).unwrap();

        let mut index = read_index_at(&dir);
        assert!(index.profiles.iter().any(|profile| profile.id == entry.id));
        let profile = index
            .profiles
            .iter_mut()
            .find(|profile| profile.id == entry.id)
            .unwrap();
        profile.name = "Renamed".into();
        write_index_at(&dir, index).unwrap();

        let mut index = read_index_at(&dir);
        assert!(index
            .profiles
            .iter()
            .any(|profile| profile.name == "Renamed"));
        index.profiles.retain(|profile| profile.id != entry.id);
        write_index_at(&dir, index).unwrap();
        assert!(!read_index_at(&dir)
            .profiles
            .iter()
            .any(|profile| profile.id == entry.id));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn remote_tokens_are_stored_outside_index_and_rehydrated() {
        let dir = temp_profile_dir("tokens");
        let remote = profile_from_options(
            "remote-1".into(),
            "Remote".into(),
            Some(CreateProfileOptions {
                kind: Some("remote".into()),
                remote_host: Some("127.0.0.1".into()),
                remote_port: Some(9876),
                remote_token: Some("secret-token".into()),
                remote_fingerprint: Some("AA".into()),
                remote_profile_id: Some("default".into()),
            }),
        );
        write_index_at(
            &dir,
            ProfileIndex {
                profiles: vec![default_entry(), remote],
                active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
                active_profile_id: None,
            },
        )
        .unwrap();

        let index_raw = fs::read_to_string(dir.join(INDEX_FILE)).unwrap();
        assert!(!index_raw.contains("secret-token"));
        let rehydrated = read_index_at(&dir);
        let remote = rehydrated
            .profiles
            .iter()
            .find(|profile| profile.id == "remote-1")
            .unwrap();
        assert_eq!(remote.remote_token.as_deref(), Some("secret-token"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn duplicate_assigns_new_id_and_name() {
        let dir = temp_profile_dir("duplicate");
        let mut index = read_index_at(&dir);
        let source =
            profile_from_options(unique_profile_id(&index, "Source"), "Source".into(), None);
        index.profiles.push(source.clone());
        let new_id = unique_profile_id(&index, "Source Copy");
        let mut copy = source.clone();
        copy.id = new_id;
        copy.name = "Source Copy".into();
        index.profiles.push(copy.clone());
        write_index_at(&dir, index).unwrap();

        let ids = read_index_at(&dir)
            .profiles
            .into_iter()
            .map(|profile| profile.id)
            .collect::<HashSet<_>>();
        assert!(ids.contains(&source.id));
        assert!(ids.contains(&copy.id));
        assert_ne!(source.id, copy.id);
        fs::remove_dir_all(dir).ok();
    }
}
