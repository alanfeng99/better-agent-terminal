// worktree:* — Rust native port of electron/worktree-manager.ts.
//
// This surface is pure git + filesystem state. Keeping it in Rust avoids
// waking the Node sidecar for local worktree creation/status/cleanup while
// preserving the renderer-facing worktree.* result shapes.

use crate::sidecar::BridgeError;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
const WORKTREE_DIR: &str = ".bat-worktrees";

#[derive(Clone, Default)]
pub struct WorktreeState {
    inner: Arc<Mutex<HashMap<String, WorktreeInfo>>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorktreeInfo {
    session_id: String,
    worktree_path: String,
    branch_name: String,
    git_root: String,
    original_cwd: String,
    source_branch: String,
    created_at: u64,
}

impl WorktreeState {
    fn get(&self, session_id: &str) -> Option<WorktreeInfo> {
        self.inner
            .lock()
            .expect("worktree state lock")
            .get(session_id)
            .cloned()
    }

    fn set(&self, info: WorktreeInfo) {
        self.inner
            .lock()
            .expect("worktree state lock")
            .insert(info.session_id.clone(), info);
    }

    fn remove(&self, session_id: &str) -> Option<WorktreeInfo> {
        self.inner
            .lock()
            .expect("worktree state lock")
            .remove(session_id)
    }
}

fn bridge_error(message: impl Into<String>) -> BridgeError {
    BridgeError {
        message: message.into(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn run_git(
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
    max_bytes: usize,
) -> Result<String, String> {
    if !cwd.is_dir() {
        return Err("cwd is not a directory".into());
    }
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| err.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("git command timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => return Err(err.to_string()),
        }
    }
    let output = child.wait_with_output().map_err(|err| err.to_string())?;
    if output.stdout.len() > max_bytes {
        return Err("git output exceeded buffer limit".into());
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            output.status.to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_ok(cwd: &Path, args: &[&str]) -> bool {
    run_git(cwd, args, DEFAULT_TIMEOUT, MAX_OUTPUT_BYTES).is_ok()
}

fn get_git_root(cwd: &str) -> Option<String> {
    run_git(
        Path::new(cwd),
        &["rev-parse", "--show-toplevel"],
        DEFAULT_TIMEOUT,
        1024 * 1024,
    )
    .ok()
}

fn get_branch(cwd: &Path) -> String {
    run_git(
        cwd,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
        1024 * 1024,
    )
    .unwrap_or_else(|_| "HEAD".into())
}

fn worktree_git_root_from_path(worktree_path: &str) -> Option<PathBuf> {
    Path::new(worktree_path)
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

fn add_worktree_to_git_exclude(git_root: &Path) {
    let exclude_file = git_root.join(".git").join("info").join("exclude");
    let pattern = format!("/{WORKTREE_DIR}/");
    if let Some(parent) = exclude_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut content = fs::read_to_string(&exclude_file).unwrap_or_default();
    if content.contains(&pattern) {
        return;
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&pattern);
    content.push('\n');
    let _ = fs::write(exclude_file, content);
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let source = entry.path();
        let target = dst.join(entry.file_name());
        let meta = entry.metadata()?;
        if meta.is_dir() {
            copy_dir_recursive(&source, &target)?;
        } else if meta.is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let _ = fs::copy(source, target)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn link_or_copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(src, dst).or_else(|_| copy_dir_recursive(src, dst))
}

#[cfg(not(windows))]
fn link_or_copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst).or_else(|_| copy_dir_recursive(src, dst))
}

#[cfg(windows)]
fn link_or_copy_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::copy(src, dst).map(|_| ())
}

#[cfg(not(windows))]
fn link_or_copy_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst).or_else(|_| fs::copy(src, dst).map(|_| ()))
}

fn link_claude_untracked(git_root: &Path, worktree_path: &Path) {
    let claude_dir = git_root.join(".claude");
    if !claude_dir.is_dir() {
        return;
    }
    let Ok(stdout) = run_git(
        git_root,
        &["ls-files", "--others", "--exclude-standard", ".claude/"],
        DEFAULT_TIMEOUT,
        5 * 1024 * 1024,
    ) else {
        return;
    };
    let mut top_entries = Vec::<String>::new();
    for item in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let rel = item.trim().strip_prefix(".claude/").unwrap_or(item.trim());
        if let Some(first) = rel.split('/').next().filter(|value| !value.is_empty()) {
            if !top_entries.iter().any(|entry| entry == first) {
                top_entries.push(first.to_string());
            }
        }
    }
    if top_entries.is_empty() {
        return;
    }
    let worktree_claude_dir = worktree_path.join(".claude");
    let _ = fs::create_dir_all(&worktree_claude_dir);
    for item in top_entries {
        let src = claude_dir.join(&item);
        let dst = worktree_claude_dir.join(&item);
        if dst.exists() {
            continue;
        }
        let Ok(meta) = fs::metadata(&src) else {
            continue;
        };
        let _ = if meta.is_dir() {
            link_or_copy_dir(&src, &dst)
        } else {
            link_or_copy_file(&src, &dst)
        };
    }
}

fn create_worktree_native(
    state: &WorktreeState,
    session_id: String,
    cwd: String,
) -> Result<Value, BridgeError> {
    if session_id.trim().is_empty() || cwd.trim().is_empty() {
        return Ok(
            json!({ "success": false, "error": "worktree.create: missing sessionId or cwd" }),
        );
    }
    let Some(git_root) = get_git_root(&cwd) else {
        return Ok(json!({ "success": false, "error": "Not a git repository" }));
    };
    let git_root_path = PathBuf::from(&git_root);
    let short_id: String = session_id.chars().take(8).collect();
    let worktree_base = git_root_path.join(WORKTREE_DIR);
    let worktree_path = worktree_base.join(&short_id);
    let source_branch = get_branch(&git_root_path);
    let mut branch_name = format!("bat/worktree-{short_id}");

    fs::create_dir_all(&worktree_base).map_err(|err| bridge_error(err.to_string()))?;
    add_worktree_to_git_exclude(&git_root_path);

    if worktree_path.exists() {
        return Ok(json!({
            "success": false,
            "error": format!(
                "Worktree already exists at {}. Use rehydrate() to reuse it.",
                worktree_path.to_string_lossy()
            )
        }));
    }

    if run_git_ok(&git_root_path, &["rev-parse", "--verify", &branch_name]) {
        branch_name = format!("{}-{}", branch_name, now_ms());
    }

    let worktree_path_arg = worktree_path.to_string_lossy().to_string();
    run_git(
        &git_root_path,
        &["worktree", "add", &worktree_path_arg, "-b", &branch_name],
        DEFAULT_TIMEOUT,
        MAX_OUTPUT_BYTES,
    )
    .map_err(bridge_error)?;
    link_claude_untracked(&git_root_path, &worktree_path);

    let info = WorktreeInfo {
        session_id,
        worktree_path: worktree_path.to_string_lossy().to_string(),
        branch_name,
        git_root,
        original_cwd: cwd,
        source_branch,
        created_at: now_ms(),
    };
    state.set(info.clone());
    let mut value = serde_json::to_value(info).unwrap_or(Value::Null);
    value["success"] = Value::Bool(true);
    Ok(value)
}

fn force_remove_worktree(info: &WorktreeInfo, delete_branch: bool) {
    let git_root = Path::new(&info.git_root);
    let worktree_path = Path::new(&info.worktree_path);
    if worktree_path.is_dir()
        && !run_git_ok(
            git_root,
            &["worktree", "remove", &info.worktree_path, "--force"],
        )
    {
        let _ = fs::remove_dir_all(worktree_path);
        let _ = run_git_ok(git_root, &["worktree", "prune"]);
    }
    if delete_branch {
        let _ = run_git_ok(git_root, &["branch", "-D", &info.branch_name]);
    }
}

fn remove_worktree_native(state: &WorktreeState, session_id: String, delete_branch: bool) -> Value {
    if session_id.trim().is_empty() {
        return json!({ "success": false, "error": "worktree.remove: missing sessionId" });
    }
    if let Some(info) = state.remove(&session_id) {
        force_remove_worktree(&info, delete_branch);
    }
    json!({ "success": true })
}

fn resolve_source_branch(state: &WorktreeState, info: &mut WorktreeInfo) -> String {
    if !info.source_branch.is_empty() {
        return info.source_branch.clone();
    }
    let source_branch = get_branch(Path::new(&info.git_root));
    info.source_branch = source_branch.clone();
    state.set(info.clone());
    source_branch
}

fn worktree_status_native(state: &WorktreeState, session_id: String) -> Value {
    let Some(mut info) = state.get(&session_id) else {
        return Value::Null;
    };
    let source_branch = resolve_source_branch(state, &mut info);
    let diff = if source_branch.is_empty() {
        String::new()
    } else {
        let range = format!("{source_branch}...{}", info.branch_name);
        run_git(
            Path::new(&info.git_root),
            &["diff", &range],
            DEFAULT_TIMEOUT,
            MAX_OUTPUT_BYTES,
        )
        .unwrap_or_default()
    };
    json!({
        "diff": diff,
        "branchName": info.branch_name,
        "worktreePath": info.worktree_path,
        "sourceBranch": source_branch,
    })
}

fn ensure_clean(git_root: &Path) -> Result<(), String> {
    let status = run_git(
        git_root,
        &["status", "--porcelain"],
        DEFAULT_TIMEOUT,
        1024 * 1024,
    )?;
    if status.trim().is_empty() {
        Ok(())
    } else {
        Err(
            "Host repository has uncommitted changes; commit or stash before merging worktree"
                .into(),
        )
    }
}

fn merge_worktree_native(state: &WorktreeState, session_id: String, strategy: String) -> Value {
    let Some(mut info) = state.get(&session_id) else {
        return json!({ "success": false, "error": "worktree.merge: unknown session" });
    };
    if strategy != "merge" && strategy != "cherry-pick" {
        return json!({ "success": false, "error": format!("worktree.merge: unsupported strategy {strategy}") });
    }
    let source_branch = resolve_source_branch(state, &mut info);
    if source_branch.is_empty() {
        return json!({ "success": false, "error": "worktree.merge: missing source branch" });
    }
    let git_root = Path::new(&info.git_root);
    let result = (|| -> Result<(), String> {
        ensure_clean(git_root)?;
        let current_branch = get_branch(git_root);
        if current_branch != source_branch {
            run_git(
                git_root,
                &["checkout", &source_branch],
                DEFAULT_TIMEOUT,
                MAX_OUTPUT_BYTES,
            )?;
        }
        if strategy == "merge" {
            run_git(
                git_root,
                &["merge", "--no-ff", "--no-edit", &info.branch_name],
                DEFAULT_TIMEOUT,
                MAX_OUTPUT_BYTES,
            )?;
        } else {
            let range = format!("{source_branch}..{}", info.branch_name);
            let commits = run_git(
                git_root,
                &["rev-list", "--reverse", &range],
                DEFAULT_TIMEOUT,
                MAX_OUTPUT_BYTES,
            )?;
            let commits = commits
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            if !commits.is_empty() {
                let mut args = vec!["cherry-pick"];
                let commit_refs = commits.iter().map(String::as_str).collect::<Vec<_>>();
                args.extend(commit_refs);
                run_git(git_root, &args, DEFAULT_TIMEOUT, MAX_OUTPUT_BYTES)?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => json!({
            "success": true,
            "strategy": strategy,
            "branchName": info.branch_name,
            "sourceBranch": source_branch,
        }),
        Err(err) => json!({ "success": false, "error": err }),
    }
}

fn rehydrate_worktree_native(
    state: &WorktreeState,
    session_id: String,
    cwd: String,
    worktree_path: String,
    branch_name: String,
) -> Value {
    if session_id.trim().is_empty() || worktree_path.trim().is_empty() {
        return json!({ "success": false });
    }
    let git_root = worktree_git_root_from_path(&worktree_path)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    if let Some(mut existing) = state.get(&session_id) {
        if existing.worktree_path == worktree_path {
            existing.original_cwd = cwd;
            if !branch_name.trim().is_empty() {
                existing.branch_name = branch_name;
            }
            state.set(existing);
            return json!({ "success": true });
        }
    }
    state.set(WorktreeInfo {
        session_id,
        worktree_path,
        branch_name,
        git_root,
        original_cwd: cwd,
        source_branch: String::new(),
        created_at: 0,
    });
    json!({ "success": true })
}

#[tauri::command]
pub async fn worktree_create(
    state: State<'_, WorktreeState>,
    session_id: String,
    cwd: String,
) -> Result<Value, BridgeError> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || create_worktree_native(&state, session_id, cwd))
        .await
        .map_err(|err| BridgeError {
            message: format!("worktree.create worker failed: {err}"),
        })?
}

#[tauri::command]
pub async fn worktree_remove(
    state: State<'_, WorktreeState>,
    session_id: String,
    delete_branch: bool,
) -> Result<Value, BridgeError> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        remove_worktree_native(&state, session_id, delete_branch)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("worktree.remove worker failed: {err}"),
    })
}

#[tauri::command]
pub async fn worktree_status(
    state: State<'_, WorktreeState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || worktree_status_native(&state, session_id))
        .await
        .map_err(|err| BridgeError {
            message: format!("worktree.status worker failed: {err}"),
        })
}

#[tauri::command]
pub async fn worktree_merge(
    state: State<'_, WorktreeState>,
    session_id: String,
    strategy: String,
) -> Result<Value, BridgeError> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        merge_worktree_native(&state, session_id, strategy)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("worktree.merge worker failed: {err}"),
    })
}

#[tauri::command]
pub async fn worktree_rehydrate(
    state: State<'_, WorktreeState>,
    session_id: String,
    cwd: String,
    worktree_path: String,
    branch_name: String,
) -> Result<Value, BridgeError> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        rehydrate_worktree_native(&state, session_id, cwd, worktree_path, branch_name)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("worktree.rehydrate worker failed: {err}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_root_resolves_from_bat_worktree_path() {
        let root = worktree_git_root_from_path("C:/repo/.bat-worktrees/abc")
            .expect("root from worktree path");
        assert!(root.ends_with(Path::new("C:/repo")));
    }

    #[test]
    fn rehydrate_stores_worktree_info() {
        let state = WorktreeState::default();
        let result = rehydrate_worktree_native(
            &state,
            "session-1".into(),
            "C:/repo".into(),
            "C:/repo/.bat-worktrees/session-1".into(),
            "bat/worktree-session-1".into(),
        );
        assert_eq!(result["success"], true);
        let info = state.get("session-1").expect("stored worktree");
        assert_eq!(info.original_cwd, "C:/repo");
        assert_eq!(info.branch_name, "bat/worktree-session-1");
    }

    #[test]
    fn status_unknown_session_returns_null() {
        let state = WorktreeState::default();
        assert_eq!(
            worktree_status_native(&state, "missing".into()),
            Value::Null
        );
    }
}
