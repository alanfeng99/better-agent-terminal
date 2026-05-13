// git:* — read-only git operations the renderer surfaces in
// GitPanel / GitHubPanel / agent panels.
//
// We shell out to the system `git` binary (rather than pulling in
// libgit2/git2-rs) because:
//  - the renderer only ever needs porcelain output (status, log,
//    diff text, branch, remote URL) — no plumbing or object reads,
//  - git is already a hard dependency for the user's workflow,
//  - libgit2 ships another C dependency that complicates Windows
//    packaging while we're still rebuilding the pipeline (Phase 3),
//  - keeping argv close to the Electron handlers makes the porting
//    contract obvious during code review.
//
// All commands return safe defaults (None / empty Vec / empty
// String) when git fails — the Electron handlers behave the same
// way and the renderer treats those as "not a repo / nothing to
// show". We intentionally do NOT propagate stderr to the caller;
// a non-repo cwd is a normal state, not an error.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::subprocess::hide_console_window;
use serde::Serialize;

// Hard upper bound for log/status/diff output. Mirrors the Electron
// maxBuffer (5 MiB) so a runaway repo can't OOM the renderer.
const MAX_OUTPUT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct GitLogEntry {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct GitFileEntry {
    pub status: String,
    pub file: String,
}

// Run git with the given args in `cwd`, returning stdout as a UTF-8
// string with a wall-clock timeout. Any failure (non-zero exit,
// missing binary, timeout, oversized output) collapses to None so
// callers can apply their own default.
fn run_git(cwd: &str, args: &[&str], timeout: Duration) -> Option<String> {
    if cwd.trim().is_empty() {
        return None;
    }
    if !Path::new(cwd).is_dir() {
        return None;
    }
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console_window(&mut command);
    let mut child = command.spawn().ok()?;

    // Cheap timeout: poll try_wait every 25 ms.
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn run_git_blocking(cwd: String, args: Vec<String>, timeout: Duration) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(&cwd, &refs, timeout)
    })
    .await
    .ok()
    .flatten()
}

// `git remote get-url origin` returns the remote URL; we only
// translate github.com remotes so the GitHubPanel / Sidebar links
// resolve to a browsable HTTPS URL.
pub fn parse_github_url(remote: &str) -> Option<String> {
    let s = remote.trim();
    // git@github.com:owner/repo(.git)?
    if let Some(rest) = s.strip_prefix("git@github.com:") {
        let owner_repo = rest.strip_suffix(".git").unwrap_or(rest);
        if owner_repo.is_empty() {
            return None;
        }
        return Some(format!("https://github.com/{owner_repo}"));
    }
    // https?://github.com/owner/repo(.git)?
    for prefix in ["https://github.com/", "http://github.com/"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            let owner_repo = rest.strip_suffix(".git").unwrap_or(rest);
            if owner_repo.is_empty() {
                return None;
            }
            return Some(format!("https://github.com/{owner_repo}"));
        }
    }
    None
}

// `git log --pretty=format:%H||%an||%ai||%s` — keep the delimiter
// in sync with the Electron handler so the parser is bit-for-bit
// the same.
pub fn parse_log(raw: &str) -> Vec<GitLogEntry> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    trimmed
        .lines()
        .map(|line| {
            let parts: Vec<&str> = line.splitn(4, "||").collect();
            GitLogEntry {
                hash: parts.first().copied().unwrap_or("").to_string(),
                author: parts.get(1).copied().unwrap_or("").to_string(),
                date: parts.get(2).copied().unwrap_or("").to_string(),
                message: parts.get(3).copied().unwrap_or("").to_string(),
            }
        })
        .collect()
}

// Parse `git diff --name-status [range]`: each line is
// "<status>\t<file>" (renames use a longer two-tab form, but the
// Electron handler also flattens that to the first segment).
pub fn parse_diff_files(raw: &str) -> Vec<GitFileEntry> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    trimmed
        .lines()
        .map(|line| {
            if let Some(tab_idx) = line.find('\t') {
                GitFileEntry {
                    status: line[..tab_idx].trim().to_string(),
                    file: line[tab_idx + 1..].to_string(),
                }
            } else {
                let status = line
                    .chars()
                    .next()
                    .map(|c| c.to_string())
                    .unwrap_or_default();
                let file = if line.len() > 2 {
                    line[2..].to_string()
                } else {
                    String::new()
                };
                GitFileEntry { status, file }
            }
        })
        .collect()
}

// Parse `git status --porcelain -uall`: each line begins with two
// status chars followed by a space and the path. Mirrors the
// Electron parser (which trims the status field).
pub fn parse_status(raw: &str) -> Vec<GitFileEntry> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    raw.split('\n')
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let status_end = line.len().min(2);
            let status = line[..status_end].trim().to_string();
            let file = if line.len() > 3 {
                line[3..].to_string()
            } else {
                String::new()
            };
            GitFileEntry { status, file }
        })
        .collect()
}

// Build the argv for `git diff` based on optional commit hash + path.
// "working" is a magic string the renderer uses to mean "uncommitted
// changes vs HEAD" — we map that to `git diff HEAD`.
pub fn build_diff_args<'a>(
    commit_hash: Option<&'a str>,
    file_path: Option<&'a str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["diff".into()];
    match commit_hash {
        Some(hash) if !hash.is_empty() && hash != "working" => {
            args.push(format!("{hash}~1..{hash}"));
        }
        _ => args.push("HEAD".into()),
    }
    if let Some(p) = file_path {
        if !p.is_empty() {
            args.push("--".into());
            args.push(p.to_string());
        }
    }
    args
}

pub fn build_diff_files_args<'a>(commit_hash: Option<&'a str>) -> Vec<String> {
    match commit_hash {
        Some(hash) if !hash.is_empty() && hash != "working" => {
            vec![
                "diff".into(),
                "--name-status".into(),
                format!("{hash}~1..{hash}"),
            ]
        }
        _ => vec!["diff".into(), "--name-status".into(), "HEAD".into()],
    }
}

pub fn clamp_log_count(count: Option<i64>) -> u32 {
    let raw = count.unwrap_or(50);
    raw.clamp(1, 500) as u32
}

#[tauri::command]
pub async fn git_get_github_url(folder_path: String) -> Option<String> {
    let raw = run_git_blocking(
        folder_path,
        vec!["remote".into(), "get-url".into(), "origin".into()],
        Duration::from_secs(3),
    )
    .await?;
    parse_github_url(raw.trim())
}

#[tauri::command]
pub async fn git_get_branch(cwd: String) -> Option<String> {
    let raw = run_git_blocking(
        cwd,
        vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
        Duration::from_secs(3),
    )
    .await?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[tauri::command]
pub async fn git_get_log(cwd: String, count: Option<i64>) -> Vec<GitLogEntry> {
    let n = clamp_log_count(count);
    let n_str = n.to_string();
    let args = vec![
        "log".into(),
        "--pretty=format:%H||%an||%ai||%s".into(),
        "-n".into(),
        n_str,
    ];
    match run_git_blocking(cwd, args, Duration::from_secs(5)).await {
        Some(raw) => parse_log(&raw),
        None => Vec::new(),
    }
}

#[tauri::command]
pub async fn git_get_diff(
    cwd: String,
    commit_hash: Option<String>,
    file_path: Option<String>,
) -> String {
    let argv = build_diff_args(commit_hash.as_deref(), file_path.as_deref());
    run_git_blocking(cwd, argv, Duration::from_secs(10))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn git_get_diff_files(cwd: String, commit_hash: Option<String>) -> Vec<GitFileEntry> {
    let argv = build_diff_files_args(commit_hash.as_deref());
    match run_git_blocking(cwd, argv, Duration::from_secs(5)).await {
        Some(raw) => parse_diff_files(&raw),
        None => Vec::new(),
    }
}

#[tauri::command]
pub async fn git_get_root(cwd: String) -> Option<String> {
    let raw = run_git_blocking(
        cwd,
        vec!["rev-parse".into(), "--show-toplevel".into()],
        Duration::from_secs(5),
    )
    .await?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[tauri::command]
pub async fn git_get_status(cwd: String) -> Vec<GitFileEntry> {
    match run_git_blocking(
        cwd,
        vec!["status".into(), "--porcelain".into(), "-uall".into()],
        Duration::from_secs(5),
    )
    .await
    {
        Some(raw) => parse_status(&raw),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_github_ssh_url() {
        assert_eq!(
            parse_github_url("git@github.com:owner/repo.git"),
            Some("https://github.com/owner/repo".into()),
        );
        assert_eq!(
            parse_github_url("git@github.com:owner/repo"),
            Some("https://github.com/owner/repo".into()),
        );
    }

    #[test]
    fn parse_github_https_url() {
        assert_eq!(
            parse_github_url("https://github.com/owner/repo.git"),
            Some("https://github.com/owner/repo".into()),
        );
        assert_eq!(
            parse_github_url("http://github.com/owner/repo"),
            Some("https://github.com/owner/repo".into()),
        );
    }

    #[test]
    fn parse_github_url_rejects_non_github() {
        assert_eq!(parse_github_url("git@gitlab.com:owner/repo.git"), None);
        assert_eq!(parse_github_url("https://bitbucket.org/owner/repo"), None);
        assert_eq!(parse_github_url(""), None);
    }

    #[test]
    fn parse_log_handles_empty() {
        assert_eq!(parse_log(""), Vec::<GitLogEntry>::new());
        assert_eq!(parse_log("   \n  "), Vec::<GitLogEntry>::new());
    }

    #[test]
    fn parse_log_handles_messages_with_delimiter() {
        // The 4-way splitn means everything after the third "||" is
        // considered part of the message — preserving message
        // segments that contain "||".
        let raw = "abc123||Alice||2024-01-01 10:00||fix(pty): handle || edge case";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].hash, "abc123");
        assert_eq!(entries[0].author, "Alice");
        assert_eq!(entries[0].date, "2024-01-01 10:00");
        assert_eq!(entries[0].message, "fix(pty): handle || edge case");
    }

    #[test]
    fn parse_log_multiple_lines() {
        let raw = "h1||a||d1||m1\nh2||b||d2||m2";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].hash, "h2");
        assert_eq!(entries[1].message, "m2");
    }

    #[test]
    fn parse_diff_files_basic() {
        let raw = "M\tsrc/foo.rs\nA\tsrc/bar.rs\nD\told/baz.rs";
        let entries = parse_diff_files(raw);
        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries[0],
            GitFileEntry {
                status: "M".into(),
                file: "src/foo.rs".into()
            }
        );
        assert_eq!(
            entries[2],
            GitFileEntry {
                status: "D".into(),
                file: "old/baz.rs".into()
            }
        );
    }

    #[test]
    fn parse_diff_files_no_tab_fallback() {
        // Defensive: if the line lacks a tab, take first char as
        // status and skip a couple chars for the file. Mirrors the
        // Electron substring(2) fallback.
        let raw = "M  some/odd/file.rs";
        let entries = parse_diff_files(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "M");
    }

    #[test]
    fn parse_status_porcelain() {
        let raw = " M src/foo.rs\n?? new.txt\nMM both.rs\n";
        let entries = parse_status(raw);
        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries[0],
            GitFileEntry {
                status: "M".into(),
                file: "src/foo.rs".into()
            }
        );
        assert_eq!(
            entries[1],
            GitFileEntry {
                status: "??".into(),
                file: "new.txt".into()
            }
        );
        assert_eq!(
            entries[2],
            GitFileEntry {
                status: "MM".into(),
                file: "both.rs".into()
            }
        );
    }

    #[test]
    fn parse_status_empty_returns_empty() {
        assert_eq!(parse_status(""), Vec::<GitFileEntry>::new());
        assert_eq!(parse_status("\n\n"), Vec::<GitFileEntry>::new());
    }

    #[test]
    fn build_diff_args_default() {
        assert_eq!(
            build_diff_args(None, None),
            vec!["diff".to_string(), "HEAD".into()]
        );
    }

    #[test]
    fn build_diff_args_working_keyword() {
        // "working" is the renderer's sentinel for HEAD/uncommitted.
        assert_eq!(
            build_diff_args(Some("working"), None),
            vec!["diff".to_string(), "HEAD".into()],
        );
    }

    #[test]
    fn build_diff_args_with_commit_and_path() {
        assert_eq!(
            build_diff_args(Some("abc123"), Some("src/foo.rs")),
            vec![
                "diff".to_string(),
                "abc123~1..abc123".into(),
                "--".into(),
                "src/foo.rs".into(),
            ],
        );
    }

    #[test]
    fn build_diff_args_empty_commit_falls_back_to_head() {
        assert_eq!(
            build_diff_args(Some(""), None),
            vec!["diff".to_string(), "HEAD".into()],
        );
    }

    #[test]
    fn build_diff_files_args_variants() {
        assert_eq!(
            build_diff_files_args(None),
            vec!["diff".to_string(), "--name-status".into(), "HEAD".into()],
        );
        assert_eq!(
            build_diff_files_args(Some("abc")),
            vec![
                "diff".to_string(),
                "--name-status".into(),
                "abc~1..abc".into()
            ],
        );
        assert_eq!(
            build_diff_files_args(Some("working")),
            vec!["diff".to_string(), "--name-status".into(), "HEAD".into()],
        );
    }

    #[test]
    fn clamp_log_count_bounds() {
        assert_eq!(clamp_log_count(None), 50);
        assert_eq!(clamp_log_count(Some(0)), 1);
        assert_eq!(clamp_log_count(Some(-5)), 1);
        assert_eq!(clamp_log_count(Some(10)), 10);
        assert_eq!(clamp_log_count(Some(99999)), 500);
    }

    #[test]
    fn run_git_rejects_invalid_cwd() {
        assert!(run_git("", &["status"], Duration::from_secs(1)).is_none());
        assert!(run_git(
            "C:/this/path/should/never/exist/abc123",
            &["status"],
            Duration::from_secs(1),
        )
        .is_none());
    }
}
