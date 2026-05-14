// Persistent Codex app-server controller.
//
// This is intentionally a compatibility adapter, not a renderer contract
// change. Codex app-server speaks JSON-RPC over JSONL; this module maps its
// thread/turn/item notifications back into the existing claude:* event shape
// consumed by the renderer.

use crate::commands::{app as app_cmd, openai};
use crate::event_hub::publish_runtime_event;
use crate::sidecar::BridgeError;
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use crate::subprocess::hide_console_window;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const DEFAULT_CODEX_MODEL: &str = "gpt-5.5";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_START_TIMEOUT: Duration = Duration::from_secs(60);
const MSG_BUFFER_CAP: usize = 300;
const DEFAULT_CODEX_CONTEXT_WINDOW: u64 = 1_000_000;
const DEFAULT_CODEX_REASONING_SUMMARY: &str = "auto";
static CODEX_TEMP_IMAGE_COUNTER: AtomicU64 = AtomicU64::new(0);

type ReplySender = Sender<Result<Value, String>>;

#[derive(Default)]
struct PendingTable {
    inner: Mutex<HashMap<u64, ReplySender>>,
}

impl PendingTable {
    fn insert(&self, id: u64, tx: ReplySender) {
        self.inner
            .lock()
            .expect("codex pending lock")
            .insert(id, tx);
    }

    fn take(&self, id: u64) -> Option<ReplySender> {
        self.inner.lock().expect("codex pending lock").remove(&id)
    }

    fn drain_all(&self) -> Vec<ReplySender> {
        self.inner
            .lock()
            .expect("codex pending lock")
            .drain()
            .map(|(_, tx)| tx)
            .collect()
    }
}

struct CodexConnection {
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Arc<PendingTable>,
    child: Mutex<Child>,
}

impl CodexConnection {
    fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({ "method": method, "params": params });
        let mut stdin = self.stdin.lock().map_err(|_| "codex stdin lock poisoned")?;
        writeln!(stdin, "{message}").map_err(|err| err.to_string())?;
        stdin.flush().map_err(|err| err.to_string())
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.alloc_id();
        let message = json!({ "method": method, "id": id, "params": params });
        let (tx, rx) = channel();
        self.pending.insert(id, tx);
        {
            let mut stdin = self.stdin.lock().map_err(|_| "codex stdin lock poisoned")?;
            if let Err(err) = writeln!(stdin, "{message}") {
                let _ = self.pending.take(id);
                return Err(err.to_string());
            }
            if let Err(err) = stdin.flush() {
                let _ = self.pending.take(id);
                return Err(err.to_string());
            }
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                let _ = self.pending.take(id);
                Err(format!("codex app-server request timed out: {method}"))
            }
        }
    }
}

impl Drop for CodexConnection {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Default)]
struct CodexInner {
    connection: Mutex<Option<Arc<CodexConnection>>>,
    sessions: Mutex<HashMap<String, CodexSession>>,
    thread_to_session: Mutex<HashMap<String, String>>,
}

#[derive(Clone, Default)]
pub struct CodexAppServerState {
    inner: Arc<CodexInner>,
}

#[derive(Clone)]
struct CodexSession {
    session_id: String,
    thread_id: Option<String>,
    cwd: String,
    model: String,
    sandbox_mode: String,
    approval_policy: String,
    effort: String,
    start_time: Instant,
    active_turn_id: Option<String>,
    assistant_text: String,
    thinking_text: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    num_turns: u64,
    last_turn_started_at: Option<Instant>,
    last_turn_first_token_ms: Option<u64>,
    last_turn_duration_ms: Option<u64>,
    messages: Vec<Value>,
    temporary_image_paths: Vec<PathBuf>,
    command_outputs: HashMap<String, String>,
    runtime_status: Option<String>,
    runtime_message: Option<String>,
    runtime_status_started_at: Option<u128>,
    is_running: bool,
    is_resting: bool,
}

impl CodexSession {
    fn metadata(&self) -> Value {
        let context_tokens = self.input_tokens + self.output_tokens + self.cache_read_tokens;
        let context_window = codex_context_window_for_model(&self.model);
        json!({
            "model": self.model,
            "sdkSessionId": self.thread_id,
            "cwd": self.cwd,
            "totalCost": 0,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "durationMs": self.start_time.elapsed().as_millis() as u64,
            "numTurns": self.num_turns,
            "contextWindow": context_window,
            "maxOutputTokens": 0,
            "contextTokens": context_tokens,
            "cacheReadTokens": self.cache_read_tokens,
            "cacheCreationTokens": 0,
            "callCacheRead": 0,
            "callCacheWrite": 0,
            "lastQueryCalls": 1,
            "codexSandboxMode": self.sandbox_mode,
            "codexApprovalPolicy": self.approval_policy,
            "effort": self.effort,
            "lastTurnFirstTokenMs": self.last_turn_first_token_ms,
            "lastTurnDurationMs": self.last_turn_duration_ms,
            "runtimeStatus": self.runtime_status.as_deref(),
            "runtimeMessage": self.runtime_message.as_deref(),
            "runtimeStatusStartedAt": self.runtime_status_started_at,
        })
    }
}

fn set_runtime_status(session: &mut CodexSession, status: &str, message: &str) {
    session.runtime_status = Some(status.to_string());
    session.runtime_message = Some(message.to_string());
    session.runtime_status_started_at = Some(now_millis());
}

fn clear_runtime_status(session: &mut CodexSession) {
    session.runtime_status = None;
    session.runtime_message = None;
    session.runtime_status_started_at = None;
}

fn codex_context_window_for_model(model: &str) -> u64 {
    match model {
        "gpt-5.5"
        | "gpt-5.4"
        | "gpt-5.4-mini"
        | "gpt-5.3-codex"
        | "gpt-5.3-codex-spark"
        | "codex-mini-latest"
        | "o4-mini"
        | "o3"
        | "gpt-4.1" => DEFAULT_CODEX_CONTEXT_WINDOW,
        _ if model.starts_with("gpt-5.") => DEFAULT_CODEX_CONTEXT_WINDOW,
        _ => DEFAULT_CODEX_CONTEXT_WINDOW,
    }
}

fn bridge_error(message: impl Into<String>) -> BridgeError {
    BridgeError {
        message: message.into(),
    }
}

fn is_codex_agent_preset(options: &Value) -> bool {
    match options.get("agentPreset").and_then(Value::as_str) {
        Some("codex-agent") => true,
        Some("codex-agent-worktree") => true,
        _ => false,
    }
}

pub fn should_handle_codex(options: &Option<Value>) -> bool {
    options.as_ref().map(is_codex_agent_preset).unwrap_or(false)
}

fn effective_cwd(options: &Value, context: &str) -> Result<String, BridgeError> {
    if options
        .get("useWorktree")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        if let Some(path) = options
            .get("worktreePath")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
        {
            return Ok(path.to_string());
        }
    }
    let cwd = options
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| bridge_error(format!("codex app-server {context}: missing cwd")))?
        .to_string();
    Ok(cwd)
}

fn worktree_payload(options: &Value) -> Option<Value> {
    if !options
        .get("useWorktree")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let worktree_path = options
        .get("worktreePath")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())?;
    let branch_name = options
        .get("worktreeBranch")
        .and_then(Value::as_str)
        .filter(|branch| !branch.trim().is_empty())
        .unwrap_or("worktree");
    let git_root = Path::new(worktree_path)
        .parent()
        .and_then(Path::parent)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    Some(json!({
        "branchName": branch_name,
        "worktreePath": worktree_path,
        "sourceBranch": "",
        "gitRoot": git_root,
    }))
}

fn normalize_effort(value: Option<&str>) -> String {
    match value {
        Some("minimal" | "low" | "medium" | "high" | "xhigh") => value.unwrap().to_string(),
        _ => "high".to_string(),
    }
}

fn normalize_sandbox(value: Option<&str>) -> String {
    match value {
        Some("read-only") => "read-only".to_string(),
        Some("danger-full-access") => "danger-full-access".to_string(),
        _ => "workspace-write".to_string(),
    }
}

fn app_server_sandbox(value: &str) -> &'static str {
    match value {
        "read-only" => "read-only",
        "danger-full-access" => "danger-full-access",
        _ => "workspace-write",
    }
}

fn normalize_approval(value: Option<&str>) -> String {
    match value {
        Some("untrusted" | "on-request" | "never") => value.unwrap().to_string(),
        _ => "on-request".to_string(),
    }
}

enum CodexBinary {
    Native(PathBuf),
    Wrapper(String),
}

fn codex_exe_name() -> &'static str {
    if cfg!(windows) {
        "codex.exe"
    } else {
        "codex"
    }
}

fn codex_target_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc"),
        _ => None,
    }
}

fn codex_platform_package() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("codex-linux-x64"),
        ("linux", "aarch64") => Some("codex-linux-arm64"),
        ("macos", "x86_64") => Some("codex-darwin-x64"),
        ("macos", "aarch64") => Some("codex-darwin-arm64"),
        ("windows", "x86_64") => Some("codex-win32-x64"),
        ("windows", "aarch64") => Some("codex-win32-arm64"),
        _ => None,
    }
}

fn bundled_codex_candidate(base: &Path) -> Option<PathBuf> {
    let triple = codex_target_triple()?;
    let platform_pkg = codex_platform_package()?;
    let exe = codex_exe_name();
    let candidates = [
        base.join("codex-runtime").join(exe),
        base.join("node-sidecar")
            .join("node_modules")
            .join("@openai")
            .join(platform_pkg)
            .join("vendor")
            .join(triple)
            .join("codex")
            .join(exe),
        base.join("node-sidecar")
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("vendor")
            .join(triple)
            .join("codex")
            .join(exe),
        base.join("node_modules")
            .join("@openai")
            .join(platform_pkg)
            .join("vendor")
            .join(triple)
            .join("codex")
            .join(exe),
        base.join("node_modules")
            .join("@openai")
            .join("codex")
            .join("vendor")
            .join(triple)
            .join("codex")
            .join(exe),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

fn find_codex_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(codex_exe_name());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_codex_binary(app: &AppHandle) -> CodexBinary {
    if let Ok(override_path) = std::env::var("BAT_CODEX_BIN") {
        let path = PathBuf::from(&override_path);
        if path.is_file() {
            let ext = path
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext != "cmd" && ext != "bat" {
                return CodexBinary::Native(path);
            }
            return CodexBinary::Wrapper(override_path);
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(path) = bundled_codex_candidate(&resource_dir) {
            return CodexBinary::Native(path);
        }
    }

    if let Ok(mut cwd) = std::env::current_dir() {
        loop {
            if let Some(path) = bundled_codex_candidate(&cwd) {
                return CodexBinary::Native(path);
            }
            if !cwd.pop() {
                break;
            }
        }
    }

    if let Some(path) = find_codex_on_path() {
        return CodexBinary::Native(path);
    }

    CodexBinary::Wrapper("codex".to_string())
}

fn build_codex_command(app: &AppHandle) -> Command {
    let mut command = match resolve_codex_binary(app) {
        CodexBinary::Native(path) => {
            let mut command = Command::new(path);
            command.arg("app-server");
            command
        }
        CodexBinary::Wrapper(command_name) => {
            #[cfg(windows)]
            {
                let mut command = Command::new("cmd");
                command.arg("/C").arg(command_name).arg("app-server");
                command
            }
            #[cfg(not(windows))]
            {
                let mut command = Command::new(command_name);
                command.arg("app-server");
                command
            }
        }
    };
    if let Some(api_key) = openai::configured_openai_key_for_runtime(app) {
        command.env("OPENAI_API_KEY", api_key);
    }
    // The `codex` CLI is a Node script (`#!/usr/bin/env node`) and codex
    // itself shells out to `codex exec` subprocesses. When the .app is
    // launched from Finder/Spotlight, the inherited PATH does not include
    // common Node install locations like `/opt/homebrew/bin`, so `env` fails
    // with exit 127. Augment PATH with the resolved node directory plus
    // well-known fallbacks so both the immediate spawn and its descendants
    // can find `node`.
    if let Some(path) = augmented_path_with_node() {
        command.env("PATH", path);
    }
    // Avoid launching codex app-server with cwd `/` (the default when a macOS
    // .app is started from Finder). Per-turn requests still pass an explicit
    // cwd; this only guards against fallbacks that read the process cwd.
    if let Ok(home) = app.path().home_dir() {
        if home.is_dir() {
            command.current_dir(home);
        }
    }
    hide_console_window(&mut command);
    command
}

fn augmented_path_with_node() -> Option<std::ffi::OsString> {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Some(node) = find_node_on_path(&existing) {
        if let Some(parent) = node.parent() {
            dirs.push(parent.to_path_buf());
        }
    }

    #[cfg(target_os = "macos")]
    let fallbacks: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
    #[cfg(target_os = "linux")]
    let fallbacks: &[&str] = &["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
    #[cfg(windows)]
    let fallbacks: &[&str] = &[];

    for f in fallbacks {
        let p = PathBuf::from(f);
        if p.is_dir() && !dirs.iter().any(|d| d == &p) {
            dirs.push(p);
        }
    }

    if dirs.is_empty() {
        return None;
    }

    let mut combined: Vec<PathBuf> = dirs;
    for entry in std::env::split_paths(&existing) {
        if !combined.iter().any(|d| d == &entry) {
            combined.push(entry);
        }
    }
    std::env::join_paths(combined).ok()
}

fn find_node_on_path(path_env: &std::ffi::OsStr) -> Option<PathBuf> {
    let exe_names: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd", "node"]
    } else {
        &["node"]
    };
    for dir in std::env::split_paths(path_env) {
        for name in exe_names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    #[cfg(not(windows))]
    {
        for fallback in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            let p = PathBuf::from(fallback);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn text_from_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(text_from_value)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        Value::Object(map) => {
            for key in ["text", "message", "delta", "content", "summary"] {
                if let Some(v) = map.get(key) {
                    let text = text_from_value(v);
                    if !text.is_empty() {
                        return text;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn sanitize_terminal_output(value: &str) -> String {
    let mut stripped = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    let _ = chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    let _ = chars.next();
                    let mut saw_esc = false;
                    for c in chars.by_ref() {
                        if c == '\u{7}' {
                            break;
                        }
                        if saw_esc && c == '\\' {
                            break;
                        }
                        saw_esc = c == '\u{1b}';
                    }
                }
                Some(_) => {
                    let _ = chars.next();
                }
                None => {}
            }
            continue;
        }
        if ch == '\u{8}' {
            let _ = stripped.pop();
            continue;
        }
        stripped.push(ch);
    }
    stripped.replace("\r\n", "\n").replace('\r', "\n")
}

fn event_payload(session_id: &str, key: &str, value: Value) -> Value {
    json!({ "sessionId": session_id, key: value })
}

fn emit(app: &AppHandle, name: &str, session_id: &str, key: &str, value: Value) {
    publish_runtime_event(
        app,
        name,
        event_payload(session_id, key, value),
        "codex-app-server",
    );
}

fn short_session_id(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

fn codex_debug_enabled() -> bool {
    matches!(
        std::env::var("BAT_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn log_codex(app: &AppHandle, session_id: &str, message: impl AsRef<str>) {
    if !codex_debug_enabled() {
        return;
    }
    app_cmd::log_tauri(
        app,
        &format!(
            "[codex-app-server:{}] {}",
            short_session_id(session_id),
            message.as_ref()
        ),
    );
}

fn make_user_message(session_id: &str, prompt: &str, image_count: usize) -> Value {
    let suffix = if image_count > 0 {
        format!(
            "\n[{image_count} image{} attached]",
            if image_count > 1 { "s" } else { "" }
        )
    } else {
        String::new()
    };
    json!({
        "id": format!("user-{}", now_millis()),
        "sessionId": session_id,
        "role": "user",
        "content": format!("{prompt}{suffix}"),
        "timestamp": now_millis(),
    })
}

fn make_system_message(session_id: &str, content: String) -> Value {
    json!({
        "id": format!("sys-{}", now_millis()),
        "sessionId": session_id,
        "role": "system",
        "content": content,
        "timestamp": now_millis(),
    })
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn image_extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn data_url_to_temp_image(data_url: &str) -> Result<PathBuf, String> {
    let Some(rest) = data_url.strip_prefix("data:") else {
        return Err("invalid image data URL".to_string());
    };
    let Some((metadata, payload)) = rest.split_once(',') else {
        return Err("invalid image data URL".to_string());
    };
    let mut metadata_parts = metadata.split(';');
    let mime = metadata_parts.next().unwrap_or("");
    let is_base64 = metadata_parts.any(|part| part.eq_ignore_ascii_case("base64"));
    if !is_base64 {
        return Err("image data URL must be base64 encoded".to_string());
    }
    let ext = image_extension_for_mime(mime)
        .ok_or_else(|| format!("unsupported image MIME type: {mime}"))?;
    let cleaned_payload: String = payload
        .chars()
        .filter(|ch| *ch != '\r' && *ch != '\n')
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned_payload.as_bytes())
        .map_err(|err| format!("invalid image data URL: {err}"))?;
    let dir = std::env::temp_dir().join("bat-codex-images");
    fs::create_dir_all(&dir).map_err(|err| format!("create temp image dir failed: {err}"))?;
    let n = CODEX_TEMP_IMAGE_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let path = dir.join(format!(
        "img-{}-{}-{n}.{ext}",
        std::process::id(),
        now_millis()
    ));
    fs::write(&path, bytes).map_err(|err| format!("write temp image failed: {err}"))?;
    Ok(path)
}

fn is_absolute_local_path(value: &str) -> bool {
    Path::new(value).is_absolute()
        || value.starts_with("\\\\")
        || value.as_bytes().get(1).is_some_and(|b| *b == b':')
}

fn codex_image_input_item(
    image: &str,
    temp_image_paths: &mut Vec<PathBuf>,
) -> Result<Value, String> {
    let trimmed = image.trim();
    if trimmed.is_empty() {
        return Err("empty image attachment".to_string());
    }
    if trimmed.starts_with("data:") {
        let path = data_url_to_temp_image(trimmed)?;
        let item = json!({ "type": "localImage", "path": path.to_string_lossy().to_string() });
        temp_image_paths.push(path);
        return Ok(item);
    }
    if is_absolute_local_path(trimmed) {
        return Ok(json!({ "type": "localImage", "path": trimmed }));
    }
    Ok(json!({ "type": "image", "url": trimmed }))
}

fn cleanup_temp_images(paths: Vec<PathBuf>) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

fn cleanup_session_temp_images(session: &mut CodexSession) {
    cleanup_temp_images(std::mem::take(&mut session.temporary_image_paths));
}

fn build_turn_input(prompt: &str, images: Vec<String>) -> Result<(Value, Vec<PathBuf>), String> {
    let mut temp_image_paths = Vec::new();
    let mut items = Vec::with_capacity(images.len() + 1);
    for image in images {
        match codex_image_input_item(&image, &mut temp_image_paths) {
            Ok(item) => items.push(item),
            Err(err) => {
                cleanup_temp_images(temp_image_paths);
                return Err(err);
            }
        }
    }
    items.push(json!({ "type": "text", "text": prompt, "text_elements": [] }));
    Ok((Value::Array(items), temp_image_paths))
}

fn build_turn_start_params(thread_id: &str, input: Value, model: &str, effort: &str) -> Value {
    json!({
        "threadId": thread_id,
        "input": input,
        "model": model,
        "effort": effort,
        "summary": DEFAULT_CODEX_REASONING_SUMMARY,
        "reasoningEffort": effort,
    })
}

fn build_thread_resume_params(
    thread_id: &str,
    model: &str,
    cwd: &str,
    approval_policy: &str,
    sandbox_mode: &str,
) -> Value {
    json!({
        "threadId": thread_id,
        "model": model,
        "cwd": cwd,
        "approvalPolicy": approval_policy,
        "sandbox": app_server_sandbox(sandbox_mode),
        "serviceName": "better_agent_terminal",
    })
}

fn is_thread_not_found_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("thread not found") || (lower.contains("thread") && lower.contains("not found"))
}

fn reasoning_text_from_item(item: &Value) -> String {
    if item_type(item) != Some("reasoning") {
        return String::new();
    }
    let summary = item.get("summary").map(text_from_value).unwrap_or_default();
    if !summary.trim().is_empty() {
        return summary;
    }
    item.get("content").map(text_from_value).unwrap_or_default()
}

fn turn_error_message_from_value(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("additionalDetails")
                .and_then(Value::as_str)
                .filter(|message| !message.trim().is_empty())
                .map(str::to_string)
        })
}

fn codex_sessions_root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .home_dir()
        .ok()
        .map(|home| home.join(".codex").join("sessions"))
}

fn read_session_meta_id(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = entry
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| *value == "session_meta")
            .and_then(|_| entry.get("payload"))
            .and_then(|payload| payload.get("id"))
            .and_then(Value::as_str);
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            return Some(id.to_string());
        }
    }
    None
}

fn find_codex_session_log(root: &Path, thread_id: &str) -> Option<PathBuf> {
    let mut path_match = None;
    find_codex_session_log_exact(root, thread_id, &mut path_match).or(path_match)
}

fn find_codex_session_log_exact(
    root: &Path,
    thread_id: &str,
    path_match: &mut Option<PathBuf>,
) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_codex_session_log_exact(&path, thread_id, path_match) {
                return Some(found);
            }
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let meta_id = read_session_meta_id(&path);
        if meta_id.as_deref() == Some(thread_id) {
            return Some(path);
        }
        let path_text = path.to_string_lossy();
        if meta_id.is_none() && path_text.contains(thread_id) && path_match.is_none() {
            *path_match = Some(path);
        }
    }
    None
}

fn timestamp_or_now(_value: Option<&Value>) -> u128 {
    // Renderer only requires a stable numeric timestamp. Rust std has no
    // RFC3339 parser; keep the compatibility loader dependency-free and use
    // current time when replaying history from Codex JSONL.
    now_millis()
}

fn codex_history_items_from_content(session_id: &str, content: &str) -> Vec<Value> {
    let mut items = Vec::new();
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let Some(payload) = entry.get("payload") else {
            continue;
        };
        let timestamp = timestamp_or_now(entry.get("timestamp"));
        match payload.get("type").and_then(Value::as_str) {
            Some("user_message") => {
                if let Some(message) = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|message| !message.trim().is_empty())
                {
                    items.push(json!({
                        "id": format!("hist-user-{}", items.len()),
                        "sessionId": session_id,
                        "role": "user",
                        "content": message,
                        "timestamp": timestamp,
                    }));
                }
            }
            Some("agent_message") => {
                if let Some(message) = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|message| !message.trim().is_empty())
                {
                    items.push(json!({
                        "id": format!("hist-assistant-{}", items.len()),
                        "sessionId": session_id,
                        "role": "assistant",
                        "content": message,
                        "timestamp": timestamp,
                    }));
                }
            }
            _ => {}
        }
    }
    items
}

fn load_codex_history_items(app: &AppHandle, session_id: &str, thread_id: &str) -> Vec<Value> {
    let Some(root) = codex_sessions_root(app) else {
        return Vec::new();
    };
    let Some(path) = find_codex_session_log(&root, thread_id) else {
        return Vec::new();
    };
    fs::read_to_string(path)
        .map(|content| codex_history_items_from_content(session_id, &content))
        .unwrap_or_default()
}

fn item_type(item: &Value) -> Option<&str> {
    item.get("type").and_then(Value::as_str)
}

fn item_id(item: &Value) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .unwrap_or("codex-item")
        .to_string()
}

fn tool_status(item: &Value) -> &'static str {
    match item.get("status").and_then(Value::as_str) {
        Some("failed" | "declined") => "error",
        Some("completed") => "completed",
        _ => "running",
    }
}

fn thread_id_from_params(params: &Value) -> Option<String> {
    params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| params.get("thread_id").and_then(Value::as_str))
        .or_else(|| {
            params
                .get("turn")
                .and_then(|v| v.get("threadId").or_else(|| v.get("thread_id")))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            params
                .get("item")
                .and_then(|v| v.get("threadId").or_else(|| v.get("thread_id")))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

impl CodexAppServerState {
    pub fn is_owned(&self, session_id: &str) -> bool {
        self.inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .contains_key(session_id)
    }

    pub fn supported_models(&self) -> Value {
        json!([
            { "value": "gpt-5.5", "displayName": "GPT-5.5", "description": "Newest frontier - recommended (ChatGPT login)", "source": "builtin" },
            { "value": "gpt-5.4", "displayName": "GPT-5.4", "description": "Flagship GPT-5.4", "source": "builtin" },
            { "value": "gpt-5.4-mini", "displayName": "GPT-5.4 Mini", "description": "Fast GPT-5.4", "source": "builtin" },
            { "value": "gpt-5.3-codex", "displayName": "GPT-5.3 Codex", "description": "GPT-5.3 - codex variant", "source": "builtin" },
            { "value": "gpt-5.3-codex-spark", "displayName": "GPT-5.3 Codex Spark", "description": "GPT-5.3 - lightweight codex", "source": "builtin" },
            { "value": "codex-mini-latest", "displayName": "Codex Mini", "description": "codex-mini - optimized for code", "source": "builtin" },
            { "value": "o4-mini", "displayName": "o4-mini", "description": "OpenAI o4-mini - fast reasoning", "source": "builtin" },
            { "value": "o3", "displayName": "o3", "description": "OpenAI o3 - reasoning model", "source": "builtin" },
            { "value": "gpt-4.1", "displayName": "GPT-4.1", "description": "OpenAI GPT-4.1", "source": "builtin" },
        ])
    }

    fn session_id_for_notification(&self, params: &Value) -> Option<String> {
        if let Some(thread_id) = thread_id_from_params(params) {
            if let Some(session_id) = self
                .inner
                .thread_to_session
                .lock()
                .expect("codex thread map lock")
                .get(&thread_id)
                .cloned()
            {
                return Some(session_id);
            }
        }
        let sessions = self.inner.sessions.lock().expect("codex sessions lock");
        if sessions.len() == 1 {
            sessions.keys().next().cloned()
        } else {
            None
        }
    }

    fn ensure_connection(&self, app: &AppHandle) -> Result<Arc<CodexConnection>, String> {
        if let Some(existing) = self
            .inner
            .connection
            .lock()
            .map_err(|_| "codex connection lock poisoned")?
            .clone()
        {
            return Ok(existing);
        }

        let mut child = build_codex_command(app)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|err| format!("failed to start codex app-server: {err}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex app-server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex app-server stdout unavailable".to_string())?;
        let pending = Arc::new(PendingTable::default());
        let connection = Arc::new(CodexConnection {
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(0),
            pending: pending.clone(),
            child: Mutex::new(child),
        });

        let app_for_reader = app.clone();
        let state_for_reader = self.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        if let Ok(message) = serde_json::from_str::<Value>(&line) {
                            handle_server_message(
                                &app_for_reader,
                                &state_for_reader,
                                &pending,
                                message,
                            );
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            for tx in pending.drain_all() {
                let _ = tx.send(Err("codex app-server exited".to_string()));
            }
        });

        {
            let mut guard = self
                .inner
                .connection
                .lock()
                .map_err(|_| "codex connection lock poisoned")?;
            *guard = Some(connection.clone());
        }

        connection.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "better_agent_terminal",
                    "title": "Better Agent Terminal",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "experimentalApi": true }
            }),
            REQUEST_TIMEOUT,
        )?;
        connection.notify("initialized", json!({}))?;
        Ok(connection)
    }

    pub fn start_session(
        &self,
        app: &AppHandle,
        session_id: String,
        options: Option<Value>,
    ) -> Result<Value, BridgeError> {
        let options = options.unwrap_or(Value::Null);
        let cwd = effective_cwd(&options, "startSession")?;
        let model = options
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_CODEX_MODEL)
            .to_string();
        let sandbox_mode =
            normalize_sandbox(options.get("codexSandboxMode").and_then(Value::as_str));
        let approval_policy =
            normalize_approval(options.get("codexApprovalPolicy").and_then(Value::as_str));
        let effort = normalize_effort(options.get("effort").and_then(Value::as_str));
        let session = CodexSession {
            session_id: session_id.clone(),
            thread_id: None,
            cwd: cwd.clone(),
            model: model.clone(),
            sandbox_mode: sandbox_mode.clone(),
            approval_policy: approval_policy.clone(),
            effort,
            start_time: Instant::now(),
            active_turn_id: None,
            assistant_text: String::new(),
            thinking_text: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            num_turns: 0,
            last_turn_started_at: None,
            last_turn_first_token_ms: None,
            last_turn_duration_ms: None,
            messages: Vec::new(),
            temporary_image_paths: Vec::new(),
            command_outputs: HashMap::new(),
            runtime_status: None,
            runtime_message: None,
            runtime_status_started_at: None,
            is_running: false,
            is_resting: false,
        };
        self.inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .insert(session_id.clone(), session);

        let connection = self.ensure_connection(app).map_err(bridge_error)?;
        let response = connection
            .request(
                "thread/start",
                json!({
                    "model": model,
                    "cwd": cwd,
                    "approvalPolicy": approval_policy,
                    "sandbox": app_server_sandbox(&sandbox_mode),
                    "serviceName": "better_agent_terminal",
                }),
                REQUEST_TIMEOUT,
            )
            .map_err(|err| {
                self.inner
                    .sessions
                    .lock()
                    .expect("codex sessions lock")
                    .remove(&session_id);
                bridge_error(err)
            })?;
        let thread_id = response
            .get("thread")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .or_else(|| response.get("threadId").and_then(Value::as_str))
            .ok_or_else(|| bridge_error("codex app-server thread/start returned no thread id"))?
            .to_string();

        {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            if let Some(session) = sessions.get_mut(&session_id) {
                session.thread_id = Some(thread_id.clone());
                let msg = make_system_message(
                    &session_id,
                    format!(
                        "Codex session started (sandbox: {}, approval: {})",
                        session.sandbox_mode, session.approval_policy
                    ),
                );
                session.messages.push(msg.clone());
                emit(app, "claude:message", &session_id, "message", msg);
                emit(
                    app,
                    "claude:status",
                    &session_id,
                    "meta",
                    session.metadata(),
                );
                if let Some(payload) = worktree_payload(&options) {
                    emit(app, "claude:worktree-info", &session_id, "payload", payload);
                }
            }
        }
        self.inner
            .thread_to_session
            .lock()
            .expect("codex thread map lock")
            .insert(thread_id.clone(), session_id.clone());

        if let Some(prompt) = options.get("prompt").and_then(Value::as_str) {
            if !prompt.trim().is_empty() {
                self.send_message(app, session_id.clone(), prompt.to_string(), Vec::new())?;
            }
        }
        Ok(json!({ "ok": true, "sessionId": session_id, "sdkSessionId": thread_id }))
    }

    pub fn resume_session(
        &self,
        app: &AppHandle,
        session_id: String,
        sdk_session_id: String,
        options: Option<Value>,
    ) -> Result<Value, BridgeError> {
        let options = options.unwrap_or(Value::Null);
        let cwd = effective_cwd(&options, "resumeSession")?;
        let model = options
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_CODEX_MODEL)
            .to_string();
        let sandbox_mode =
            normalize_sandbox(options.get("codexSandboxMode").and_then(Value::as_str));
        let approval_policy =
            normalize_approval(options.get("codexApprovalPolicy").and_then(Value::as_str));
        let connection = self.ensure_connection(app).map_err(bridge_error)?;
        emit(
            app,
            "claude:resume-loading",
            &session_id,
            "payload",
            json!(true),
        );
        let response = connection.request(
            "thread/resume",
            json!({
                "threadId": sdk_session_id,
                "model": model,
                "cwd": cwd,
                "approvalPolicy": approval_policy,
                "sandbox": app_server_sandbox(&sandbox_mode),
                "serviceName": "better_agent_terminal",
            }),
            REQUEST_TIMEOUT,
        );
        if let Err(err) = response {
            emit(
                app,
                "claude:resume-loading",
                &session_id,
                "payload",
                json!(false),
            );
            return Err(bridge_error(err));
        }

        let session = CodexSession {
            session_id: session_id.clone(),
            thread_id: Some(sdk_session_id.clone()),
            cwd,
            model,
            sandbox_mode,
            approval_policy,
            effort: normalize_effort(options.get("effort").and_then(Value::as_str)),
            start_time: Instant::now(),
            active_turn_id: None,
            assistant_text: String::new(),
            thinking_text: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            num_turns: 0,
            last_turn_started_at: None,
            last_turn_first_token_ms: None,
            last_turn_duration_ms: None,
            messages: Vec::new(),
            temporary_image_paths: Vec::new(),
            command_outputs: HashMap::new(),
            runtime_status: None,
            runtime_message: None,
            runtime_status_started_at: None,
            is_running: false,
            is_resting: false,
        };
        self.inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .insert(session_id.clone(), session.clone());
        self.inner
            .thread_to_session
            .lock()
            .expect("codex thread map lock")
            .insert(sdk_session_id.clone(), session_id.clone());
        emit(
            app,
            "claude:status",
            &session_id,
            "meta",
            session.metadata(),
        );
        if let Some(payload) = worktree_payload(&options) {
            emit(app, "claude:worktree-info", &session_id, "payload", payload);
        }
        let history_items = load_codex_history_items(app, &session_id, &sdk_session_id);
        {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            if let Some(session) = sessions.get_mut(&session_id) {
                session.messages = history_items
                    .iter()
                    .rev()
                    .take(MSG_BUFFER_CAP)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
            }
        }
        emit(
            app,
            "claude:history",
            &session_id,
            "payload",
            json!(history_items),
        );
        emit(
            app,
            "claude:resume-loading",
            &session_id,
            "payload",
            json!(false),
        );
        Ok(json!({ "ok": true, "sessionId": session_id, "sdkSessionId": sdk_session_id }))
    }

    pub fn send_message(
        &self,
        app: &AppHandle,
        session_id: String,
        prompt: String,
        images: Vec<String>,
    ) -> Result<Value, BridgeError> {
        let image_count = images.len();
        let prompt = if prompt.trim().is_empty() && !images.is_empty() {
            "Please analyze the attached image.".to_string()
        } else {
            prompt.trim().to_string()
        };
        log_codex(
            app,
            &session_id,
            format!(
                "send_message requested promptLen={} images={}",
                prompt.len(),
                image_count
            ),
        );
        if prompt.is_empty() {
            log_codex(app, &session_id, "send_message rejected: empty prompt");
            return Ok(json!({ "ok": false, "error": "empty prompt" }));
        }
        let (input, mut temp_image_paths) = match build_turn_input(&prompt, images) {
            Ok(input) => input,
            Err(err) => {
                log_codex(
                    app,
                    &session_id,
                    format!("send_message build_turn_input failed: {err}"),
                );
                self.fail_turn(app, &session_id, err.clone());
                return Ok(json!({ "ok": false, "error": err }));
            }
        };
        let (thread_id, model, effort, cwd, approval_policy, sandbox_mode) = {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let Some(session) = sessions.get_mut(&session_id) else {
                cleanup_temp_images(temp_image_paths);
                log_codex(
                    app,
                    &session_id,
                    "send_message rejected: session not started",
                );
                return Err(bridge_error("Codex session not started"));
            };
            log_codex(
                app,
                &session_id,
                format!(
                    "send_message session state is_running={} activeTurn={} thread={}",
                    session.is_running,
                    session.active_turn_id.as_deref().unwrap_or("none"),
                    session.thread_id.as_deref().unwrap_or("none")
                ),
            );
            cleanup_session_temp_images(session);
            session.temporary_image_paths.append(&mut temp_image_paths);
            session.is_running = true;
            session.is_resting = false;
            session.num_turns += 1;
            session.last_turn_started_at = Some(Instant::now());
            session.last_turn_first_token_ms = None;
            session.last_turn_duration_ms = None;
            session.assistant_text.clear();
            session.thinking_text.clear();
            session.command_outputs.clear();
            set_runtime_status(
                session,
                "waiting_for_api",
                "Still waiting for Codex API response.",
            );
            let msg = make_user_message(&session_id, &prompt, image_count);
            session.messages.push(msg.clone());
            emit(app, "claude:message", &session_id, "message", msg);
            emit(
                app,
                "claude:status",
                &session_id,
                "meta",
                session.metadata(),
            );
            (
                session
                    .thread_id
                    .clone()
                    .ok_or_else(|| bridge_error("Codex thread not started"))?,
                session.model.clone(),
                session.effort.clone(),
                session.cwd.clone(),
                session.approval_policy.clone(),
                session.sandbox_mode.clone(),
            )
        };
        let connection = self.ensure_connection(app).map_err(bridge_error)?;
        log_codex(
            app,
            &session_id,
            format!(
                "turn/start request thread={} model={} effort={}",
                thread_id, model, effort
            ),
        );
        let response = match connection.request(
            "turn/start",
            build_turn_start_params(&thread_id, input.clone(), &model, &effort),
            TURN_START_TIMEOUT,
        ) {
            Ok(response) => response,
            Err(err) => {
                log_codex(app, &session_id, format!("turn/start failed: {err}"));
                if is_thread_not_found_error(&err) {
                    log_codex(
                        app,
                        &session_id,
                        format!("thread not found; attempting thread/resume thread={thread_id}"),
                    );
                    {
                        let mut sessions =
                            self.inner.sessions.lock().expect("codex sessions lock");
                        if let Some(session) = sessions.get_mut(&session_id) {
                            set_runtime_status(
                                session,
                                "starting",
                                "Resuming Codex thread before retrying the API request.",
                            );
                            emit(
                                app,
                                "claude:status",
                                &session_id,
                                "meta",
                                session.metadata(),
                            );
                        }
                    }
                    match connection.request(
                        "thread/resume",
                        build_thread_resume_params(
                            &thread_id,
                            &model,
                            &cwd,
                            &approval_policy,
                            &sandbox_mode,
                        ),
                        REQUEST_TIMEOUT,
                    ) {
                        Ok(_) => {
                            log_codex(
                                app,
                                &session_id,
                                format!("thread/resume ok; retrying turn/start thread={thread_id}"),
                            );
                            self.inner
                                .thread_to_session
                                .lock()
                                .expect("codex thread map lock")
                                .insert(thread_id.clone(), session_id.clone());
                            match connection.request(
                                "turn/start",
                                build_turn_start_params(&thread_id, input, &model, &effort),
                                TURN_START_TIMEOUT,
                            ) {
                                Ok(response) => response,
                                Err(retry_err) => {
                                    log_codex(
                                        app,
                                        &session_id,
                                        format!("turn/start retry failed after thread/resume: {retry_err}"),
                                    );
                                    self.fail_turn(
                                        app,
                                        &session_id,
                                        format!("Codex error after thread resume: {retry_err}"),
                                    );
                                    return Ok(json!({ "ok": false, "error": retry_err }));
                                }
                            }
                        }
                        Err(resume_err) => {
                            log_codex(
                                app,
                                &session_id,
                                format!("thread/resume failed: {resume_err}"),
                            );
                            let message = format!(
                                "Codex error: thread not found: {thread_id}; resume failed: {resume_err}"
                            );
                            self.fail_turn(app, &session_id, message.clone());
                            return Ok(json!({ "ok": false, "error": message }));
                        }
                    }
                } else {
                    self.fail_turn(app, &session_id, format!("Codex error: {err}"));
                    return Ok(json!({ "ok": false, "error": err }));
                }
            }
        };
        if let Some(turn_id) = response
            .get("turn")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
        {
            if let Some(session) = self
                .inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .get_mut(&session_id)
            {
                session.active_turn_id = Some(turn_id.to_string());
            }
            log_codex(
                app,
                &session_id,
                format!("turn/start ok activeTurn={turn_id}"),
            );
        } else {
            log_codex(
                app,
                &session_id,
                "turn/start ok without turn id in response",
            );
        }
        Ok(json!({ "ok": true }))
    }

    fn fail_turn(&self, app: &AppHandle, session_id: &str, message: String) {
        log_codex(app, session_id, format!("fail_turn: {message}"));
        let meta = {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            sessions.get_mut(session_id).map(|session| {
                session.is_running = false;
                session.active_turn_id = None;
                clear_runtime_status(session);
                if let Some(started_at) = session.last_turn_started_at {
                    session.last_turn_duration_ms = Some(started_at.elapsed().as_millis() as u64);
                }
                cleanup_session_temp_images(session);
                session.command_outputs.clear();
                session.metadata()
            })
        };
        if let Some(meta) = meta {
            emit(app, "claude:status", session_id, "meta", meta);
        }
        emit(app, "claude:error", session_id, "error", json!(message));
        emit(
            app,
            "claude:turn-end",
            session_id,
            "payload",
            json!({ "reason": "error", "error": message }),
        );
    }

    pub fn abort_session(&self, app: &AppHandle, session_id: String) -> Result<Value, BridgeError> {
        log_codex(app, &session_id, "abort_session requested");
        let (thread_id, turn_id) = {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let Some(session) = sessions.get_mut(&session_id) else {
                log_codex(app, &session_id, "abort_session ignored: session not found");
                return Ok(json!({ "ok": true }));
            };
            log_codex(
                app,
                &session_id,
                format!(
                    "abort_session state is_running={} activeTurn={} thread={}",
                    session.is_running,
                    session.active_turn_id.as_deref().unwrap_or("none"),
                    session.thread_id.as_deref().unwrap_or("none")
                ),
            );
            let thread_id = session.thread_id.clone();
            let turn_id = session.active_turn_id.clone();
            session.is_running = false;
            session.active_turn_id = None;
            cleanup_session_temp_images(session);
            session.command_outputs.clear();
            (thread_id, turn_id)
        };
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            let connection = self.ensure_connection(app).map_err(bridge_error)?;
            match connection.request(
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
                REQUEST_TIMEOUT,
            ) {
                Ok(_) => log_codex(app, &session_id, "turn/interrupt ok"),
                Err(err) => log_codex(app, &session_id, format!("turn/interrupt failed: {err}")),
            }
        } else {
            log_codex(
                app,
                &session_id,
                "abort_session has no active turn to interrupt",
            );
        }
        emit(
            app,
            "claude:turn-end",
            &session_id,
            "payload",
            json!({ "reason": "aborted" }),
        );
        Ok(json!({ "ok": true }))
    }

    pub fn stop_session(&self, session_id: String) -> Value {
        let removed = self
            .inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .remove(&session_id);
        if let Some(mut session) = removed {
            cleanup_session_temp_images(&mut session);
            if let Some(thread_id) = session.thread_id {
                self.inner
                    .thread_to_session
                    .lock()
                    .expect("codex thread map lock")
                    .remove(&thread_id);
            }
            json!({ "ok": true, "existed": true })
        } else {
            json!({ "ok": true, "existed": false })
        }
    }

    pub fn reset_session(&self, app: &AppHandle, session_id: String) -> Result<Value, BridgeError> {
        let (model, cwd, approval_policy, sandbox_mode, thread_id) = {
            let sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let session = sessions
                .get(&session_id)
                .ok_or_else(|| bridge_error("Codex session not started"))?;
            (
                session.model.clone(),
                session.cwd.clone(),
                session.approval_policy.clone(),
                session.sandbox_mode.clone(),
                session.thread_id.clone(),
            )
        };
        if let Some(thread_id) = thread_id {
            self.inner
                .thread_to_session
                .lock()
                .expect("codex thread map lock")
                .remove(&thread_id);
        }
        let connection = self.ensure_connection(app).map_err(bridge_error)?;
        let response = connection
            .request(
                "thread/start",
                json!({
                    "model": model,
                    "cwd": cwd,
                    "approvalPolicy": approval_policy,
                    "sandbox": app_server_sandbox(&sandbox_mode),
                    "serviceName": "better_agent_terminal",
                }),
                REQUEST_TIMEOUT,
            )
            .map_err(bridge_error)?;
        let new_thread_id = response
            .get("thread")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .or_else(|| response.get("threadId").and_then(Value::as_str))
            .ok_or_else(|| bridge_error("codex app-server reset returned no thread id"))?
            .to_string();
        let meta = {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let session = sessions
                .get_mut(&session_id)
                .ok_or_else(|| bridge_error("Codex session not started"))?;
            session.thread_id = Some(new_thread_id.clone());
            session.active_turn_id = None;
            session.assistant_text.clear();
            session.thinking_text.clear();
            session.input_tokens = 0;
            session.output_tokens = 0;
            session.cache_read_tokens = 0;
            session.num_turns = 0;
            session.last_turn_started_at = None;
            session.last_turn_first_token_ms = None;
            session.last_turn_duration_ms = None;
            session.messages.clear();
            cleanup_session_temp_images(session);
            session.command_outputs.clear();
            session.is_running = false;
            session.is_resting = false;
            session.start_time = Instant::now();
            session.metadata()
        };
        self.inner
            .thread_to_session
            .lock()
            .expect("codex thread map lock")
            .insert(new_thread_id, session_id.clone());
        emit(
            app,
            "claude:session-reset",
            &session_id,
            "__none__",
            Value::Null,
        );
        emit(app, "claude:status", &session_id, "meta", meta);
        Ok(json!(true))
    }

    pub fn rest_session(&self, app: &AppHandle, session_id: &str) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        session.is_resting = true;
        session.is_running = false;
        session.active_turn_id = None;
        let msg = make_system_message(
            session_id,
            "Session is resting. Send a message to wake it up.".to_string(),
        );
        session.messages.push(msg.clone());
        drop(sessions);
        emit(app, "claude:message", session_id, "message", msg);
        emit(
            app,
            "claude:turn-end",
            session_id,
            "payload",
            json!({ "reason": "resting" }),
        );
        Some(json!(true))
    }

    pub fn wake_session(&self, session_id: &str) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        session.is_resting = false;
        Some(json!(true))
    }

    pub fn is_resting(&self, session_id: &str) -> Option<Value> {
        let sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get(session_id)?;
        Some(json!(session.is_resting))
    }

    pub fn get_session_state(&self, session_id: &str) -> Option<Value> {
        self.inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .get(session_id)
            .map(|session| {
                json!({
                    "sessionId": session.session_id,
                    "messages": session.messages,
                    "isStreaming": session.is_running,
                    "streamingText": session.assistant_text,
                    "streamingThinking": session.thinking_text,
                })
            })
    }

    pub fn get_session_meta(&self, session_id: &str) -> Option<Value> {
        self.inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .get(session_id)
            .map(CodexSession::metadata)
    }

    pub fn get_context_usage(&self, session_id: &str) -> Option<Value> {
        let sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get(session_id)?;
        let total_tokens = session.input_tokens + session.output_tokens + session.cache_read_tokens;
        if total_tokens == 0 {
            return None;
        }
        let max_tokens = codex_context_window_for_model(&session.model);
        let percentage = if max_tokens > 0 {
            ((total_tokens as f64 / max_tokens as f64) * 100.0).round() as u64
        } else {
            0
        };
        Some(json!({
            "categories": [{ "name": "Context", "tokens": total_tokens, "color": "#10B981" }],
            "totalTokens": total_tokens,
            "maxTokens": max_tokens,
            "percentage": percentage,
            "model": session.model,
            "apiUsage": {
                "input_tokens": session.input_tokens,
                "output_tokens": session.output_tokens,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": session.cache_read_tokens,
            },
        }))
    }

    pub fn set_model(&self, app: &AppHandle, session_id: &str, model: String) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        if session.model == model {
            return Some(json!(true));
        }
        session.model = model;
        let meta = session.metadata();
        let msg = make_system_message(
            session_id,
            format!("Codex model updated to {}.", session.model),
        );
        session.messages.push(msg.clone());
        emit(app, "claude:message", session_id, "message", msg);
        emit(app, "claude:status", session_id, "meta", meta.clone());
        Some(json!(true))
    }

    pub fn set_effort(&self, app: &AppHandle, session_id: &str, effort: String) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        let next = normalize_effort(Some(&effort));
        if session.effort == next {
            return Some(json!(true));
        }
        session.effort = next;
        let meta = session.metadata();
        let msg = make_system_message(
            session_id,
            format!("Codex reasoning effort updated to {}.", session.effort),
        );
        session.messages.push(msg.clone());
        emit(app, "claude:message", session_id, "message", msg);
        emit(app, "claude:status", session_id, "meta", meta);
        Some(json!(true))
    }

    pub fn set_sandbox_mode(
        &self,
        app: &AppHandle,
        session_id: &str,
        mode: String,
    ) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        let next = normalize_sandbox(Some(&mode));
        if session.sandbox_mode == next {
            return Some(json!(true));
        }
        session.sandbox_mode = next;
        let msg = make_system_message(
            session_id,
            format!("Codex sandbox updated to {}.", session.sandbox_mode),
        );
        session.messages.push(msg.clone());
        emit(app, "claude:message", session_id, "message", msg);
        Some(json!(true))
    }

    pub fn set_approval_policy(
        &self,
        app: &AppHandle,
        session_id: &str,
        policy: String,
    ) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        let next = normalize_approval(Some(&policy));
        if session.approval_policy == next {
            return Some(json!(true));
        }
        session.approval_policy = next;
        let msg = make_system_message(
            session_id,
            format!("Codex approval updated to {}.", session.approval_policy),
        );
        session.messages.push(msg.clone());
        emit(app, "claude:message", session_id, "message", msg);
        Some(json!(true))
    }

    pub fn reconfigure_session(
        &self,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<Value, BridgeError> {
        let (thread_id, model, cwd, approval_policy, sandbox_mode, meta) = {
            let sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let session = sessions
                .get(session_id)
                .ok_or_else(|| bridge_error("Codex session not started"))?;
            let thread_id = session
                .thread_id
                .clone()
                .ok_or_else(|| bridge_error("Codex thread not started"))?;
            (
                thread_id,
                session.model.clone(),
                session.cwd.clone(),
                session.approval_policy.clone(),
                session.sandbox_mode.clone(),
                session.metadata(),
            )
        };
        let connection = self.ensure_connection(app).map_err(bridge_error)?;
        connection
            .request(
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "model": model,
                    "cwd": cwd,
                    "approvalPolicy": approval_policy,
                    "sandbox": app_server_sandbox(&sandbox_mode),
                    "serviceName": "better_agent_terminal",
                }),
                REQUEST_TIMEOUT,
            )
            .map_err(bridge_error)?;
        emit(app, "claude:status", session_id, "meta", meta);
        Ok(json!(true))
    }
}

fn handle_server_message(
    app: &AppHandle,
    state: &CodexAppServerState,
    pending: &Arc<PendingTable>,
    message: Value,
) {
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        if let Some(tx) = pending.take(id) {
            let result = if let Some(error) = message.get("error") {
                if codex_debug_enabled() {
                    app_cmd::log_tauri(
                        app,
                        &format!(
                            "[codex-app-server] response id={id} error={}",
                            error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("codex app-server error")
                        ),
                    );
                }
                Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("codex app-server error")
                    .to_string())
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = tx.send(result);
            return;
        }
    }

    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    handle_notification(app, state, method, params);
}

fn handle_notification(app: &AppHandle, state: &CodexAppServerState, method: &str, params: Value) {
    let Some(session_id) = state.session_id_for_notification(&params) else {
        if codex_debug_enabled() {
            app_cmd::log_tauri(
                app,
                &format!("[codex-app-server] notification {method} skipped: no session mapping"),
            );
        }
        return;
    };
    match method {
        "thread/started" => {
            log_codex(app, &session_id, "notification thread/started");
            if let Some(thread_id) = thread_id_from_params(&params).or_else(|| {
                params
                    .get("thread")
                    .and_then(|v| v.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }) {
                state
                    .inner
                    .thread_to_session
                    .lock()
                    .expect("codex thread map lock")
                    .insert(thread_id.clone(), session_id.clone());
                if let Some(session) = state
                    .inner
                    .sessions
                    .lock()
                    .expect("codex sessions lock")
                    .get_mut(&session_id)
                {
                    session.thread_id = Some(thread_id);
                    emit(
                        app,
                        "claude:status",
                        &session_id,
                        "meta",
                        session.metadata(),
                    );
                }
            }
        }
        "turn/started" => {
            log_codex(
                app,
                &session_id,
                format!(
                    "notification turn/started turn={}",
                    params
                        .get("turn")
                        .and_then(|v| v.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("none")
                ),
            );
            let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
            if let Some(session) = sessions.get_mut(&session_id) {
                session.is_running = true;
                if session.last_turn_started_at.is_none() {
                    session.num_turns += 1;
                    session.last_turn_started_at = Some(Instant::now());
                    session.last_turn_first_token_ms = None;
                    session.last_turn_duration_ms = None;
                }
                session.active_turn_id = params
                    .get("turn")
                    .and_then(|v| v.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
        "error" => {
            log_codex(
                app,
                &session_id,
                format!("notification error params={params}"),
            );
            handle_error_notification(app, state, &session_id, &params)
        }
        "turn/completed" => {
            log_codex(
                app,
                &session_id,
                format!(
                    "notification turn/completed status={}",
                    params
                        .get("turn")
                        .and_then(|v| v.get("status"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                ),
            );
            handle_turn_completed(app, state, &session_id, &params)
        }
        "rawResponseItem/completed" => {
            if let Some(item) = params.get("item") {
                append_completed_reasoning_if_missing(app, state, &session_id, item);
            }
        }
        "thread/tokenUsage/updated" => handle_usage_updated(app, state, &session_id, &params),
        "item/started" => {
            if let Some(item) = params.get("item") {
                handle_item_started(app, state, &session_id, item);
            }
        }
        "item/completed" => {
            if let Some(item) = params.get("item") {
                handle_item_completed(app, state, &session_id, item);
            }
        }
        "item/agentMessage/delta" => {
            let delta = text_from_value(&params);
            if !delta.is_empty() {
                append_stream_delta(app, state, &session_id, "text", delta);
            }
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            let delta = text_from_value(&params);
            if !delta.is_empty() {
                append_stream_delta(app, state, &session_id, "thinking", delta);
            }
        }
        "item/commandExecution/outputDelta" => {
            handle_command_execution_output_delta(app, state, &session_id, &params);
        }
        _ => {}
    }
}

fn handle_error_notification(
    app: &AppHandle,
    state: &CodexAppServerState,
    session_id: &str,
    params: &Value,
) {
    let message = params
        .get("error")
        .and_then(turn_error_message_from_value)
        .unwrap_or_else(|| "Codex turn failed.".to_string());
    state.fail_turn(app, session_id, message);
}

fn append_stream_delta(
    app: &AppHandle,
    state: &CodexAppServerState,
    session_id: &str,
    key: &str,
    delta: String,
) {
    {
        let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
        if let Some(session) = sessions.get_mut(session_id) {
            if session.last_turn_first_token_ms.is_none() {
                if let Some(started_at) = session.last_turn_started_at {
                    session.last_turn_first_token_ms =
                        Some(started_at.elapsed().as_millis() as u64);
                }
            }
            if key == "text" {
                session.assistant_text.push_str(&delta);
            } else {
                session.thinking_text.push_str(&delta);
            }
            clear_runtime_status(session);
        }
    }
    emit(
        app,
        "claude:stream",
        session_id,
        "data",
        json!({ key: delta }),
    );
}

fn append_completed_reasoning_if_missing(
    app: &AppHandle,
    state: &CodexAppServerState,
    session_id: &str,
    item: &Value,
) {
    let delta = reasoning_text_from_item(item);
    if delta.trim().is_empty() {
        return;
    }
    let should_emit = {
        let sessions = state.inner.sessions.lock().expect("codex sessions lock");
        sessions
            .get(session_id)
            .map(|session| session.thinking_text.trim().is_empty())
            .unwrap_or(false)
    };
    if should_emit {
        append_stream_delta(app, state, session_id, "thinking", delta);
    }
}

fn handle_command_execution_output_delta(
    app: &AppHandle,
    state: &CodexAppServerState,
    session_id: &str,
    params: &Value,
) {
    let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
        return;
    };
    let delta = params
        .get("delta")
        .and_then(Value::as_str)
        .map(sanitize_terminal_output)
        .unwrap_or_default();
    if delta.is_empty() {
        return;
    }
    let result = {
        let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };
        let output = session
            .command_outputs
            .entry(item_id.to_string())
            .or_default();
        output.push_str(&delta);
        output.clone()
    };
    emit(
        app,
        "claude:tool-result",
        session_id,
        "result",
        json!({
            "id": item_id,
            "status": "running",
            "result": result,
        }),
    );
}

fn completed_command_execution_result(
    state: &CodexAppServerState,
    session_id: &str,
    item: &Value,
) -> Option<String> {
    let item_id = item_id(item);
    let raw = item
        .get("aggregatedOutput")
        .or_else(|| item.get("result"))
        .or_else(|| item.get("error"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let accumulated = {
        let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
        sessions
            .get_mut(session_id)
            .and_then(|session| session.command_outputs.remove(&item_id))
    };
    raw.or(accumulated)
        .map(|value| sanitize_terminal_output(&value))
}

fn handle_item_started(
    app: &AppHandle,
    state: &CodexAppServerState,
    session_id: &str,
    item: &Value,
) {
    match item_type(item) {
        Some("agentMessage") => {
            if let Some(session) = state
                .inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .get_mut(session_id)
            {
                session.assistant_text.clear();
            }
        }
        Some("commandExecution") => {
            let id = item_id(item);
            {
                let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
                if let Some(session) = sessions.get_mut(session_id) {
                    session.command_outputs.entry(id.clone()).or_default();
                }
            }
            emit(
                app,
                "claude:tool-use",
                session_id,
                "toolCall",
                json!({
                    "id": id,
                    "sessionId": session_id,
                    "toolName": "Bash",
                    "input": { "command": item.get("command").and_then(Value::as_str).unwrap_or("") },
                    "status": tool_status(item),
                    "timestamp": now_millis(),
                }),
            );
        }
        Some("fileChange") => {
            let path = item
                .get("changes")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|v| v.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            emit(
                app,
                "claude:tool-use",
                session_id,
                "toolCall",
                json!({
                    "id": item_id(item),
                    "sessionId": session_id,
                    "toolName": "Edit",
                    "input": { "file_path": path },
                    "status": tool_status(item),
                    "timestamp": now_millis(),
                }),
            );
        }
        Some("mcpToolCall") => {
            let name = match (
                item.get("server").and_then(Value::as_str),
                item.get("tool").and_then(Value::as_str),
            ) {
                (Some(server), Some(tool)) => format!("{server}/{tool}"),
                (_, Some(tool)) => tool.to_string(),
                _ => "MCP".to_string(),
            };
            emit(
                app,
                "claude:tool-use",
                session_id,
                "toolCall",
                json!({
                    "id": item_id(item),
                    "sessionId": session_id,
                    "toolName": name,
                    "input": item.get("arguments").cloned().unwrap_or_else(|| json!({})),
                    "status": tool_status(item),
                    "timestamp": now_millis(),
                }),
            );
        }
        Some("webSearch") => {
            emit(
                app,
                "claude:tool-use",
                session_id,
                "toolCall",
                json!({
                    "id": item_id(item),
                    "sessionId": session_id,
                    "toolName": "WebSearch",
                    "input": { "query": item.get("query").and_then(Value::as_str).unwrap_or("") },
                    "status": "running",
                    "timestamp": now_millis(),
                }),
            );
        }
        _ => {}
    }
}

fn handle_item_completed(
    app: &AppHandle,
    state: &CodexAppServerState,
    session_id: &str,
    item: &Value,
) {
    if item_type(item) == Some("reasoning") {
        append_completed_reasoning_if_missing(app, state, session_id, item);
        return;
    }

    if item_type(item) == Some("agentMessage") {
        let text = text_from_value(item);
        let (content, thinking) = {
            let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
            let Some(session) = sessions.get_mut(session_id) else {
                return;
            };
            let content = if text.trim().is_empty() {
                session.assistant_text.clone()
            } else {
                text
            };
            let thinking = session.thinking_text.clone();
            if !content.trim().is_empty() {
                let mut msg = json!({
                    "id": format!("assistant-{}", now_millis()),
                    "sessionId": session_id,
                    "role": "assistant",
                    "content": content,
                    "timestamp": now_millis(),
                });
                if !thinking.is_empty() {
                    msg["thinking"] = json!(thinking);
                }
                session.messages.push(msg.clone());
                (Some(msg), None)
            } else {
                (None, Some(()))
            }
        };
        if let Some(msg) = content {
            emit(app, "claude:message", session_id, "message", msg);
        }
        let _ = thinking;
        return;
    }

    match item_type(item) {
        Some("commandExecution") => {
            emit(
                app,
                "claude:tool-result",
                session_id,
                "result",
                json!({
                    "id": item_id(item),
                    "status": tool_status(item),
                    "result": completed_command_execution_result(state, session_id, item),
                }),
            );
        }
        Some("fileChange" | "mcpToolCall" | "webSearch") => {
            emit(
                app,
                "claude:tool-result",
                session_id,
                "result",
                json!({
                    "id": item_id(item),
                    "status": tool_status(item),
                    "result": item.get("aggregatedOutput")
                        .or_else(|| item.get("result"))
                        .or_else(|| item.get("error"))
                        .cloned(),
                }),
            );
        }
        _ => {}
    }
}

fn handle_usage_updated(
    app: &AppHandle,
    state: &CodexAppServerState,
    session_id: &str,
    params: &Value,
) {
    let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
    let Some(session) = sessions.get_mut(session_id) else {
        return;
    };
    let usage = params.get("usage").unwrap_or(params);
    if let Some(v) = read_usage_u64(usage, &["inputTokens", "input_tokens", "input"]) {
        session.input_tokens = v;
    }
    if let Some(v) = read_usage_u64(usage, &["outputTokens", "output_tokens", "output"]) {
        session.output_tokens = v;
    }
    if let Some(v) = read_usage_u64(
        usage,
        &[
            "cacheReadTokens",
            "cached_input_tokens",
            "cache_read_tokens",
        ],
    ) {
        session.cache_read_tokens = v;
    }
    emit(app, "claude:status", session_id, "meta", session.metadata());
}

fn read_usage_u64(usage: &Value, keys: &[&str]) -> Option<u64> {
    for key in keys {
        if let Some(value) = usage.get(*key).and_then(Value::as_u64) {
            return Some(value);
        }
    }
    for nested_key in ["total", "cumulative", "usage"] {
        if let Some(value) = usage
            .get(nested_key)
            .and_then(|nested| read_usage_u64(nested, keys))
        {
            return Some(value);
        }
    }
    None
}

fn handle_turn_completed(
    app: &AppHandle,
    state: &CodexAppServerState,
    session_id: &str,
    params: &Value,
) {
    let (reason, result, meta, error_message) = {
        let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };
        session.is_running = false;
        session.active_turn_id = None;
        clear_runtime_status(session);
        cleanup_session_temp_images(session);
        session.command_outputs.clear();
        let turn = params.get("turn").unwrap_or(params);
        if let Some(usage) = turn.get("usage") {
            if let Some(v) = read_usage_u64(usage, &["inputTokens", "input_tokens", "input"]) {
                session.input_tokens = v;
            }
            if let Some(v) = read_usage_u64(usage, &["outputTokens", "output_tokens", "output"]) {
                session.output_tokens = v;
            }
            if let Some(v) = read_usage_u64(
                usage,
                &[
                    "cacheReadTokens",
                    "cached_input_tokens",
                    "cache_read_tokens",
                ],
            ) {
                session.cache_read_tokens = v;
            }
        }
        if let Some(started_at) = session.last_turn_started_at {
            session.last_turn_duration_ms = Some(started_at.elapsed().as_millis() as u64);
        }
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let reason = match status {
            "interrupted" => "aborted",
            "failed" => "error",
            _ => "completed",
        };
        let error_message = if reason == "error" {
            turn.get("error")
                .and_then(turn_error_message_from_value)
                .unwrap_or_else(|| "Codex turn failed.".to_string())
        } else {
            String::new()
        };
        let result = session.assistant_text.clone();
        (
            reason.to_string(),
            result,
            session.metadata(),
            error_message,
        )
    };
    emit(app, "claude:status", session_id, "meta", meta);
    if reason == "completed" {
        emit(
            app,
            "claude:result",
            session_id,
            "result",
            json!({ "subtype": "success", "result": if result.is_empty() { Value::Null } else { json!(result) }, "totalCost": 0 }),
        );
    } else if reason == "error" {
        emit(
            app,
            "claude:error",
            session_id,
            "error",
            json!(error_message),
        );
    }
    emit(
        app,
        "claude:turn-end",
        session_id,
        "payload",
        if reason == "error" {
            json!({ "reason": reason, "error": error_message })
        } else {
            json!({ "reason": reason, "result": result })
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn app_server_sandbox_uses_protocol_values() {
        assert_eq!(app_server_sandbox("read-only"), "read-only");
        assert_eq!(app_server_sandbox("workspace-write"), "workspace-write");
        assert_eq!(
            app_server_sandbox("danger-full-access"),
            "danger-full-access"
        );
    }

    #[test]
    fn codex_worktree_preset_routes_to_rust_runtime() {
        assert!(should_handle_codex(&Some(json!({
            "agentPreset": "codex-agent",
            "cwd": "/repo"
        }))));
        assert!(should_handle_codex(&Some(json!({
            "agentPreset": "codex-agent-worktree",
            "cwd": "/repo",
            "useWorktree": true
        }))));
        assert!(should_handle_codex(&Some(json!({
            "agentPreset": "codex-agent-worktree",
            "cwd": "/repo",
            "useWorktree": true,
            "worktreePath": "/repo/.bat-worktrees/abc12345"
        }))));
    }

    #[test]
    fn codex_worktree_uses_worktree_path_as_effective_cwd() {
        let options = json!({
            "agentPreset": "codex-agent-worktree",
            "cwd": "/repo",
            "useWorktree": true,
            "worktreePath": "/repo/.bat-worktrees/abc12345"
        });
        assert_eq!(
            effective_cwd(&options, "test").expect("cwd"),
            "/repo/.bat-worktrees/abc12345"
        );
    }

    #[test]
    fn supported_models_returns_codex_models_not_claude_models() {
        let state = CodexAppServerState::default();
        let models = state.supported_models();
        let values = models
            .as_array()
            .expect("models")
            .iter()
            .filter_map(|model| model.get("value").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(values.contains(&"gpt-5.5"));
        assert!(values.contains(&"gpt-5.3-codex"));
        assert!(!values.iter().any(|value| value.starts_with("claude-")));
    }

    #[test]
    fn codex_turn_input_converts_data_url_images_to_local_image_items() {
        let (input, temp_images) = build_turn_input(
            "describe this",
            vec!["data:image/png;base64,aGVsbG8=".to_string()],
        )
        .expect("turn input");
        let items = input.as_array().expect("input items");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["type"], "localImage");
        let path = items[0]["path"].as_str().expect("image path").to_string();
        assert!(Path::new(&path).is_file());
        assert_eq!(
            items[1],
            json!({ "type": "text", "text": "describe this", "text_elements": [] })
        );
        cleanup_temp_images(temp_images);
        assert!(!Path::new(&path).exists());
    }

    #[test]
    fn codex_turn_input_uses_protocol_url_field_for_remote_images() {
        let (input, temp_images) = build_turn_input(
            "describe this",
            vec!["https://example.com/screenshot.png".to_string()],
        )
        .expect("turn input");
        assert!(temp_images.is_empty());
        let items = input.as_array().expect("input items");
        assert_eq!(
            items[0],
            json!({ "type": "image", "url": "https://example.com/screenshot.png" })
        );
    }

    #[test]
    fn codex_turn_start_params_request_reasoning_summary() {
        let params = build_turn_start_params(
            "thread-1",
            json!([{ "type": "text", "text": "hello", "text_elements": [] }]),
            "gpt-5.5",
            "high",
        );
        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(params["model"], "gpt-5.5");
        assert_eq!(params["effort"], "high");
        assert_eq!(params["summary"], DEFAULT_CODEX_REASONING_SUMMARY);
        assert_eq!(params["reasoningEffort"], "high");
    }

    #[test]
    fn codex_thread_resume_params_preserve_runtime_options() {
        let params = build_thread_resume_params(
            "thread-1",
            "gpt-5.5",
            "/repo",
            "never",
            "danger-full-access",
        );
        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(params["model"], "gpt-5.5");
        assert_eq!(params["cwd"], "/repo");
        assert_eq!(params["approvalPolicy"], "never");
        assert_eq!(params["sandbox"], "danger-full-access");
        assert_eq!(params["serviceName"], "better_agent_terminal");
    }

    #[test]
    fn codex_thread_not_found_detector_matches_protocol_errors() {
        assert!(is_thread_not_found_error(
            "thread not found: 019e1bfc-e8f6-77e1-9886-1833ce991217"
        ));
        assert!(is_thread_not_found_error(
            "Codex error: Thread 019e1bfc not found"
        ));
        assert!(!is_thread_not_found_error(
            "turn failed: rate limit exceeded"
        ));
    }

    #[test]
    fn codex_reasoning_text_prefers_summary() {
        let text = reasoning_text_from_item(&json!({
            "type": "reasoning",
            "summary": [{ "type": "summary_text", "text": "summary text" }],
            "content": [{ "type": "reasoning_text", "text": "raw reasoning text" }],
            "encrypted_content": null,
        }));
        assert_eq!(text, "summary text");
    }

    #[test]
    fn codex_reasoning_text_reads_thread_item_content_fallback() {
        let text = reasoning_text_from_item(&json!({
            "type": "reasoning",
            "id": "reasoning-1",
            "summary": [],
            "content": ["fallback reasoning text"],
        }));
        assert_eq!(text, "fallback reasoning text");
    }

    #[test]
    fn codex_terminal_output_sanitizer_removes_control_codes() {
        let output = sanitize_terminal_output(
            "vite build\u{1b}[2K\rtransforming...\n\u{1b}[32m✓\u{1b}[0m done",
        );
        assert_eq!(output, "vite build\ntransforming...\n✓ done");
    }

    #[test]
    fn codex_metadata_includes_context_window() {
        let session = CodexSession {
            session_id: "s-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            cwd: "/repo".to_string(),
            model: "gpt-5.3-codex".to_string(),
            sandbox_mode: "workspace-write".to_string(),
            approval_policy: "on-request".to_string(),
            effort: "high".to_string(),
            start_time: Instant::now(),
            active_turn_id: None,
            assistant_text: String::new(),
            thinking_text: String::new(),
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 25,
            num_turns: 1,
            last_turn_started_at: None,
            last_turn_first_token_ms: None,
            last_turn_duration_ms: None,
            messages: Vec::new(),
            temporary_image_paths: Vec::new(),
            command_outputs: HashMap::new(),
            runtime_status: None,
            runtime_message: None,
            runtime_status_started_at: None,
            is_running: false,
            is_resting: false,
        };

        let meta = session.metadata();
        assert_eq!(meta["contextWindow"], DEFAULT_CODEX_CONTEXT_WINDOW);
        assert_eq!(meta["contextTokens"], 175);
    }

    #[test]
    fn codex_context_usage_uses_cached_usage_shape() {
        let state = CodexAppServerState::default();
        state
            .inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .insert(
                "s-1".to_string(),
                CodexSession {
                    session_id: "s-1".to_string(),
                    thread_id: Some("thread-1".to_string()),
                    cwd: "/repo".to_string(),
                    model: "gpt-5.5".to_string(),
                    sandbox_mode: "workspace-write".to_string(),
                    approval_policy: "on-request".to_string(),
                    effort: "high".to_string(),
                    start_time: Instant::now(),
                    active_turn_id: None,
                    assistant_text: String::new(),
                    thinking_text: String::new(),
                    input_tokens: 150,
                    output_tokens: 30,
                    cache_read_tokens: 250,
                    num_turns: 1,
                    last_turn_started_at: None,
                    last_turn_first_token_ms: None,
                    last_turn_duration_ms: None,
                    messages: Vec::new(),
                    temporary_image_paths: Vec::new(),
                    command_outputs: HashMap::new(),
                    runtime_status: None,
                    runtime_message: None,
                    runtime_status_started_at: None,
                    is_running: false,
                    is_resting: false,
                },
            );

        let usage = state.get_context_usage("s-1").expect("usage");
        assert_eq!(usage["totalTokens"], 430);
        assert_eq!(usage["maxTokens"], DEFAULT_CODEX_CONTEXT_WINDOW);
        assert_eq!(usage["percentage"], 0);
        assert_eq!(usage["model"], "gpt-5.5");
        assert_eq!(usage["apiUsage"]["input_tokens"], 150);
        assert_eq!(usage["apiUsage"]["output_tokens"], 30);
        assert_eq!(usage["apiUsage"]["cache_read_input_tokens"], 250);
        assert_eq!(usage["categories"][0]["name"], "Context");
        assert_eq!(state.get_context_usage("missing"), None);
    }

    #[test]
    fn codex_history_loader_reads_user_and_assistant_messages() {
        let content = r#"
{"timestamp":"2026-05-11T00:00:00Z","type":"session_meta","payload":{"id":"thread-1"}}
{"timestamp":"2026-05-11T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"ping"}}
{"timestamp":"2026-05-11T00:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"pong"}}
{"timestamp":"2026-05-11T00:00:03Z","type":"event_msg","payload":{"type":"other","message":"ignored"}}
"#;
        let items = codex_history_items_from_content("s-1", content);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["sessionId"], "s-1");
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[0]["content"], "ping");
        assert_eq!(items[1]["role"], "assistant");
        assert_eq!(items[1]["content"], "pong");
    }

    #[test]
    fn codex_session_log_prefers_session_meta_over_path_match() {
        let root = env::temp_dir().join(format!(
            "bat-codex-log-test-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create temp codex session dir");

        let path_only_match = root.join("thread-1-stale.jsonl");
        fs::write(
            &path_only_match,
            r#"{"type":"session_meta","payload":{"id":"different-thread"}}"#,
        )
        .expect("write path-only match");

        let exact_match = nested.join("session.jsonl");
        fs::write(
            &exact_match,
            r#"{"type":"session_meta","payload":{"id":"thread-1"}}"#,
        )
        .expect("write exact match");

        let found = find_codex_session_log(&root, "thread-1").expect("find session log");
        assert_eq!(found, exact_match);

        fs::remove_dir_all(root).ok();
    }
}
