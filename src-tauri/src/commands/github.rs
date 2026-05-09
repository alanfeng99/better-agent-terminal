// github:* — wrappers around the `gh` CLI.
//
// The Electron handlers all shell out to the user's installed
// `gh` binary. We do the same here: gh handles auth, JSON output,
// and rate-limit retry behaviour, so duplicating that in Rust
// would be wasted effort. See plans/tauri-migration-plan.md for
// the parity decision.
//
// Read commands return the JSON gh emits as an opaque
// `serde_json::Value` so the renderer can reuse its existing
// schema-derived types. Write commands (pr-comment, issue-comment)
// return `{success: true}` or `{error: msg}` matching the Electron
// shape.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const READ_TIMEOUT: Duration = Duration::from_secs(15);
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTPUT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    pub authenticated: bool,
}

// Run `gh` with the given args, optionally in a cwd. Returns
// (stdout_string, success_flag).
fn run_gh(cwd: Option<&str>, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new("gh");
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd {
        if dir.trim().is_empty() {
            return Err("cwd is empty".into());
        }
        if !Path::new(dir).is_dir() {
            return Err(format!("cwd does not exist: {dir}"));
        }
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn gh: {e}"))?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("gh timed out".into());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    }
    let output = child.wait_with_output().map_err(|e| format!("wait_with_output: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        return Err(if trimmed.is_empty() {
            format!("gh exited with status {}", output.status)
        } else {
            trimmed.to_string()
        });
    }
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return Err("gh output exceeds 5 MiB cap".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// Helper for read commands that shape the response as either parsed
// JSON or `{error: msg}` (Electron parity).
fn json_or_error(result: Result<String, String>) -> Value {
    match result {
        Ok(stdout) => match serde_json::from_str::<Value>(&stdout) {
            Ok(v) => v,
            Err(e) => serde_json::json!({ "error": format!("gh JSON parse failed: {e}") }),
        },
        Err(e) => serde_json::json!({ "error": e }),
    }
}

#[tauri::command]
pub async fn github_check_cli() -> CliStatus {
    let installed = run_gh(None, &["--version"], CHECK_TIMEOUT).is_ok();
    if !installed {
        return CliStatus { installed: false, authenticated: false };
    }
    // `gh auth status` exits non-zero whenever ANY configured
    // account has problems, even when the active one is fine.
    // `gh auth token` only validates the active account, which is
    // what we actually care about here.
    let authenticated = run_gh(None, &["auth", "token"], CHECK_TIMEOUT).is_ok();
    CliStatus { installed: true, authenticated }
}

#[tauri::command]
pub async fn github_pr_list(cwd: String) -> Value {
    let args = [
        "pr", "list",
        "--json", "number,title,state,author,createdAt,updatedAt,labels,headRefName,isDraft",
        "--limit", "50",
    ];
    json_or_error(run_gh(Some(&cwd), &args, READ_TIMEOUT))
}

#[tauri::command]
pub async fn github_issue_list(cwd: String) -> Value {
    let args = [
        "issue", "list",
        "--json", "number,title,state,author,createdAt,updatedAt,labels",
        "--limit", "50",
    ];
    json_or_error(run_gh(Some(&cwd), &args, READ_TIMEOUT))
}

#[tauri::command]
pub async fn github_pr_view(cwd: String, number: i64) -> Value {
    let n = number.to_string();
    let args = [
        "pr", "view", &n,
        "--json", "number,title,state,author,body,comments,reviews,createdAt,headRefName,baseRefName,additions,deletions,files",
    ];
    json_or_error(run_gh(Some(&cwd), &args, READ_TIMEOUT))
}

#[tauri::command]
pub async fn github_issue_view(cwd: String, number: i64) -> Value {
    let n = number.to_string();
    let args = [
        "issue", "view", &n,
        "--json", "number,title,state,author,body,comments,createdAt,labels",
    ];
    json_or_error(run_gh(Some(&cwd), &args, READ_TIMEOUT))
}

#[tauri::command]
pub async fn github_pr_comment(cwd: String, number: i64, body: String) -> Value {
    let n = number.to_string();
    let args = ["pr", "comment", &n, "--body", &body];
    match run_gh(Some(&cwd), &args, READ_TIMEOUT) {
        Ok(_) => serde_json::json!({ "success": true }),
        Err(e) => serde_json::json!({ "error": e }),
    }
}

#[tauri::command]
pub async fn github_issue_comment(cwd: String, number: i64, body: String) -> Value {
    let n = number.to_string();
    let args = ["issue", "comment", &n, "--body", &body];
    match run_gh(Some(&cwd), &args, READ_TIMEOUT) {
        Ok(_) => serde_json::json!({ "success": true }),
        Err(e) => serde_json::json!({ "error": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_or_error_parses_valid_json() {
        let v = json_or_error(Ok(r#"[{"number":1,"title":"hi"}]"#.into()));
        let arr = v.as_array().expect("array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["number"], 1);
    }

    #[test]
    fn json_or_error_wraps_invalid_json() {
        let v = json_or_error(Ok("not json".into()));
        let err = v.get("error").and_then(Value::as_str).unwrap_or_default();
        assert!(err.contains("gh JSON parse failed"), "got: {err}");
    }

    #[test]
    fn json_or_error_wraps_command_error() {
        let v = json_or_error(Err("nope".into()));
        assert_eq!(v.get("error").and_then(Value::as_str), Some("nope"));
    }

    #[test]
    fn cli_status_serializes_camel_case() {
        // The renderer reads `{installed, authenticated}` as
        // camelCase. Both fields are simple booleans, so serde's
        // default rename keeps the wire format intact.
        let s = CliStatus { installed: true, authenticated: false };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"installed\":true"));
        assert!(json.contains("\"authenticated\":false"));
    }

    #[test]
    fn run_gh_rejects_missing_cwd() {
        // We can't depend on `gh` being installed in CI, so just
        // assert the cwd validation kicks in before we spawn.
        let r = run_gh(Some(""), &["--version"], CHECK_TIMEOUT);
        assert!(r.is_err());
        let r = run_gh(
            Some("C:/this/path/should/never/exist/abc123"),
            &["--version"],
            CHECK_TIMEOUT,
        );
        assert!(r.is_err());
    }
}
