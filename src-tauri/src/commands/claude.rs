// claude.* — first cut of the Phase 2 sidecar surface.
//
// These commands forward to the Node sidecar over JSON-RPC. The actual
// Claude/agent logic lives in node-sidecar/src/server.mjs (and will grow
// as we move @anthropic-ai/claude-agent-sdk callsites out of the Electron
// main process). The Rust side is intentionally thin: pick a method name,
// pass through params, and return whatever the sidecar returns.
//
// MVP commands:
//   claude_ping            — round-trip probe used by tests.
//   claude_auth_status     — returns null until accounts are wired through.
//   claude_account_list    — reads Rust account_store index.
//
// Each one resolves the SpawnConfig from the AppHandle so the bridge can
// find both `node` on PATH and the bundled sidecar script. Failures bubble
// up as { message } strings to the renderer.

use crate::account_store;
use crate::codex_app_server::{should_handle_codex, CodexAppServerState};
use crate::commands::notification as notification_cmd;
use crate::event_hub::publish_runtime_event;
use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, BridgeError, SidecarState};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
// Long-running calls (startSession can boot the agent SDK, sendMessage may
// stream for minutes). 5 minutes is generous but bounded — callers that
// need true cancellation should issue abortSession through a separate
// invoke rather than relying on this timeout.
const SESSION_TIMEOUT: Duration = Duration::from_secs(300);
const SESSION_LIST_LIMIT: usize = 50;
const PREVIEW_LINE_LIMIT: usize = 20;
const PREVIEW_CHARS: usize = 120;
const AUTH_STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

fn call(
    app: &AppHandle,
    state: &SidecarState,
    method: &str,
    params: Value,
) -> Result<Value, BridgeError> {
    call_with_timeout(app, state, method, params, DEFAULT_TIMEOUT)
}

fn call_with_timeout(
    app: &AppHandle,
    state: &SidecarState,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, BridgeError> {
    let cfg = resolve_spawn_config(app)?;
    let sink = app_handle_emit_sink(app.clone());
    state.call_with_emit(&cfg, Some(sink), method, params, timeout)
}

async fn call_blocking(
    app: AppHandle,
    state: State<'_, SidecarState>,
    method: &'static str,
    params: Value,
) -> Result<Value, BridgeError> {
    call_with_timeout_blocking(app, state, method, params, DEFAULT_TIMEOUT).await
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, BridgeError> {
    app.path().app_data_dir().map_err(|err| BridgeError {
        message: format!("could not resolve app data dir: {err}"),
    })
}

fn account_error(err: impl std::fmt::Display) -> BridgeError {
    BridgeError {
        message: err.to_string(),
    }
}

fn claude_sdk_package_name(target_os: &str, arch: &str) -> Option<&'static str> {
    match (target_os, arch) {
        ("windows", "x86_64") => Some("claude-agent-sdk-win32-x64"),
        ("windows", "aarch64") => Some("claude-agent-sdk-win32-arm64"),
        ("macos", "x86_64") => Some("claude-agent-sdk-darwin-x64"),
        ("macos", "aarch64") => Some("claude-agent-sdk-darwin-arm64"),
        ("linux", "x86_64") => Some("claude-agent-sdk-linux-x64"),
        ("linux", "aarch64") => Some("claude-agent-sdk-linux-arm64"),
        _ => None,
    }
}

fn claude_exe_name(target_os: &str) -> &'static str {
    if target_os == "windows" {
        "claude.exe"
    } else {
        "claude"
    }
}

fn find_bundled_claude_cli_in_base(
    base_dir: &Path,
    target_os: &str,
    arch: &str,
) -> Option<PathBuf> {
    let package = claude_sdk_package_name(target_os, arch)?;
    let candidate = base_dir
        .join("node-sidecar")
        .join("node_modules")
        .join("@anthropic-ai")
        .join(package)
        .join(claude_exe_name(target_os));
    candidate.is_file().then_some(candidate)
}

fn find_claude_cli_on_path(
    path_env: Option<&str>,
    pathext_env: Option<&str>,
    target_os: &str,
) -> Option<PathBuf> {
    let path_env = path_env?;
    let exts = if target_os == "windows" {
        pathext_env
            .unwrap_or(".COM;.EXE;.BAT;.CMD")
            .split(';')
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(path_env).find_map(|dir| {
        exts.iter().find_map(|ext| {
            let candidate = dir.join(format!("claude{ext}"));
            candidate.is_file().then_some(candidate)
        })
    })
}

fn resolve_claude_cli_path(app: &AppHandle) -> String {
    if let Ok(override_path) = std::env::var("BAT_SIDECAR_CLAUDE_BIN") {
        if !override_path.trim().is_empty() {
            return override_path;
        }
    }
    let target_os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(candidate) = find_bundled_claude_cli_in_base(&resource_dir, target_os, arch) {
            return candidate.to_string_lossy().to_string();
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(candidate) = find_bundled_claude_cli_in_base(&cwd, target_os, arch) {
            return candidate.to_string_lossy().to_string();
        }
    }
    find_claude_cli_on_path(
        std::env::var("PATH").ok().as_deref(),
        std::env::var("PATHEXT").ok().as_deref(),
        target_os,
    )
    .map(|path| path.to_string_lossy().to_string())
    .unwrap_or_default()
}

fn build_claude_cli_command(cli_path: &str, args: &[&str]) -> Command {
    if cfg!(windows) {
        let ext = Path::new(cli_path)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if matches!(ext.as_deref(), Some("cmd") | Some("bat")) {
            let mut command = Command::new("cmd");
            command.arg("/C").arg(cli_path).args(args);
            return command;
        }
    }
    let mut command = Command::new(cli_path);
    command.args(args);
    command
}

fn run_claude_cli_native(
    app: &AppHandle,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let cli_path = resolve_claude_cli_path(app);
    if cli_path.trim().is_empty() {
        return Err("Claude CLI not found".to_string());
    }
    let mut child = build_claude_cli_command(&cli_path, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| err.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(status.to_string());
                }
                let mut stdout = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                return Ok(stdout);
            }
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Claude CLI timed out".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => return Err(err.to_string()),
        }
    }
}

fn parse_auth_status_stdout(stdout: &str) -> Value {
    serde_json::from_str::<Value>(stdout).unwrap_or(Value::Null)
}

fn fetch_auth_status_native(app: &AppHandle) -> Value {
    run_claude_cli_native(app, &["auth", "status"], AUTH_STATUS_TIMEOUT)
        .map(|stdout| parse_auth_status_stdout(&stdout))
        .unwrap_or(Value::Null)
}

fn account_info_from_auth_status(value: &Value) -> Value {
    let email = value.get("email").and_then(Value::as_str);
    let subscription_type = value.get("subscriptionType").and_then(Value::as_str);
    if email.is_none() && subscription_type.is_none() {
        return Value::Null;
    }
    let mut info = serde_json::Map::new();
    if let Some(email) = email {
        info.insert("email".to_string(), Value::String(email.to_string()));
    }
    if let Some(subscription_type) = subscription_type {
        info.insert(
            "subscriptionType".to_string(),
            Value::String(subscription_type.to_string()),
        );
    }
    Value::Object(info)
}

fn auth_login_native(app: &AppHandle) -> Value {
    match run_claude_cli_native(app, &["auth", "login"], AUTH_LOGIN_TIMEOUT) {
        Ok(_) => json!({ "success": true }),
        Err(err) => json!({ "success": false, "error": err }),
    }
}

fn auth_logout_native(app: &AppHandle) -> Value {
    match run_claude_cli_native(app, &["auth", "logout"], AUTH_STATUS_TIMEOUT) {
        Ok(_) => json!({ "success": true }),
        Err(err) => json!({ "success": false, "error": err }),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SkillScanEntry {
    name: String,
    description: String,
    scope: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionListEntry {
    sdk_session_id: String,
    timestamp: u128,
    preview: String,
    message_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SlashCommandEntry {
    name: String,
    description: String,
    argument_hint: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AgentScanEntry {
    name: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn system_time_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn encode_claude_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn claude_project_dir_candidates(projects_dir: &Path, cwd: &str) -> Vec<PathBuf> {
    let encoded = encode_claude_project_dir(cwd);
    let mut candidates = vec![projects_dir.join(&encoded)];
    if cfg!(windows) && !encoded.is_empty() {
        let mut chars = encoded.chars();
        if let Some(first) = chars.next() {
            let rest = chars.as_str();
            let lower = format!("{}{}", first.to_ascii_lowercase(), rest);
            let upper = format!("{}{}", first.to_ascii_uppercase(), rest);
            if lower != encoded {
                candidates.push(projects_dir.join(lower));
            }
            if upper != encoded {
                candidates.push(projects_dir.join(upper));
            }
        }
    }
    candidates
}

fn preview_text_from_claude_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.chars().take(PREVIEW_CHARS).collect());
    }
    content.as_array().and_then(|blocks| {
        blocks.iter().find_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| text.chars().take(PREVIEW_CHARS).collect())
            } else {
                None
            }
        })
    })
}

fn read_claude_session_preview(path: &Path) -> (String, usize) {
    let Ok(file) = fs::File::open(path) else {
        return (String::new(), 0);
    };
    let reader = BufReader::new(file);
    let mut preview = String::new();
    let mut message_count = 0;
    for line in reader
        .lines()
        .map_while(Result::ok)
        .take(PREVIEW_LINE_LIMIT)
    {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        message_count += 1;
        if preview.is_empty() && value.get("type").and_then(Value::as_str) == Some("user") {
            if let Some(text) = preview_text_from_claude_content(&value["message"]["content"]) {
                preview = text;
            }
        }
    }
    (preview, message_count)
}

fn list_claude_sessions_in_projects(cwd: &str, projects_dir: &Path) -> Vec<SessionListEntry> {
    if cwd.is_empty() {
        return Vec::new();
    }
    let mut results = Vec::new();
    for dir in claude_project_dir_candidates(projects_dir, cwd) {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let (preview, message_count) = read_claude_session_preview(&path);
            results.push(SessionListEntry {
                sdk_session_id: stem.to_string(),
                timestamp: metadata
                    .modified()
                    .map(system_time_millis)
                    .unwrap_or_default(),
                preview: if preview.is_empty() {
                    "(no preview)".to_string()
                } else {
                    preview
                },
                message_count,
            });
        }
    }

    let mut seen = HashSet::new();
    let mut deduped = results
        .into_iter()
        .filter(|entry| seen.insert(entry.sdk_session_id.clone()))
        .collect::<Vec<_>>();
    deduped.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    deduped.truncate(SESSION_LIST_LIMIT);
    deduped
}

fn walk_jsonl_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_jsonl_files(&path, out);
        } else if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn first_codex_input_text(value: &Value) -> Option<String> {
    let payload = value.get("payload")?;
    payload
        .get("input")
        .or_else(|| payload.get("message"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("op")
                .and_then(|op| op.get("content"))
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find_map(|item| {
                        if item.get("type").and_then(Value::as_str) == Some("input_text") {
                            item.get("text").and_then(Value::as_str)
                        } else {
                            None
                        }
                    })
                })
        })
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .map(|text| {
            text.lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(PREVIEW_CHARS)
                .collect()
        })
}

fn read_codex_session_summary(path: &Path) -> Option<(String, String)> {
    let Ok(file) = fs::File::open(path) else {
        return None;
    };
    let reader = BufReader::new(file);
    let mut thread_id = String::new();
    let mut preview = String::new();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if thread_id.is_empty() && value.get("type").and_then(Value::as_str) == Some("session_meta")
        {
            if let Some(id) = value["payload"]["id"].as_str().filter(|id| !id.is_empty()) {
                thread_id = id.to_string();
            }
        }
        if preview.is_empty() {
            if let Some(text) = first_codex_input_text(&value) {
                preview = text;
            }
        }
        if !thread_id.is_empty() && !preview.is_empty() {
            break;
        }
    }
    Some((thread_id, preview))
}

fn list_codex_sessions_in_root(root: &Path) -> Vec<SessionListEntry> {
    let mut files = Vec::new();
    walk_jsonl_files(root, &mut files);
    let mut results = Vec::new();
    for path in files {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let fallback_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string();
        if fallback_id.is_empty() {
            continue;
        }
        let (mut sdk_session_id, preview) =
            read_codex_session_summary(&path).unwrap_or_else(|| (String::new(), String::new()));
        if sdk_session_id.is_empty() {
            sdk_session_id = fallback_id;
        }
        let preview = if preview.is_empty() {
            format!(
                "({}...)",
                sdk_session_id.chars().take(8).collect::<String>()
            )
        } else {
            preview
        };
        results.push(SessionListEntry {
            sdk_session_id,
            timestamp: metadata
                .modified()
                .map(system_time_millis)
                .unwrap_or_default(),
            preview,
            message_count: 0,
        });
    }
    results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    results.truncate(SESSION_LIST_LIMIT);
    results
}

fn list_sessions_native(cwd: &str, agent_kind: Option<&str>) -> Vec<SessionListEntry> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    if agent_kind == Some("codex") {
        return list_codex_sessions_in_root(&home.join(".codex").join("sessions"));
    }
    list_claude_sessions_in_projects(cwd, &home.join(".claude").join("projects"))
}

fn claude_builtin_models_native() -> Value {
    json!([
        {
            "value": "claude-opus-4-7:auto-compact-200k",
            "displayName": "Opus 4.7 · 200K Auto-Compact",
            "description": "claude-opus-4-7 · compact at 200K tokens",
            "source": "builtin"
        },
        {
            "value": "claude-opus-4-7:auto-compact-300k",
            "displayName": "Opus 4.7 · 300K Auto-Compact",
            "description": "claude-opus-4-7 · compact at 300K tokens",
            "source": "builtin"
        },
        {
            "value": "claude-opus-4-7:auto-compact-400k",
            "displayName": "Opus 4.7 · 400K Auto-Compact",
            "description": "claude-opus-4-7 · compact at 400K tokens",
            "source": "builtin"
        },
        {
            "value": "claude-opus-4-7:1m",
            "displayName": "Opus 4.7 · 1M",
            "description": "claude-opus-4-7 · no early auto-compact",
            "source": "builtin"
        },
        {
            "value": "claude-opus-4-6",
            "displayName": "Opus 4.6 (1M)",
            "description": "claude-opus-4-6 · 1M context",
            "source": "builtin"
        },
        {
            "value": "claude-sonnet-4-6",
            "displayName": "Sonnet 4.6 (1M)",
            "description": "claude-sonnet-4-6 · 1M context",
            "source": "builtin"
        },
        {
            "value": "claude-haiku-4-5-20251001",
            "displayName": "Haiku 4.5",
            "description": "claude-haiku-4-5 · fast & lightweight",
            "source": "builtin"
        }
    ])
}

fn claude_context_window_for_model(model: Option<&str>) -> u64 {
    match model.unwrap_or_default() {
        "claude-opus-4-7"
        | "claude-opus-4-7[1m]"
        | "claude-opus-4-7:1m"
        | "claude-opus-4-6"
        | "claude-opus-4-6[1m]"
        | "claude-sonnet-4-6"
        | "claude-sonnet-4-6[1m]" => 1_000_000,
        "claude-haiku-4-5-20251001" => 200_000,
        "claude-opus-4-7:auto-compact-200k" => 200_000,
        "claude-opus-4-7:auto-compact-300k" => 300_000,
        "claude-opus-4-7:auto-compact-400k" => 400_000,
        value if value.ends_with("[1m]") => {
            claude_context_window_for_model(Some(value.trim_end_matches("[1m]")))
        }
        _ => 0,
    }
}

fn session_meta_from_notification_snapshot(
    session: &notification_cmd::AgentNotificationSession,
) -> Value {
    if let Some(meta) = session.latest_meta.as_ref() {
        return meta.clone();
    }
    let model = session.model.as_deref();
    json!({
        "permissionMode": session.permission_mode.as_deref().unwrap_or("default"),
        "model": session.model.as_deref(),
        "effort": session.effort.as_deref(),
        "autoCompactWindow": session.auto_compact_window,
        "sdkSessionId": session.sdk_session_id.as_deref(),
        "cwd": session.cwd.as_str(),
        "totalCost": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "durationMs": 0,
        "numTurns": 0,
        "contextWindow": claude_context_window_for_model(model),
        "maxOutputTokens": 0,
        "contextTokens": 0,
        "cacheReadTokens": 0,
        "cacheCreationTokens": 0,
        "callCacheRead": 0,
        "callCacheWrite": 0,
        "lastQueryCalls": 0,
        "codexSandboxMode": session.codex_sandbox_mode.as_deref(),
        "codexApprovalPolicy": session.codex_approval_policy.as_deref(),
    })
}

fn supported_commands_native(cwd: &Path) -> Vec<SlashCommandEntry> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut push_unique = |entry: SkillScanEntry| {
        if seen.insert(entry.name.clone()) {
            entries.push(SlashCommandEntry {
                name: entry.name,
                description: entry.description,
                argument_hint: String::new(),
            });
        }
    };
    for entry in scan_commands_dir(&cwd.join(".claude").join("commands"), "project") {
        push_unique(entry);
    }
    if let Some(home) = home_dir() {
        for entry in scan_commands_dir(&home.join(".claude").join("commands"), "global") {
            push_unique(entry);
        }
    }
    entries
}

fn scan_agents_dir(dir: &Path) -> Vec<AgentScanEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                return None;
            }
            let content = fs::read_to_string(&path).ok()?;
            let fallback_name = path.file_stem()?.to_string_lossy().to_string();
            let name =
                parse_frontmatter_field(&content, "name").unwrap_or_else(|| fallback_name.clone());
            let description = parse_frontmatter_field(&content, "description")
                .unwrap_or_else(|| first_heading(&content));
            let model =
                parse_frontmatter_field(&content, "model").filter(|value| !value.is_empty());
            Some(AgentScanEntry {
                name,
                description,
                model,
            })
        })
        .collect()
}

fn supported_agents_native(cwd: &Path) -> Vec<AgentScanEntry> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut push_unique = |entry: AgentScanEntry| {
        if seen.insert(entry.name.clone()) {
            entries.push(entry);
        }
    };
    for entry in scan_agents_dir(&cwd.join(".claude").join("agents")) {
        push_unique(entry);
    }
    if let Some(home) = home_dir() {
        for entry in scan_agents_dir(&home.join(".claude").join("agents")) {
            push_unique(entry);
        }
    }
    entries
}

fn parse_frontmatter_field(content: &str, field: &str) -> Option<String> {
    let rest = content.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let block = rest[..end].trim();
    for line in block.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() == field {
            return Some(value.trim().trim_matches(['"', '\'']).to_string());
        }
    }
    None
}

fn first_heading(content: &str) -> String {
    let body = if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            &rest[end + 4..]
        } else {
            content
        }
    } else {
        content
    };
    body.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .trim_start_matches('#')
        .trim()
        .chars()
        .take(200)
        .collect()
}

fn scan_markdown_file(path: &Path, fallback_name: &str, scope: &str) -> Option<SkillScanEntry> {
    let content = fs::read_to_string(path).ok()?;
    let name = parse_frontmatter_field(&content, "name").unwrap_or_else(|| fallback_name.into());
    let description =
        parse_frontmatter_field(&content, "description").unwrap_or_else(|| first_heading(&content));
    Some(SkillScanEntry {
        name,
        description,
        scope: scope.to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

fn scan_commands_dir(dir: &Path, scope: &str) -> Vec<SkillScanEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                return None;
            }
            let name = path.file_stem()?.to_string_lossy().to_string();
            scan_markdown_file(&path, &name, scope)
        })
        .collect()
}

fn scan_skills_dir(dir: &Path, scope: &str) -> Vec<SkillScanEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                let skill_md = path.join("SKILL.md");
                let name = path.file_name()?.to_string_lossy().to_string();
                return scan_markdown_file(&skill_md, &name, scope);
            }
            if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                let name = path.file_stem()?.to_string_lossy().to_string();
                return scan_markdown_file(&path, &name, scope);
            }
            None
        })
        .collect()
}

fn scan_skills_native(cwd: &Path) -> Vec<SkillScanEntry> {
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push_unique = |entry: SkillScanEntry| {
        if seen.insert(entry.name.clone()) {
            results.push(entry);
        }
    };

    for entry in scan_commands_dir(&cwd.join(".claude").join("commands"), "project") {
        push_unique(entry);
    }
    for entry in scan_skills_dir(&cwd.join(".claude").join("skills"), "project") {
        push_unique(entry);
    }
    if let Some(home) = home_dir() {
        for entry in scan_commands_dir(&home.join(".claude").join("commands"), "global") {
            push_unique(entry);
        }
        for entry in scan_skills_dir(&home.join(".claude").join("skills"), "global") {
            push_unique(entry);
        }
    }
    results
}

fn read_json_safe(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_mcp_server_names(cwd: &Path) -> Option<Vec<String>> {
    let parsed = read_json_safe(&cwd.join(".mcp.json"))?;
    let servers = parsed.get("mcpServers")?.as_object()?;
    if servers.is_empty() {
        return None;
    }
    Some(servers.keys().cloned().collect())
}

fn mcp_settings_approves(settings: Option<&Value>, server_names: &[String]) -> bool {
    let Some(settings) = settings else {
        return false;
    };
    if settings
        .get("enableAllProjectMcpServers")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    let Some(list) = settings
        .get("enabledMcpjsonServers")
        .and_then(Value::as_array)
    else {
        return false;
    };
    server_names.iter().all(|name| {
        list.iter()
            .any(|value| value.as_str().is_some_and(|enabled| enabled == name))
    })
}

fn check_mcp_json_status_native(cwd: &Path) -> Value {
    if cwd.as_os_str().is_empty() {
        return json!({ "exists": false, "approved": false, "servers": [] });
    }
    let Some(servers) = read_mcp_server_names(cwd) else {
        return json!({ "exists": false, "approved": false, "servers": [] });
    };
    let mut sources = vec![
        cwd.join(".claude").join("settings.json"),
        cwd.join(".claude").join("settings.local.json"),
    ];
    if let Some(home) = home_dir() {
        sources.insert(0, home.join(".claude").join("settings.json"));
    }
    let approved = sources
        .iter()
        .any(|path| mcp_settings_approves(read_json_safe(path).as_ref(), &servers));
    json!({ "exists": true, "approved": approved, "servers": servers })
}

fn enable_all_project_mcp_native(cwd: &Path) -> Result<Value, BridgeError> {
    if cwd.as_os_str().is_empty() {
        return Err(BridgeError {
            message: "claude.enableAllProjectMcp: missing cwd".into(),
        });
    }
    let dir = cwd.join(".claude");
    let path = dir.join("settings.json");
    fs::create_dir_all(&dir).map_err(|err| BridgeError {
        message: format!("could not create {}: {err}", dir.display()),
    })?;
    let mut settings = read_json_safe(&path).unwrap_or_else(|| json!({}));
    if !settings.is_object() {
        settings = json!({});
    }
    if settings
        .get("enableAllProjectMcpServers")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Ok(json!({ "ok": true, "changed": false, "path": path.to_string_lossy() }));
    }
    if let Some(obj) = settings.as_object_mut() {
        obj.insert("enableAllProjectMcpServers".into(), Value::Bool(true));
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|err| BridgeError {
        message: err.to_string(),
    })? + "\n";
    fs::write(&path, text).map_err(|err| BridgeError {
        message: format!("could not write {}: {err}", path.display()),
    })?;
    Ok(json!({ "ok": true, "changed": true, "path": path.to_string_lossy() }))
}

fn archive_empty_page() -> Value {
    json!({ "messages": [], "total": 0, "hasMore": false })
}

fn archive_file_path(data_dir: &Path, session_id: &str) -> PathBuf {
    let safe = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    data_dir
        .join("message-archives")
        .join(format!("{safe}.jsonl"))
}

fn archive_messages_in_dir(
    data_dir: &Path,
    session_id: &str,
    messages: &Value,
) -> std::io::Result<bool> {
    if session_id.is_empty() {
        return Ok(false);
    }
    let Some(items) = messages.as_array() else {
        return Ok(false);
    };
    if items.is_empty() {
        return Ok(true);
    }
    let archive_dir = data_dir.join("message-archives");
    fs::create_dir_all(&archive_dir)?;
    let path = archive_file_path(data_dir, session_id);
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    for item in items {
        serde_json::to_writer(&mut file, item)?;
        writeln!(file)?;
    }
    Ok(true)
}

fn load_archived_from_dir(data_dir: &Path, session_id: &str, offset: u32, limit: u32) -> Value {
    if session_id.is_empty() {
        return archive_empty_page();
    }
    let raw = match fs::read_to_string(archive_file_path(data_dir, session_id)) {
        Ok(value) => value,
        Err(_) => return archive_empty_page(),
    };
    let lines = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    let total = lines.len();
    let offset = offset as usize;
    let limit = limit as usize;
    let end = total.saturating_sub(offset);
    if end == 0 {
        return json!({ "messages": [], "total": total, "hasMore": false });
    }
    let start = end.saturating_sub(limit);
    let messages = lines[start..end]
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    json!({ "messages": messages, "total": total, "hasMore": start > 0 })
}

fn clear_archive_in_dir(data_dir: &Path, session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    let _ = fs::remove_file(archive_file_path(data_dir, session_id));
    true
}

fn login_success(value: &Value) -> bool {
    value
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

async fn call_with_timeout_blocking(
    app: AppHandle,
    state: State<'_, SidecarState>,
    method: &'static str,
    params: Value,
    timeout: Duration,
) -> Result<Value, BridgeError> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        call_with_timeout(&app, &state, method, params, timeout)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("{method} worker failed: {err}"),
    })?
}

fn emit_codex_route_metric(
    app: &AppHandle,
    phase: &str,
    method: &str,
    session_id: &str,
    elapsed: Duration,
    ok: bool,
    detail: Option<String>,
) {
    let mut payload = json!({
        "phase": phase,
        "method": method,
        "sessionId": session_id,
        "elapsedMs": elapsed.as_millis() as u64,
        "ok": ok,
    });
    if let Some(detail) = detail {
        payload["detail"] = Value::String(detail);
    }
    publish_runtime_event(app, "sidecar:metric", payload, "codex-route");
}

fn codex_worktree_rehydrate_params(session_id: &str, options: &Option<Value>) -> Option<Value> {
    let options = options.as_ref()?;
    if options.get("agentPreset").and_then(Value::as_str) != Some("codex-agent-worktree") {
        return None;
    }
    let worktree_path = options
        .get("worktreePath")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())?;
    let cwd = options
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .unwrap_or(worktree_path);
    let branch_name = options
        .get("worktreeBranch")
        .and_then(Value::as_str)
        .filter(|branch| !branch.trim().is_empty())
        .unwrap_or("worktree");
    Some(json!({
        "sessionId": session_id,
        "cwd": cwd,
        "worktreePath": worktree_path,
        "branchName": branch_name,
    }))
}

async fn rehydrate_codex_worktree_if_needed(
    app: &AppHandle,
    sidecar_state: SidecarState,
    session_id: &str,
    options: &Option<Value>,
) {
    let Some(params) = codex_worktree_rehydrate_params(session_id, options) else {
        return;
    };
    let app_for_call = app.clone();
    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        call_with_timeout(
            &app_for_call,
            &sidecar_state,
            "worktree.rehydrate",
            params,
            DEFAULT_TIMEOUT,
        )
    })
    .await;
    match result {
        Ok(Ok(_)) => emit_codex_route_metric(
            app,
            "codexWorktree",
            "worktree.rehydrate",
            session_id,
            started.elapsed(),
            true,
            None,
        ),
        Ok(Err(err)) => emit_codex_route_metric(
            app,
            "codexWorktree",
            "worktree.rehydrate",
            session_id,
            started.elapsed(),
            false,
            Some(err.message),
        ),
        Err(err) => emit_codex_route_metric(
            app,
            "codexWorktree",
            "worktree.rehydrate",
            session_id,
            started.elapsed(),
            false,
            Some(format!("worktree.rehydrate worker failed: {err}")),
        ),
    }
}

#[tauri::command]
pub fn claude_ping(
    app: AppHandle,
    state: State<'_, SidecarState>,
    payload: Option<Value>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "ping", payload.unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn claude_auth_status(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    let value = tauri::async_runtime::spawn_blocking(move || fetch_auth_status_native(&app))
        .await
        .map_err(|err| BridgeError {
            message: format!("claude.authStatus worker failed: {err}"),
        })?;
    Ok(value)
}

#[tauri::command]
pub async fn claude_account_list(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    let app_data_dir = app_data_dir(&app)?;
    let index = account_store::read_index(&app_data_dir);
    Ok(serde_json::to_value(index).unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn claude_start_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    notification_cmd::register_agent_session_from_options(
        &app,
        window.label(),
        &session_id,
        options.as_ref(),
    );
    if should_handle_codex(&options) {
        rehydrate_codex_worktree_if_needed(&app, (*state).clone(), &session_id, &options).await;
        let codex = (*codex_state).clone();
        let codex_app = app.clone();
        let codex_session_id = session_id.clone();
        let codex_options = options.clone();
        let started = Instant::now();
        let result = tauri::async_runtime::spawn_blocking(move || {
            codex.start_session(&codex_app, codex_session_id, codex_options)
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("codex app-server start worker failed: {err}"),
        })?;
        match result {
            Ok(value) => {
                emit_codex_route_metric(
                    &app,
                    "codexRuntime",
                    "codex.startSession",
                    &session_id,
                    started.elapsed(),
                    true,
                    None,
                );
                return Ok(value);
            }
            Err(err) => {
                emit_codex_route_metric(
                    &app,
                    "codexRuntime",
                    "codex.startSession",
                    &session_id,
                    started.elapsed(),
                    false,
                    Some(format!("falling back to sidecar: {}", err.message)),
                );
            }
        }
        let _ = (*codex_state).stop_session(session_id.clone());
    }
    call_with_timeout_blocking(
        app,
        state,
        "claude.startSession",
        json!({ "sessionId": session_id, "options": options.unwrap_or(Value::Null) }),
        SESSION_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn claude_send_message(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    prompt: String,
    images: Option<Vec<String>>,
    auto_compact_window: Option<i64>,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        let codex = (*codex_state).clone();
        let codex_app = app.clone();
        let codex_session_id = session_id.clone();
        let codex_prompt = prompt.clone();
        let codex_images = images.clone().unwrap_or_default();
        return tauri::async_runtime::spawn_blocking(move || {
            codex.send_message(&codex_app, codex_session_id, codex_prompt, codex_images)
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("codex app-server send worker failed: {err}"),
        })?;
    }
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        call_with_timeout(
            &app,
            &state,
            "claude.sendMessage",
            json!({
                "sessionId": session_id,
                "prompt": prompt,
                "images": images.unwrap_or_default(),
                "autoCompactWindow": auto_compact_window,
            }),
            SESSION_TIMEOUT,
        )
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("claude.sendMessage worker failed: {err}"),
    })?
}

#[tauri::command]
pub async fn claude_stop_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    notification_cmd::unregister_agent_session(&app, &session_id);
    if codex_state.is_owned(&session_id) {
        return Ok(codex_state.stop_session(session_id));
    }
    call_blocking(
        app,
        state,
        "claude.stopSession",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_abort_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        let codex = (*codex_state).clone();
        let codex_app = app.clone();
        let codex_session_id = session_id.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            codex.abort_session(&codex_app, codex_session_id)
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("codex app-server abort worker failed: {err}"),
        })?;
    }
    call_blocking(
        app,
        state,
        "claude.abortSession",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_stop_task(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    task_id: String,
) -> Result<bool, BridgeError> {
    if codex_state.is_owned(&session_id) {
        let codex = (*codex_state).clone();
        let codex_app = app.clone();
        let codex_session_id = session_id.clone();
        let value = tauri::async_runtime::spawn_blocking(move || {
            codex.abort_session(&codex_app, codex_session_id)
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("codex app-server stopTask worker failed: {err}"),
        })??;
        return Ok(value.get("ok").and_then(Value::as_bool).unwrap_or(true));
    }
    let value = call_blocking(
        app,
        state,
        "claude.stopTask",
        json!({ "sessionId": session_id, "taskId": task_id }),
    )
    .await?;
    Ok(value
        .as_bool()
        .or_else(|| value.get("ok").and_then(Value::as_bool))
        .unwrap_or(false))
}

// --- account / auth ops ---------------------------------------------------

#[tauri::command]
pub async fn claude_auth_login(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    tauri::async_runtime::spawn_blocking(move || auth_login_native(&app))
        .await
        .map_err(|err| BridgeError {
            message: format!("claude.authLogin worker failed: {err}"),
        })
}

#[tauri::command]
pub async fn claude_auth_logout(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    tauri::async_runtime::spawn_blocking(move || auth_logout_native(&app))
        .await
        .map_err(|err| BridgeError {
            message: format!("claude.authLogout worker failed: {err}"),
        })
}

#[tauri::command]
pub async fn claude_account_import_current(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    let app_data_dir = app_data_dir(&app)?;
    let status_app = app.clone();
    let status_value =
        tauri::async_runtime::spawn_blocking(move || fetch_auth_status_native(&status_app))
            .await
            .map_err(|err| BridgeError {
                message: format!("claude.accountImportCurrent authStatus worker failed: {err}"),
            })?;
    let Some(status) = account_store::auth_status_from_value(&status_value) else {
        return Ok(Value::Null);
    };
    let Some(credential) = account_store::read_cli_credentials() else {
        return Ok(Value::Null);
    };
    let account = account_store::import_current_account(&app_data_dir, status, credential)
        .map_err(account_error)?;
    Ok(serde_json::to_value(account).unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn claude_account_login_new(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    let app_data_dir = app_data_dir(&app)?;
    let index = account_store::read_index(&app_data_dir);
    let active_account_id = index.active_account_id.clone();
    let backup_credential = account_store::read_cli_credentials();
    let login_app = app.clone();
    let login_result = tauri::async_runtime::spawn_blocking(move || auth_login_native(&login_app))
        .await
        .map_err(|err| BridgeError {
            message: format!("claude.accountLoginNew authLogin worker failed: {err}"),
        })?;
    if !login_success(&login_result) {
        return Ok(login_result);
    }
    let status_app = app.clone();
    let status_value =
        tauri::async_runtime::spawn_blocking(move || fetch_auth_status_native(&status_app))
            .await
            .map_err(|err| BridgeError {
                message: format!("claude.accountLoginNew authStatus worker failed: {err}"),
            })?;
    let Some(status) = account_store::auth_status_from_value(&status_value) else {
        if let Some(backup) = backup_credential {
            let _ = account_store::write_cli_credentials(&backup);
        }
        return Ok(
            json!({ "success": false, "error": "Login completed but could not verify account" }),
        );
    };
    let Some(new_credential) = account_store::read_cli_credentials() else {
        if let Some(backup) = backup_credential {
            let _ = account_store::write_cli_credentials(&backup);
        }
        return Ok(json!({ "success": false, "error": "Could not read credentials after login" }));
    };
    let account =
        match account_store::upsert_new_login_account(&app_data_dir, status, new_credential) {
            Ok(account) => account,
            Err(err) => {
                if let Some(backup) = backup_credential {
                    let _ = account_store::write_cli_credentials(&backup);
                }
                return Ok(json!({ "success": false, "error": err.to_string() }));
            }
        };
    if let (Some(backup), Some(active_id)) = (backup_credential, active_account_id) {
        if active_id != account.id {
            let _ = account_store::write_cli_credentials(&backup);
        }
    }
    Ok(json!({ "success": true, "account": account }))
}

#[tauri::command]
pub async fn claude_account_switch(
    app: AppHandle,
    _state: State<'_, SidecarState>,
    account_id: String,
) -> Result<Value, BridgeError> {
    let app_data_dir = app_data_dir(&app)?;
    let ok = account_store::switch_account(&app_data_dir, &account_id).map_err(account_error)?;
    Ok(Value::Bool(ok))
}

#[tauri::command]
pub async fn claude_account_remove(
    app: AppHandle,
    _state: State<'_, SidecarState>,
    account_id: String,
) -> Result<Value, BridgeError> {
    let app_data_dir = app_data_dir(&app)?;
    let ok = account_store::remove_account(&app_data_dir, &account_id).map_err(account_error)?;
    Ok(Value::Bool(ok))
}

#[tauri::command]
pub async fn claude_account_mark_warning_shown(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    let app_data_dir = app_data_dir(&app)?;
    account_store::mark_warning_shown(&app_data_dir).map_err(account_error)?;
    Ok(Value::Bool(true))
}

// --- read-only metadata ---------------------------------------------------

#[tauri::command]
pub async fn claude_get_cli_path(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    Ok(Value::String(resolve_claude_cli_path(&app)))
}

#[tauri::command]
pub async fn claude_list_sessions(
    _app: AppHandle,
    _state: State<'_, SidecarState>,
    cwd: String,
    agent_kind: Option<String>,
) -> Result<Value, BridgeError> {
    Ok(
        serde_json::to_value(list_sessions_native(&cwd, agent_kind.as_deref()))
            .unwrap_or_else(|_| json!([])),
    )
}

#[tauri::command]
pub async fn claude_get_supported_models(
    _app: AppHandle,
    _state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(codex_state.supported_models());
    }
    Ok(claude_builtin_models_native())
}

#[tauri::command]
pub async fn claude_get_supported_commands(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(json!([]));
    }
    if let Some(cwd) = notification_cmd::get_agent_session_cwd(&app, &session_id) {
        return Ok(
            serde_json::to_value(supported_commands_native(Path::new(&cwd)))
                .unwrap_or_else(|_| json!([])),
        );
    }
    call_blocking(
        app,
        state,
        "claude.getSupportedCommands",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_get_supported_agents(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(json!([]));
    }
    if let Some(cwd) = notification_cmd::get_agent_session_cwd(&app, &session_id) {
        return Ok(
            serde_json::to_value(supported_agents_native(Path::new(&cwd)))
                .unwrap_or_else(|_| json!([])),
        );
    }
    call_blocking(
        app,
        state,
        "claude.getSupportedAgents",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_get_account_info(
    app: AppHandle,
    _state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(Value::Null);
    }
    tauri::async_runtime::spawn_blocking(move || {
        account_info_from_auth_status(&fetch_auth_status_native(&app))
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("claude.getAccountInfo worker failed: {err}"),
    })
}

#[tauri::command]
pub async fn claude_get_session_state(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(value) = codex_state.get_session_state(&session_id) {
        return Ok(value);
    }
    call_blocking(
        app,
        state,
        "claude.getSessionState",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_get_session_meta(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(value) = codex_state.get_session_meta(&session_id) {
        return Ok(value);
    }
    if let Some(session) = notification_cmd::get_agent_session_snapshot(&app, &session_id) {
        return Ok(session_meta_from_notification_snapshot(&session));
    }
    call_blocking(
        app,
        state,
        "claude.getSessionMeta",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_get_context_usage(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(value) = codex_state.get_context_usage(&session_id) {
        return Ok(value);
    }
    if codex_state.is_owned(&session_id) {
        return Ok(Value::Null);
    }
    call_blocking(
        app,
        state,
        "claude.getContextUsage",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_get_worktree_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "claude.getWorktreeStatus",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_scan_skills(
    _app: AppHandle,
    _state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    let entries = scan_skills_native(Path::new(&cwd));
    Ok(serde_json::to_value(entries).unwrap_or_else(|_| json!([])))
}

#[tauri::command]
pub async fn claude_cleanup_worktree(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    delete_branch: bool,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "claude.cleanupWorktree",
        json!({
            "sessionId": session_id,
            "deleteBranch": delete_branch,
        }),
    )
    .await
}

// --- per-session state -----------------------------------------------------

#[tauri::command]
pub async fn claude_set_auto_continue(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    opts: Value,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(json!(false));
    }
    call_blocking(
        app,
        state,
        "claude.setAutoContinue",
        json!({
            "sessionId": session_id, "opts": opts,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_get_auto_continue(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(Value::Null);
    }
    call_blocking(
        app,
        state,
        "claude.getAutoContinue",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_set_permission_mode(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    mode: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(json!(false));
    }
    call_blocking(
        app,
        state,
        "claude.setPermissionMode",
        json!({
            "sessionId": session_id, "mode": mode,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_set_codex_sandbox_mode(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    mode: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        let codex = (*codex_state).clone();
        let codex_app = app.clone();
        let codex_session_id = session_id.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let _ = codex.set_sandbox_mode(&codex_app, &codex_session_id, mode);
            codex.reconfigure_session(&codex_app, &codex_session_id)
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("codex app-server setSandboxMode worker failed: {err}"),
        })?;
    }
    call_blocking(
        app,
        state,
        "claude.setCodexSandboxMode",
        json!({
            "sessionId": session_id, "mode": mode,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_set_codex_approval_policy(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    policy: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        let codex = (*codex_state).clone();
        let codex_app = app.clone();
        let codex_session_id = session_id.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let _ = codex.set_approval_policy(&codex_app, &codex_session_id, policy);
            codex.reconfigure_session(&codex_app, &codex_session_id)
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("codex app-server setApprovalPolicy worker failed: {err}"),
        })?;
    }
    call_blocking(
        app,
        state,
        "claude.setCodexApprovalPolicy",
        json!({
            "sessionId": session_id, "policy": policy,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_set_model(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    model: String,
    auto_compact_window: Option<i64>,
) -> Result<Value, BridgeError> {
    if let Some(value) = codex_state.set_model(&app, &session_id, model.clone()) {
        return Ok(value);
    }
    call_blocking(
        app,
        state,
        "claude.setModel",
        json!({
            "sessionId": session_id, "model": model, "autoCompactWindow": auto_compact_window,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_set_effort(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    effort: String,
) -> Result<Value, BridgeError> {
    if let Some(value) = codex_state.set_effort(&app, &session_id, effort.clone()) {
        return Ok(value);
    }
    call_blocking(
        app,
        state,
        "claude.setEffort",
        json!({
            "sessionId": session_id, "effort": effort,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_reset_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        let codex = (*codex_state).clone();
        let codex_app = app.clone();
        let codex_session_id = session_id.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            codex.reset_session(&codex_app, codex_session_id)
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("codex app-server reset worker failed: {err}"),
        })?;
    }
    call_blocking(
        app,
        state,
        "claude.resetSession",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_fork_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(Value::Null);
    }
    // Fork can take up to 60s in pathological cases (the SDK has to run a
    // full one-turn query to persist the new transcript). Use a generous
    // timeout to match the sidecar's internal limit + slack.
    call_with_timeout_blocking(
        app,
        state,
        "claude.forkSession",
        json!({ "sessionId": session_id }),
        Duration::from_secs(90),
    )
    .await
}

#[tauri::command]
pub async fn claude_archive_messages(
    app: AppHandle,
    _state: State<'_, SidecarState>,
    session_id: String,
    messages: Value,
) -> Result<Value, BridgeError> {
    let data_dir = app_data_dir(&app)?;
    match archive_messages_in_dir(&data_dir, &session_id, &messages) {
        Ok(value) => Ok(json!(value)),
        Err(_) => Ok(json!(false)),
    }
}

#[tauri::command]
pub async fn claude_load_archived(
    app: AppHandle,
    _state: State<'_, SidecarState>,
    session_id: String,
    offset: u32,
    limit: u32,
) -> Result<Value, BridgeError> {
    let data_dir = app_data_dir(&app)?;
    Ok(load_archived_from_dir(
        &data_dir,
        &session_id,
        offset,
        limit,
    ))
}

#[tauri::command]
pub async fn claude_clear_archive(
    app: AppHandle,
    _state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    let data_dir = app_data_dir(&app)?;
    Ok(json!(clear_archive_in_dir(&data_dir, &session_id)))
}

#[tauri::command]
pub async fn claude_rest_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(value) = codex_state.rest_session(&app, &session_id) {
        return Ok(value);
    }
    call_blocking(
        app,
        state,
        "claude.restSession",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_wake_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(value) = codex_state.wake_session(&session_id) {
        return Ok(value);
    }
    call_blocking(
        app,
        state,
        "claude.wakeSession",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_is_resting(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(value) = codex_state.is_resting(&session_id) {
        return Ok(value);
    }
    call_blocking(
        app,
        state,
        "claude.isResting",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_fetch_subagent_messages(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    agent_tool_use_id: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(json!([]));
    }
    // Subagent message fetch reads an on-disk transcript shard via the
    // SDK helper; in the worst case (cold SDK load + slow disk) this can
    // take up to a couple of seconds. Bump past the default 15s to be
    // safe — failure path returns [] so the renderer just shows "no
    // messages" instead of throwing.
    call_with_timeout_blocking(
        app,
        state,
        "claude.fetchSubagentMessages",
        json!({ "sessionId": session_id, "agentToolUseId": agent_tool_use_id }),
        Duration::from_secs(30),
    )
    .await
}

#[tauri::command]
pub async fn claude_rewind_to_prompt(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    prompt_index: u32,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(json!({ "error": "Rewind not supported for this session type" }));
    }
    call_blocking(
        app,
        state,
        "claude.rewindToPrompt",
        json!({
            "sessionId": session_id,
            "promptIndex": prompt_index,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_resume_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    sdk_session_id: String,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    notification_cmd::register_agent_session_from_options(
        &app,
        window.label(),
        &session_id,
        options.as_ref(),
    );
    let should_use_codex = should_handle_codex(&options);
    if should_use_codex || codex_state.is_owned(&session_id) {
        rehydrate_codex_worktree_if_needed(&app, (*state).clone(), &session_id, &options).await;
        let codex = (*codex_state).clone();
        let codex_app = app.clone();
        let codex_session_id = session_id.clone();
        let codex_sdk_session_id = sdk_session_id.clone();
        let codex_options = options.clone();
        let resume_started = Instant::now();
        let result = tauri::async_runtime::spawn_blocking(move || {
            codex.resume_session(
                &codex_app,
                codex_session_id,
                codex_sdk_session_id,
                codex_options,
            )
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("codex app-server resume worker failed: {err}"),
        })?;
        match result {
            Ok(value) => {
                emit_codex_route_metric(
                    &app,
                    "codexRuntime",
                    "codex.resumeSession",
                    &session_id,
                    resume_started.elapsed(),
                    true,
                    None,
                );
                return Ok(value);
            }
            Err(err) if should_use_codex => {
                emit_codex_route_metric(
                    &app,
                    "codexRuntime",
                    "codex.resumeSession",
                    &session_id,
                    resume_started.elapsed(),
                    false,
                    Some(format!(
                        "resume failed for stale sdkSessionId {}; starting fresh: {}",
                        sdk_session_id, err.message
                    )),
                );
                let _ = (*codex_state).stop_session(session_id.clone());

                let codex = (*codex_state).clone();
                let codex_app = app.clone();
                let codex_session_id = session_id.clone();
                let codex_options = options.clone();
                let fresh_started = Instant::now();
                let fresh_result = tauri::async_runtime::spawn_blocking(move || {
                    codex.start_session(&codex_app, codex_session_id, codex_options)
                })
                .await
                .map_err(|err| BridgeError {
                    message: format!("codex app-server fresh start worker failed: {err}"),
                })?;
                match fresh_result {
                    Ok(value) => {
                        emit_codex_route_metric(
                            &app,
                            "codexRuntime",
                            "codex.freshStartAfterResumeFailure",
                            &session_id,
                            fresh_started.elapsed(),
                            true,
                            Some(format!("replaced stale sdkSessionId {}", sdk_session_id)),
                        );
                        return Ok(value);
                    }
                    Err(start_err) => {
                        emit_codex_route_metric(
                            &app,
                            "codexRuntime",
                            "codex.freshStartAfterResumeFailure",
                            &session_id,
                            fresh_started.elapsed(),
                            false,
                            Some(format!(
                                "fresh start failed after stale sdkSessionId {}: {}",
                                sdk_session_id, start_err.message
                            )),
                        );
                        let _ = (*codex_state).stop_session(session_id.clone());
                    }
                }
            }
            Err(err) => {
                emit_codex_route_metric(
                    &app,
                    "codexRuntime",
                    "codex.resumeSession",
                    &session_id,
                    resume_started.elapsed(),
                    false,
                    Some(err.message),
                );
                let _ = (*codex_state).stop_session(session_id.clone());
            }
        }
    }
    call_blocking(
        app,
        state,
        "claude.resumeSession",
        json!({
            "sessionId": session_id,
            "sdkSessionId": sdk_session_id,
            "options": options,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_resolve_permission(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    tool_use_id: String,
    result: Value,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(json!(false));
    }
    call_blocking(
        app,
        state,
        "claude.resolvePermission",
        json!({
            "sessionId": session_id, "toolUseId": tool_use_id, "result": result,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_resolve_ask_user(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    tool_use_id: String,
    answers: Value,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(json!(false));
    }
    call_blocking(
        app,
        state,
        "claude.resolveAskUser",
        json!({
            "sessionId": session_id, "toolUseId": tool_use_id, "answers": answers,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_check_mcp_json_status(
    _app: AppHandle,
    _state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    Ok(check_mcp_json_status_native(Path::new(&cwd)))
}

#[tauri::command]
pub async fn claude_enable_all_project_mcp(
    _app: AppHandle,
    _state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    enable_all_project_mcp_native(Path::new(&cwd))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_data_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_millis();
        env::temp_dir().join(format!(
            "bat-claude-command-{name}-{}-{stamp}",
            std::process::id()
        ))
    }

    #[test]
    fn claude_cli_resolves_bundled_sdk_binary_in_base() {
        let base = temp_data_dir("claude-cli-bundled");
        let bin = base
            .join("node-sidecar")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-agent-sdk-win32-x64")
            .join("claude.exe");
        fs::create_dir_all(bin.parent().unwrap()).unwrap();
        fs::write(&bin, b"fake").unwrap();

        assert_eq!(
            find_bundled_claude_cli_in_base(&base, "windows", "x86_64"),
            Some(bin)
        );

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn claude_cli_path_search_honors_windows_pathext() {
        let base = temp_data_dir("claude-cli-path");
        fs::create_dir_all(&base).unwrap();
        let bin = base.join("claude.CMD");
        fs::write(&bin, b"fake").unwrap();
        let path = std::env::join_paths([base.clone()]).unwrap();

        assert_eq!(
            find_claude_cli_on_path(path.to_str(), Some(".CMD"), "windows"),
            Some(bin)
        );

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn auth_status_parser_returns_null_on_invalid_json() {
        let parsed = parse_auth_status_stdout(r#"{"authenticated":true,"email":"u@example.com"}"#);
        assert_eq!(parsed["authenticated"], true);
        assert_eq!(parsed["email"], "u@example.com");

        assert_eq!(parse_auth_status_stdout("not json"), Value::Null);
    }

    #[test]
    fn account_info_from_auth_status_keeps_public_metadata() {
        let info = account_info_from_auth_status(&json!({
            "loggedIn": true,
            "email": "u@example.com",
            "subscriptionType": "pro",
            "token": "secret"
        }));
        assert_eq!(info["email"], "u@example.com");
        assert_eq!(info["subscriptionType"], "pro");
        assert!(info.get("token").is_none());

        assert_eq!(
            account_info_from_auth_status(&json!({ "loggedIn": false })),
            Value::Null
        );
    }

    #[test]
    fn scan_commands_dir_reads_markdown_commands() {
        let base = temp_data_dir("scan-commands");
        let dir = base.join(".claude").join("commands");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("deploy.md"), "# Deploy app\nRun deployment").unwrap();

        let entries = scan_commands_dir(&dir, "project");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "deploy");
        assert_eq!(entries[0].description, "Deploy app");
        assert_eq!(entries[0].scope, "project");

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn scan_skills_dir_reads_skill_frontmatter() {
        let base = temp_data_dir("scan-skills");
        let dir = base.join(".claude").join("skills").join("review");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: code-review\ndescription: Review changes\n---\n# Ignored heading",
        )
        .unwrap();

        let entries = scan_skills_dir(&base.join(".claude").join("skills"), "project");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "code-review");
        assert_eq!(entries[0].description, "Review changes");

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn scan_skills_native_project_commands_take_precedence() {
        let base = temp_data_dir("scan-native");
        let command_dir = base.join(".claude").join("commands");
        let skill_dir = base.join(".claude").join("skills").join("deploy");
        fs::create_dir_all(&command_dir).unwrap();
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(command_dir.join("deploy.md"), "# Command deploy").unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: deploy\n---\n# Skill deploy",
        )
        .unwrap();

        let entries = scan_skills_native(&base);
        let deploy = entries
            .iter()
            .find(|entry| entry.name == "deploy")
            .expect("deploy entry");
        assert_eq!(deploy.description, "Command deploy");
        assert_eq!(deploy.scope, "project");

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn mcp_status_detects_project_approval_sources() {
        let base = temp_data_dir("mcp-status");
        fs::create_dir_all(base.join(".claude")).unwrap();
        fs::write(
            base.join(".mcp.json"),
            r#"{"mcpServers":{"foo":{"command":"x"},"bar":{"command":"y"}}}"#,
        )
        .unwrap();

        let status = check_mcp_json_status_native(&base);
        assert_eq!(status["exists"], true);
        assert_eq!(status["approved"], false);
        assert_eq!(status["servers"].as_array().unwrap().len(), 2);

        fs::write(
            base.join(".claude").join("settings.local.json"),
            r#"{"enabledMcpjsonServers":["foo","bar"]}"#,
        )
        .unwrap();
        let approved = check_mcp_json_status_native(&base);
        assert_eq!(approved["approved"], true);

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn enable_all_project_mcp_preserves_existing_settings() {
        let base = temp_data_dir("mcp-enable");
        let settings_dir = base.join(".claude");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::write(settings_dir.join("settings.json"), r#"{"otherKey":"keep"}"#).unwrap();

        let first = enable_all_project_mcp_native(&base).expect("enable mcp");
        assert_eq!(first["ok"], true);
        assert_eq!(first["changed"], true);
        let written = read_json_safe(&settings_dir.join("settings.json")).unwrap();
        assert_eq!(written["otherKey"], "keep");
        assert_eq!(written["enableAllProjectMcpServers"], true);

        let second = enable_all_project_mcp_native(&base).expect("enable mcp again");
        assert_eq!(second["changed"], false);

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn list_claude_sessions_reads_project_jsonl_previews() {
        let base = temp_data_dir("claude-session-list");
        let projects_dir = base.join("projects");
        let cwd = "C:\\repo app";
        let session_dir = projects_dir.join(encode_claude_project_dir(cwd));
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(
            session_dir.join("sdk-1.jsonl"),
            r#"{"type":"system","message":{}}
{"type":"user","message":{"content":[{"type":"text","text":"hello from history"}]}}
"#,
        )
        .unwrap();

        let sessions = list_claude_sessions_in_projects(cwd, &projects_dir);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].sdk_session_id, "sdk-1");
        assert_eq!(sessions[0].preview, "hello from history");
        assert_eq!(sessions[0].message_count, 2);

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn list_codex_sessions_reads_nested_session_meta_and_preview() {
        let base = temp_data_dir("codex-session-list");
        let nested = base.join("2026").join("05").join("11");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            nested.join("rollout.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"thread-1"}}
{"type":"event_msg","payload":{"input":"ping\nsecond line"}}
"#,
        )
        .unwrap();

        let sessions = list_codex_sessions_in_root(&base);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].sdk_session_id, "thread-1");
        assert_eq!(sessions[0].preview, "ping");
        assert_eq!(sessions[0].message_count, 0);

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn claude_builtin_models_include_sources_and_current_defaults() {
        let models = claude_builtin_models_native();
        let values = models
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["value"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(values.contains(&"claude-opus-4-7:auto-compact-200k"));
        assert!(values.contains(&"claude-sonnet-4-6"));
        assert!(models
            .as_array()
            .unwrap()
            .iter()
            .all(|model| model["source"] == "builtin"));
    }

    #[test]
    fn notification_session_meta_matches_sidecar_shape_defaults() {
        let session = notification_cmd::AgentNotificationSession {
            window_id: Some("main".into()),
            profile_id: Some("default".into()),
            cwd: "C:/repo".into(),
            agent_kind: Some("claude".into()),
            model: Some("claude-opus-4-7:auto-compact-300k".into()),
            permission_mode: Some("bypassPermissions".into()),
            effort: Some("high".into()),
            auto_compact_window: Some(300_000),
            sdk_session_id: Some("sdk-1".into()),
            codex_sandbox_mode: None,
            codex_approval_policy: None,
            latest_meta: None,
        };

        let meta = session_meta_from_notification_snapshot(&session);
        assert_eq!(meta["permissionMode"], "bypassPermissions");
        assert_eq!(meta["model"], "claude-opus-4-7:auto-compact-300k");
        assert_eq!(meta["effort"], "high");
        assert_eq!(meta["autoCompactWindow"], 300_000);
        assert_eq!(meta["sdkSessionId"], "sdk-1");
        assert_eq!(meta["cwd"], "C:/repo");
        assert_eq!(meta["contextWindow"], 300_000);
        assert_eq!(meta["inputTokens"], 0);
        assert_eq!(meta["outputTokens"], 0);
        assert_eq!(meta["numTurns"], 0);
    }

    #[test]
    fn notification_session_meta_prefers_latest_status_meta() {
        let session = notification_cmd::AgentNotificationSession {
            window_id: Some("main".into()),
            profile_id: Some("default".into()),
            cwd: "C:/repo".into(),
            agent_kind: Some("claude".into()),
            model: Some("claude-sonnet-4-6".into()),
            permission_mode: Some("default".into()),
            effort: None,
            auto_compact_window: None,
            sdk_session_id: None,
            codex_sandbox_mode: None,
            codex_approval_policy: None,
            latest_meta: Some(json!({
                "model": "claude-sonnet-4-6",
                "sdkSessionId": "sdk-live",
                "inputTokens": 12,
                "outputTokens": 5,
                "numTurns": 1
            })),
        };

        let meta = session_meta_from_notification_snapshot(&session);
        assert_eq!(meta["sdkSessionId"], "sdk-live");
        assert_eq!(meta["inputTokens"], 12);
        assert_eq!(meta["numTurns"], 1);
    }

    #[test]
    fn supported_commands_native_reads_project_commands() {
        let base = temp_data_dir("supported-commands");
        let command_dir = base.join(".claude").join("commands");
        fs::create_dir_all(&command_dir).unwrap();
        fs::write(command_dir.join("deploy.md"), "# Deploy\nRun deploy").unwrap();

        let commands = supported_commands_native(&base);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "deploy");
        assert_eq!(commands[0].description, "Deploy");
        assert_eq!(commands[0].argument_hint, "");

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn supported_agents_native_reads_frontmatter() {
        let base = temp_data_dir("supported-agents");
        let agent_dir = base.join(".claude").join("agents");
        fs::create_dir_all(&agent_dir).unwrap();
        fs::write(
            agent_dir.join("reviewer.md"),
            "---\nname: reviewer\ndescription: Review code\nmodel: claude-sonnet-4-6\n---\n# Ignored",
        )
        .unwrap();

        let agents = supported_agents_native(&base);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].name, "reviewer");
        assert_eq!(agents[0].description, "Review code");
        assert_eq!(agents[0].model.as_deref(), Some("claude-sonnet-4-6"));

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn codex_worktree_rehydrate_params_require_existing_worktree_path() {
        assert!(codex_worktree_rehydrate_params(
            "s-1",
            &Some(json!({
                "agentPreset": "codex-agent-worktree",
                "cwd": "/repo",
                "useWorktree": true
            }))
        )
        .is_none());

        let params = codex_worktree_rehydrate_params(
            "s-1",
            &Some(json!({
                "agentPreset": "codex-agent-worktree",
                "cwd": "/repo",
                "useWorktree": true,
                "worktreePath": "/repo/.bat-worktrees/s-1",
                "worktreeBranch": "bat/worktree-s-1"
            })),
        )
        .expect("rehydrate params");

        assert_eq!(params["sessionId"], "s-1");
        assert_eq!(params["cwd"], "/repo");
        assert_eq!(params["worktreePath"], "/repo/.bat-worktrees/s-1");
        assert_eq!(params["branchName"], "bat/worktree-s-1");
    }

    #[test]
    fn archive_helpers_tail_page_and_clear_messages() {
        let data_dir = temp_data_dir("archive");
        let first_batch = json!([
            { "id": "m1", "content": "one" },
            { "id": "m2", "content": "two" },
            { "id": "m3", "content": "three" }
        ]);
        let second_batch = json!([{ "id": "m4", "content": "four" }]);

        assert_eq!(
            load_archived_from_dir(&data_dir, "session/with:unsafe", 0, 2),
            archive_empty_page()
        );
        assert_eq!(
            archive_messages_in_dir(&data_dir, "session/with:unsafe", &first_batch)
                .expect("archive first"),
            true
        );
        assert_eq!(
            archive_messages_in_dir(&data_dir, "session/with:unsafe", &second_batch)
                .expect("archive second"),
            true
        );

        let page = load_archived_from_dir(&data_dir, "session/with:unsafe", 0, 2);
        assert_eq!(page["total"], 4);
        assert_eq!(page["hasMore"], true);
        assert_eq!(page["messages"][0]["id"], "m3");
        assert_eq!(page["messages"][1]["id"], "m4");

        let previous_page = load_archived_from_dir(&data_dir, "session/with:unsafe", 2, 2);
        assert_eq!(previous_page["total"], 4);
        assert_eq!(previous_page["hasMore"], false);
        assert_eq!(previous_page["messages"][0]["id"], "m1");
        assert_eq!(previous_page["messages"][1]["id"], "m2");

        assert!(clear_archive_in_dir(&data_dir, "session/with:unsafe"));
        assert_eq!(
            load_archived_from_dir(&data_dir, "session/with:unsafe", 0, 2),
            archive_empty_page()
        );

        fs::remove_dir_all(data_dir).ok();
    }

    #[test]
    fn archive_helpers_reject_invalid_input_without_side_effects() {
        let data_dir = temp_data_dir("archive-invalid");

        assert_eq!(
            archive_messages_in_dir(&data_dir, "", &json!([])).expect("empty session"),
            false
        );
        assert_eq!(
            archive_messages_in_dir(&data_dir, "s-1", &json!({ "not": "an array" }))
                .expect("not array"),
            false
        );
        assert_eq!(clear_archive_in_dir(&data_dir, ""), false);

        fs::remove_dir_all(data_dir).ok();
    }
}
