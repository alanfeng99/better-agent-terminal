// Codex unified-account store (Tier 2).
//
// Mirrors the Claude credential-swap model (`account_store.rs`) but for Codex.
// In unified mode the single Codex app-server always runs with
// `CODEX_HOME = ~/.codex`, so `~/.codex/sessions` is a SHARED session store.
// Each account's *identity bundle* — everything in a CODEX_HOME EXCEPT the
// `sessions/` directory (i.e. `auth.json`, `config.toml`, memory files, …) —
// is stored on disk under `<app-data>/codex-accounts/<id>/`. Switching an
// account swaps that bundle into `~/.codex` without ever touching `sessions/`,
// so both accounts see the same sessions and can continue each other's work,
// while auth/memory stay per-account.
//
// Everything here is filesystem-only (no OS keyring) because a Codex identity
// is multiple files, not a single secret string. The whole feature is gated by
// the caller (`codex_app_server::codex_unified_enabled`) — none of this runs
// unless the user opts in.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

const INDEX_FILE: &str = "codex-accounts.json";
const ACCOUNTS_DIR: &str = "codex-accounts";
const SESSIONS_DIRNAME: &str = "sessions";
const STAGING_PREFIX: &str = ".bat-staging";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum CodexAccountStoreError {
    #[error("codex account IO error: {0}")]
    Io(#[from] io::Error),
    #[error("codex account JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

fn other<E: std::fmt::Display>(msg: E) -> CodexAccountStoreError {
    CodexAccountStoreError::Other(msg.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexUnifiedAccount {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_home: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUnifiedIndex {
    pub accounts: Vec<CodexUnifiedAccount>,
    pub active_account_id: Option<String>,
    pub migrated: bool,
    pub schema_version: u32,
}

impl Default for CodexUnifiedIndex {
    fn default() -> Self {
        Self {
            accounts: Vec::new(),
            active_account_id: None,
            migrated: false,
            schema_version: SCHEMA_VERSION,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub accounts_registered: usize,
    pub sessions_copied: usize,
    pub sessions_skipped: usize,
    pub collisions: usize,
    pub active_account_id: Option<String>,
    pub already_migrated: bool,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Deterministic, version-stable hash (FNV-1a 64-bit). Used only for fallback
// id derivation; `auth.json` account_id is the primary, fully-stable key.
fn stable_hash(input: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn sanitize(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    let result = if trimmed.is_empty() { "codex" } else { trimmed };
    result.chars().take(64).collect()
}

fn is_staging_name(name: &OsStr) -> bool {
    name.to_str()
        .map(|n| n.starts_with(STAGING_PREFIX))
        .unwrap_or(false)
}

fn is_sessions_name(name: &OsStr) -> bool {
    name == OsStr::new(SESSIONS_DIRNAME)
}

/// Decode a JWT and return its `email` claim (Codex ChatGPT-OAuth stores the
/// email inside `tokens.id_token`, not as a plain field). Best-effort.
fn jwt_email_claim(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims = serde_json::from_slice::<Value>(&bytes).ok()?;
    claims
        .get("email")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Read `<home>/auth.json` and extract `(account_id, email)` (best-effort).
/// Mirrors the field probing in `codex_app_server::codex_auth_summary`, plus
/// an `id_token` JWT fallback for ChatGPT-OAuth Codex accounts.
pub fn read_auth_identity(home: &Path) -> (Option<String>, Option<String>) {
    let Ok(raw) = fs::read_to_string(home.join("auth.json")) else {
        return (None, None);
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return (None, None);
    };
    let account_id = value
        .get("account_id")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/tokens/account_id").and_then(Value::as_str))
        .or_else(|| value.pointer("/account/id").and_then(Value::as_str))
        .map(str::to_string);
    let email = value
        .get("email")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/profile/email").and_then(Value::as_str))
        .or_else(|| value.pointer("/account/email").and_then(Value::as_str))
        .or_else(|| value.pointer("/tokens/email").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| {
            value
                .pointer("/tokens/id_token")
                .and_then(Value::as_str)
                .and_then(jwt_email_claim)
        });
    (account_id, email)
}

/// Stable account id for a home. Priority: auth account_id → email hash →
/// source dir name → path hash. Deterministic so migration upserts (never dups).
pub fn derive_account_id(home: &Path) -> String {
    let (account_id, email) = read_auth_identity(home);
    if let Some(acct) = account_id.filter(|s| !s.trim().is_empty()) {
        return format!("acct-{}", sanitize(acct.trim()));
    }
    if let Some(email) = email.filter(|s| !s.trim().is_empty()) {
        return format!("email-{}", &stable_hash(email.trim())[..12]);
    }
    if let Some(name) = home
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
    {
        return format!("home-{}", sanitize(name));
    }
    format!("home-{}", &stable_hash(&home.to_string_lossy())[..12])
}

fn label_for(home: &Path, email: &Option<String>) -> String {
    if let Some(email) = email.as_ref().filter(|s| !s.trim().is_empty()) {
        return email.clone();
    }
    home.file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Codex")
        .to_string()
}

// --- index persistence ----------------------------------------------------

fn index_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(INDEX_FILE)
}

fn accounts_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(ACCOUNTS_DIR)
}

pub fn account_store_dir(app_data_dir: &Path, id: &str) -> PathBuf {
    accounts_root(app_data_dir).join(id)
}

fn normalize_index(mut index: CodexUnifiedIndex) -> CodexUnifiedIndex {
    index.accounts.retain(|a| !a.id.trim().is_empty());
    if let Some(active) = &index.active_account_id {
        if !index.accounts.iter().any(|a| &a.id == active) {
            index.active_account_id = None;
        }
    }
    if index.schema_version == 0 {
        index.schema_version = SCHEMA_VERSION;
    }
    index
}

pub fn read_index(app_data_dir: &Path) -> CodexUnifiedIndex {
    let Ok(raw) = fs::read_to_string(index_path(app_data_dir)) else {
        return CodexUnifiedIndex::default();
    };
    let parsed = serde_json::from_str::<CodexUnifiedIndex>(&raw).unwrap_or_default();
    normalize_index(parsed)
}

pub fn write_index(
    app_data_dir: &Path,
    index: &CodexUnifiedIndex,
) -> Result<(), CodexAccountStoreError> {
    fs::create_dir_all(app_data_dir)?;
    let path = index_path(app_data_dir);
    let clean = normalize_index(index.clone());
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&clean)?)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

// --- identity file operations (never touch `sessions/`) --------------------

fn list_identity_top_level(dir: &Path) -> io::Result<HashSet<OsString>> {
    let mut names = HashSet::new();
    if !dir.exists() {
        return Ok(names);
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if is_sessions_name(&name) || is_staging_name(&name) {
            continue;
        }
        names.insert(name);
    }
    Ok(names)
}

fn copy_file_atomic(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = to.with_extension(format!("bat-tmp-{}", std::process::id()));
    fs::copy(from, &tmp)?;
    fs::rename(&tmp, to)?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            continue; // don't follow/copy symlinks
        } else if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            copy_file_atomic(&from, &to)?;
        }
    }
    Ok(())
}

/// Make `dst`'s identity files mirror `src`'s, NEVER removing or copying the
/// `sessions/` directory (or any leftover staging dirs). Used for both
/// snapshot (src=shared_home, dst=store) and load (src=store, dst=shared_home).
fn sync_identity(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    let src_names = list_identity_top_level(src)?;
    // Remove stale identity entries in dst not present in src.
    for entry in fs::read_dir(dst)? {
        let entry = entry?;
        let name = entry.file_name();
        if is_sessions_name(&name) || is_staging_name(&name) {
            continue;
        }
        if !src_names.contains(&name) {
            let path = entry.path();
            if path.is_dir() {
                let _ = fs::remove_dir_all(&path);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
    }
    // Copy src identity entries into dst (overwrite).
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if is_sessions_name(&name) || is_staging_name(&name) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            continue;
        } else if ft.is_dir() {
            // Replace dir wholesale to drop stale nested files.
            let _ = fs::remove_dir_all(&to);
            copy_dir_recursive(&from, &to)?;
        } else {
            copy_file_atomic(&from, &to)?;
        }
    }
    Ok(())
}

fn dir_has_entries(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
}

// --- public operations ----------------------------------------------------

fn find_account<'a>(index: &'a CodexUnifiedIndex, id: &str) -> Option<&'a CodexUnifiedAccount> {
    index.accounts.iter().find(|a| a.id == id)
}

/// Resolve a UI selector (account id, or a legacy source-home path) to an id.
pub fn resolve_selector(index: &CodexUnifiedIndex, selector: &str) -> Option<String> {
    if index.accounts.iter().any(|a| a.id == selector) {
        return Some(selector.to_string());
    }
    index
        .accounts
        .iter()
        .find(|a| a.source_home.as_deref() == Some(selector))
        .map(|a| a.id.clone())
}

/// Snapshot the live identity in `shared_home` back into the active account's
/// store (captures token refresh / new memory). Best-effort.
pub fn snapshot_active_for_exit(app_data_dir: &Path, shared_home: &Path) {
    let index = read_index(app_data_dir);
    let Some(active) = index.active_account_id else {
        return;
    };
    // Don't overwrite the store with a torn/empty auth.json read.
    let (acct, _email) = read_auth_identity(shared_home);
    if acct.is_none() && !shared_home.join("auth.json").exists() {
        return;
    }
    let store = account_store_dir(app_data_dir, &active);
    let _ = sync_identity(shared_home, &store);
}

/// Switch the active unified account A→B by swapping identity bundles.
pub fn switch_unified_account(
    app_data_dir: &Path,
    shared_home: &Path,
    target_id: &str,
) -> Result<CodexUnifiedAccount, CodexAccountStoreError> {
    let mut index = read_index(app_data_dir);
    let account = find_account(&index, target_id)
        .cloned()
        .ok_or_else(|| other(format!("unknown codex account: {target_id}")))?;

    let target_store = account_store_dir(app_data_dir, target_id);
    if !target_store.join("auth.json").exists() && !dir_has_entries(&target_store) {
        return Err(other(format!(
            "identity bundle for codex account {target_id} is missing; not switching"
        )));
    }

    // (a) snapshot active A (capture refreshed tokens / memory) — best effort.
    if let Some(active) = index.active_account_id.clone() {
        if active != target_id {
            let store_a = account_store_dir(app_data_dir, &active);
            let _ = sync_identity(shared_home, &store_a);
        }
    }

    // (b) load B into shared_home (never touches sessions/).
    fs::create_dir_all(shared_home)?;
    sync_identity(&target_store, shared_home)?;

    // (c) record active.
    index.active_account_id = Some(target_id.to_string());
    write_index(app_data_dir, &index)?;
    Ok(account)
}

/// Capture the identity currently in `shared_home` as a (new or existing)
/// account — used after a fresh `codex login` into `~/.codex`.
pub fn capture_current(
    app_data_dir: &Path,
    shared_home: &Path,
    label: Option<String>,
) -> Result<CodexUnifiedAccount, CodexAccountStoreError> {
    if !shared_home.join("auth.json").exists() {
        return Err(other("no auth.json in codex home to capture".to_string()));
    }
    let id = derive_account_id(shared_home);
    let (account_id, email) = read_auth_identity(shared_home);
    let store = account_store_dir(app_data_dir, &id);
    sync_identity(shared_home, &store)?;

    let mut index = read_index(app_data_dir);
    let label = label
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| label_for(shared_home, &email));
    let account = if let Some(existing) = index.accounts.iter_mut().find(|a| a.id == id) {
        existing.email = email;
        existing.account_id = account_id;
        existing.label = label;
        existing.clone()
    } else {
        let account = CodexUnifiedAccount {
            id: id.clone(),
            email,
            account_id,
            label,
            source_home: Some(shared_home.to_string_lossy().to_string()),
            created_at: now_millis(),
        };
        index.accounts.push(account.clone());
        account
    };
    if index.active_account_id.is_none() {
        index.active_account_id = Some(id);
    }
    write_index(app_data_dir, &index)?;
    Ok(account)
}

/// Remove an account from the index + delete its identity store. Never touches
/// `sessions/`. If the removed account was active, reassign + load a remaining
/// account's identity into `shared_home`.
pub fn remove_account(
    app_data_dir: &Path,
    shared_home: &Path,
    id: &str,
) -> Result<bool, CodexAccountStoreError> {
    let mut index = read_index(app_data_dir);
    if find_account(&index, id).is_none() {
        return Ok(false);
    }
    let _ = fs::remove_dir_all(account_store_dir(app_data_dir, id));
    index.accounts.retain(|a| a.id != id);
    if index.active_account_id.as_deref() == Some(id) {
        index.active_account_id = index.accounts.first().map(|a| a.id.clone());
        if let Some(active) = index.active_account_id.clone() {
            let store = account_store_dir(app_data_dir, &active);
            let _ = sync_identity(&store, shared_home);
        }
    }
    write_index(app_data_dir, &index)?;
    Ok(true)
}

// --- migration ------------------------------------------------------------

fn files_equal(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (fs::metadata(a), fs::metadata(b)) else {
        return false;
    };
    if ma.len() != mb.len() {
        return false;
    }
    match (fs::read(a), fs::read(b)) {
        (Ok(da), Ok(db)) => da == db,
        _ => false,
    }
}

fn sidecar_path(dst: &Path, account_id: &str) -> PathBuf {
    let stem = dst
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("session");
    let ext = dst.extension().and_then(|s| s.to_str()).unwrap_or("jsonl");
    let name = format!("{stem}.from-{account_id}.{ext}");
    dst.with_file_name(name)
}

fn merge_sessions(
    src_sessions: &Path,
    dst_sessions: &Path,
    account_id: &str,
    report: &mut MigrationReport,
) {
    if !src_sessions.is_dir() {
        return;
    }
    let mut stack = vec![src_sessions.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                stack.push(path);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let Ok(rel) = path.strip_prefix(src_sessions) else {
                continue;
            };
            let dst = dst_sessions.join(rel);
            if dst.exists() {
                if files_equal(&path, &dst) {
                    report.sessions_skipped += 1;
                } else {
                    let sidecar = sidecar_path(&dst, account_id);
                    if sidecar.exists() {
                        report.sessions_skipped += 1;
                    } else {
                        if let Some(parent) = sidecar.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        if fs::copy(&path, &sidecar).is_ok() {
                            report.collisions += 1;
                        }
                    }
                }
            } else {
                if let Some(parent) = dst.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if fs::copy(&path, &dst).is_ok() {
                    report.sessions_copied += 1;
                }
            }
        }
    }
}

/// One-time, copy-only migration of legacy multi-HOME Codex accounts into the
/// unified model. Idempotent (guarded by `index.migrated`, and re-runnable).
/// Never deletes source homes.
pub fn migrate_from_homes(
    app_data_dir: &Path,
    shared_home: &Path,
    homes: &[PathBuf],
    prefer_active: Option<&Path>,
) -> Result<MigrationReport, CodexAccountStoreError> {
    let mut index = read_index(app_data_dir);
    if index.migrated {
        return Ok(MigrationReport {
            already_migrated: true,
            active_account_id: index.active_account_id.clone(),
            ..Default::default()
        });
    }

    fs::create_dir_all(shared_home.join(SESSIONS_DIRNAME))?;
    let shared_canon = fs::canonicalize(shared_home).unwrap_or_else(|_| shared_home.to_path_buf());
    let mut report = MigrationReport::default();
    let mut prefer_id: Option<String> = None;
    let mut shared_id: Option<String> = None;

    for home in homes {
        if !home.exists() {
            continue;
        }
        let id = derive_account_id(home);
        let (account_id, email) = read_auth_identity(home);
        let label = label_for(home, &email);
        let is_shared = fs::canonicalize(home)
            .map(|c| c == shared_canon)
            .unwrap_or_else(|_| home == shared_home);

        // Upsert account entry.
        if let Some(existing) = index.accounts.iter_mut().find(|a| a.id == id) {
            existing.email = email.clone();
            existing.account_id = account_id.clone();
            existing.label = label.clone();
            if existing.source_home.is_none() {
                existing.source_home = Some(home.to_string_lossy().to_string());
            }
        } else {
            index.accounts.push(CodexUnifiedAccount {
                id: id.clone(),
                email,
                account_id,
                label,
                source_home: Some(home.to_string_lossy().to_string()),
                created_at: now_millis(),
            });
            report.accounts_registered += 1;
        }

        // Capture identity bundle (skip re-copy if already populated → resumable).
        let store = account_store_dir(app_data_dir, &id);
        if !dir_has_entries(&store) {
            let _ = sync_identity(home, &store);
        }

        // Merge this home's sessions into the shared store (skip the shared home).
        if !is_shared {
            merge_sessions(
                &home.join(SESSIONS_DIRNAME),
                &shared_home.join(SESSIONS_DIRNAME),
                &id,
                &mut report,
            );
        } else {
            shared_id = Some(id.clone());
        }

        if let Some(pref) = prefer_active {
            let matches = fs::canonicalize(home)
                .ok()
                .zip(fs::canonicalize(pref).ok())
                .map(|(a, b)| a == b)
                .unwrap_or_else(|| home == pref);
            if matches {
                prefer_id = Some(id.clone());
            }
        }
    }

    // Choose active: preferred (OFF-mode active) → shared (~/.codex) → first.
    let active = prefer_id
        .or(shared_id)
        .or_else(|| index.accounts.first().map(|a| a.id.clone()));

    if let Some(active_id) = &active {
        let store = account_store_dir(app_data_dir, active_id);
        if dir_has_entries(&store) {
            let _ = sync_identity(&store, shared_home);
        }
    }

    index.active_account_id = active.clone();
    index.migrated = true;
    write_index(app_data_dir, &index)?;

    report.active_account_id = active;
    Ok(report)
}

/// Startup recovery: drop leftover staging dirs, and if `shared_home` identity
/// looks inconsistent with the active account, re-apply the active bundle.
pub fn recover_shared_home(app_data_dir: &Path, shared_home: &Path) {
    if let Ok(entries) = fs::read_dir(shared_home) {
        for entry in entries.flatten() {
            if is_staging_name(&entry.file_name()) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    let index = read_index(app_data_dir);
    let Some(active) = index.active_account_id else {
        return;
    };
    let store = account_store_dir(app_data_dir, &active);
    if !dir_has_entries(&store) {
        return;
    }
    // If shared_home lost its auth.json (e.g. crash mid-swap), restore it.
    if !shared_home.join("auth.json").exists() {
        let _ = sync_identity(&store, shared_home);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bat-codex-store-{}-{}-{name}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn derive_id_is_stable_and_shaped() {
        let root = temp_dir("derive");
        let home = root.join("home1");
        write(
            &home.join("auth.json"),
            r#"{"tokens":{"account_id":"acct_123"}}"#,
        );
        let id1 = derive_account_id(&home);
        let id2 = derive_account_id(&home);
        assert_eq!(id1, id2);
        assert_eq!(id1, "acct-acct_123");

        let email_home = root.join(".codex-iso-x");
        write(&email_home.join("auth.json"), r#"{"email":"a@b.com"}"#);
        assert!(derive_account_id(&email_home).starts_with("email-"));

        let bare = root.join(".codex-iso-bare");
        fs::create_dir_all(&bare).unwrap();
        assert_eq!(derive_account_id(&bare), "home-.codex-iso-bare");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn switch_preserves_sessions_and_swaps_identity() {
        let root = temp_dir("switch");
        let app_data = root.join("app-data");
        let shared = root.join(".codex");
        fs::create_dir_all(&app_data).unwrap();

        // Two account stores.
        let store_a = account_store_dir(&app_data, "a");
        let store_b = account_store_dir(&app_data, "b");
        write(&store_a.join("auth.json"), r#"{"account_id":"A"}"#);
        write(&store_a.join("config.toml"), "model='a'");
        write(&store_b.join("auth.json"), r#"{"account_id":"B"}"#);

        // Shared home starts as A with live sessions.
        sync_identity(&store_a, &shared).unwrap();
        write(&shared.join("sessions/2026/01/01/uuid.jsonl"), "session-data");

        let mut index = CodexUnifiedIndex::default();
        index.accounts.push(CodexUnifiedAccount {
            id: "a".into(),
            email: None,
            account_id: Some("A".into()),
            label: "a".into(),
            source_home: None,
            created_at: 1,
        });
        index.accounts.push(CodexUnifiedAccount {
            id: "b".into(),
            email: None,
            account_id: Some("B".into()),
            label: "b".into(),
            source_home: None,
            created_at: 2,
        });
        index.active_account_id = Some("a".into());
        write_index(&app_data, &index).unwrap();

        switch_unified_account(&app_data, &shared, "b").unwrap();

        // Identity is now B; A's config.toml is gone from shared; sessions intact.
        assert_eq!(
            fs::read_to_string(shared.join("auth.json")).unwrap(),
            r#"{"account_id":"B"}"#
        );
        assert!(!shared.join("config.toml").exists());
        assert_eq!(
            fs::read_to_string(shared.join("sessions/2026/01/01/uuid.jsonl")).unwrap(),
            "session-data"
        );
        assert_eq!(read_index(&app_data).active_account_id.as_deref(), Some("b"));

        // Switch back restores A's identity (snapshot captured it).
        switch_unified_account(&app_data, &shared, "a").unwrap();
        assert_eq!(
            fs::read_to_string(shared.join("auth.json")).unwrap(),
            r#"{"account_id":"A"}"#
        );
        assert_eq!(
            fs::read_to_string(shared.join("config.toml")).unwrap(),
            "model='a'"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn migrate_merges_sessions_and_is_idempotent() {
        let root = temp_dir("migrate");
        let app_data = root.join("app-data");
        let shared = root.join(".codex");
        let iso = root.join(".codex-iso-x");
        fs::create_dir_all(&app_data).unwrap();

        write(&shared.join("auth.json"), r#"{"account_id":"DEFAULT"}"#);
        write(&shared.join("sessions/s-default.jsonl"), "default");
        write(&iso.join("auth.json"), r#"{"account_id":"ISO"}"#);
        write(&iso.join("sessions/s-iso.jsonl"), "iso");

        let homes = vec![shared.clone(), iso.clone()];
        let report = migrate_from_homes(&app_data, &shared, &homes, Some(&iso)).unwrap();
        assert_eq!(report.sessions_copied, 1); // s-iso copied in
        assert_eq!(report.active_account_id.as_deref(), Some("acct-ISO"));
        // Both sessions visible in the shared store.
        assert!(shared.join("sessions/s-default.jsonl").exists());
        assert!(shared.join("sessions/s-iso.jsonl").exists());
        // Source iso home untouched.
        assert!(iso.join("sessions/s-iso.jsonl").exists());
        assert!(iso.join("auth.json").exists());

        // Re-run is a no-op.
        let again = migrate_from_homes(&app_data, &shared, &homes, Some(&iso)).unwrap();
        assert!(again.already_migrated);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn merge_collision_writes_sidecar() {
        let root = temp_dir("collision");
        let mut report = MigrationReport::default();
        let src = root.join("src/sessions");
        let dst = root.join("dst/sessions");
        write(&src.join("uuid.jsonl"), "from-account");
        write(&dst.join("uuid.jsonl"), "different");
        merge_sessions(&src, &dst, "acct-x", &mut report);
        assert_eq!(report.collisions, 1);
        assert!(dst.join("uuid.from-acct-x.jsonl").exists());
        // Original destination untouched.
        assert_eq!(
            fs::read_to_string(dst.join("uuid.jsonl")).unwrap(),
            "different"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn jwt_email_fallback_reads_id_token() {
        let root = temp_dir("jwt");
        let home = root.join(".codex");
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"email":"a@b.com","name":"A"}"#);
        let token = format!("h.{payload}.sig");
        write(
            &home.join("auth.json"),
            &format!(r#"{{"tokens":{{"id_token":"{token}","account_id":"acct"}}}}"#),
        );
        let (account_id, email) = read_auth_identity(&home);
        assert_eq!(account_id.as_deref(), Some("acct"));
        assert_eq!(email.as_deref(), Some("a@b.com"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn index_strips_invalid_active_id() {
        let dir = temp_dir("index");
        let mut index = CodexUnifiedIndex::default();
        index.accounts.push(CodexUnifiedAccount {
            id: "a".into(),
            email: None,
            account_id: None,
            label: "a".into(),
            source_home: None,
            created_at: 1,
        });
        index.active_account_id = Some("missing".into());
        write_index(&dir, &index).unwrap();
        assert_eq!(read_index(&dir).active_account_id, None);
        fs::remove_dir_all(dir).ok();
    }
}
