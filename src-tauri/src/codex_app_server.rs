// Persistent Codex app-server controller.
//
// This is intentionally a compatibility adapter, not a renderer contract
// change. Codex app-server speaks JSON-RPC over JSONL; this module maps its
// thread/turn/item notifications back into the existing claude:* event shape
// consumed by the renderer.

use crate::event_hub::publish_runtime_event;
use crate::sidecar::BridgeError;
use serde_json::{json, Value};
use std::collections::HashMap;
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
    messages: Vec<Value>,
    is_running: bool,
}

impl CodexSession {
    fn metadata(&self) -> Value {
        let context_tokens = self.input_tokens + self.output_tokens + self.cache_read_tokens;
        json!({
            "model": self.model,
            "sdkSessionId": self.thread_id,
            "cwd": self.cwd,
            "totalCost": 0,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "durationMs": self.start_time.elapsed().as_millis() as u64,
            "numTurns": 0,
            "contextWindow": 0,
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
        })
    }
}

fn bridge_error(message: impl Into<String>) -> BridgeError {
    BridgeError {
        message: message.into(),
    }
}

fn is_codex_agent_preset(options: &Value) -> bool {
    matches!(
        options.get("agentPreset").and_then(Value::as_str),
        Some("codex-agent")
    )
}

pub fn should_handle_codex(options: &Option<Value>) -> bool {
    options.as_ref().map(is_codex_agent_preset).unwrap_or(false)
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
        "read-only" => "readOnly",
        "danger-full-access" => "dangerFullAccess",
        _ => "workspaceWrite",
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
    match resolve_codex_binary(app) {
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
    }
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
        let cwd = options
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or_else(|| bridge_error("codex app-server startSession: missing cwd"))?
            .to_string();
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
            messages: Vec::new(),
            is_running: false,
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
        let cwd = options
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
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
            messages: Vec::new(),
            is_running: false,
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
        let prompt = if prompt.trim().is_empty() && !images.is_empty() {
            "Please analyze the attached image.".to_string()
        } else {
            prompt.trim().to_string()
        };
        if prompt.is_empty() {
            return Ok(json!({ "ok": false, "error": "empty prompt" }));
        }
        let (thread_id, model, effort) = {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let session = sessions
                .get_mut(&session_id)
                .ok_or_else(|| bridge_error("Codex session not started"))?;
            session.is_running = true;
            session.assistant_text.clear();
            session.thinking_text.clear();
            let msg = make_user_message(&session_id, &prompt, images.len());
            session.messages.push(msg.clone());
            emit(app, "claude:message", &session_id, "message", msg);
            (
                session
                    .thread_id
                    .clone()
                    .ok_or_else(|| bridge_error("Codex thread not started"))?,
                session.model.clone(),
                session.effort.clone(),
            )
        };
        let input = if images.is_empty() {
            json!([{ "type": "text", "text": prompt }])
        } else {
            let mut items = images
                .into_iter()
                .map(|image| json!({ "type": "image", "image": image }))
                .collect::<Vec<_>>();
            items.push(json!({ "type": "text", "text": prompt }));
            Value::Array(items)
        };
        let connection = self.ensure_connection(app).map_err(bridge_error)?;
        let response = connection
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": input,
                    "model": model,
                    "reasoningEffort": effort,
                }),
                TURN_START_TIMEOUT,
            )
            .map_err(bridge_error)?;
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
        }
        Ok(json!({ "ok": true }))
    }

    pub fn abort_session(&self, app: &AppHandle, session_id: String) -> Result<Value, BridgeError> {
        let (thread_id, turn_id) = {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let Some(session) = sessions.get_mut(&session_id) else {
                return Ok(json!({ "ok": true }));
            };
            session.is_running = false;
            (session.thread_id.clone(), session.active_turn_id.clone())
        };
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            let connection = self.ensure_connection(app).map_err(bridge_error)?;
            let _ = connection.request(
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
                REQUEST_TIMEOUT,
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
        if let Some(session) = removed {
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

    pub fn set_model(&self, app: &AppHandle, session_id: &str, model: String) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        session.model = model;
        let meta = session.metadata();
        emit(app, "claude:status", session_id, "meta", meta.clone());
        Some(json!(true))
    }

    pub fn set_effort(&self, session_id: &str, effort: String) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        session.effort = normalize_effort(Some(&effort));
        Some(json!(true))
    }

    pub fn set_sandbox_mode(&self, session_id: &str, mode: String) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        session.sandbox_mode = normalize_sandbox(Some(&mode));
        Some(json!(true))
    }

    pub fn set_approval_policy(&self, session_id: &str, policy: String) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        session.approval_policy = normalize_approval(Some(&policy));
        Some(json!(true))
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
        return;
    };
    match method {
        "thread/started" => {
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
            let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
            if let Some(session) = sessions.get_mut(&session_id) {
                session.is_running = true;
                session.active_turn_id = params
                    .get("turn")
                    .and_then(|v| v.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
        "turn/completed" => handle_turn_completed(app, state, &session_id, &params),
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
            let delta = text_from_value(&params);
            if !delta.is_empty() {
                emit(
                    app,
                    "claude:stream",
                    &session_id,
                    "data",
                    json!({ "text": delta }),
                );
            }
        }
        _ => {}
    }
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
            if key == "text" {
                session.assistant_text.push_str(&delta);
            } else {
                session.thinking_text.push_str(&delta);
            }
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
            emit(
                app,
                "claude:tool-use",
                session_id,
                "toolCall",
                json!({
                    "id": item_id(item),
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
        Some("commandExecution" | "fileChange" | "mcpToolCall" | "webSearch") => {
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
    if let Some(v) = usage
        .get("inputTokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(Value::as_u64)
    {
        session.input_tokens = v;
    }
    if let Some(v) = usage
        .get("outputTokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(Value::as_u64)
    {
        session.output_tokens = v;
    }
    if let Some(v) = usage
        .get("cacheReadTokens")
        .or_else(|| usage.get("cached_input_tokens"))
        .and_then(Value::as_u64)
    {
        session.cache_read_tokens = v;
    }
    emit(app, "claude:status", session_id, "meta", session.metadata());
}

fn handle_turn_completed(
    app: &AppHandle,
    state: &CodexAppServerState,
    session_id: &str,
    params: &Value,
) {
    let (reason, result, meta) = {
        let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };
        session.is_running = false;
        session.active_turn_id = None;
        let turn = params.get("turn").unwrap_or(params);
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let reason = match status {
            "interrupted" => "aborted",
            "failed" => "error",
            _ => "completed",
        };
        let result = session.assistant_text.clone();
        (reason.to_string(), result, session.metadata())
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
    }
    emit(
        app,
        "claude:turn-end",
        session_id,
        "payload",
        json!({ "reason": reason, "result": result }),
    );
}
