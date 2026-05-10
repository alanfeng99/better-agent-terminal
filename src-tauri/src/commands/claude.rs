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
//   claude_account_list    — returns [].
//
// Each one resolves the SpawnConfig from the AppHandle so the bridge can
// find both `node` on PATH and the bundled sidecar script. Failures bubble
// up as { message } strings to the renderer.

use crate::codex_app_server::{should_handle_codex, CodexAppServerState};
use crate::event_hub::publish_runtime_event;
use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, BridgeError, SidecarState};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
// Long-running calls (startSession can boot the agent SDK, sendMessage may
// stream for minutes). 5 minutes is generous but bounded — callers that
// need true cancellation should issue abortSession through a separate
// invoke rather than relying on this timeout.
const SESSION_TIMEOUT: Duration = Duration::from_secs(300);

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
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "claude.authStatus", Value::Null).await
}

#[tauri::command]
pub async fn claude_account_list(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "claude.accountList", Value::Null).await
}

#[tauri::command]
pub async fn claude_start_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
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
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "claude.authLogin", Value::Null).await
}

#[tauri::command]
pub async fn claude_auth_logout(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "claude.authLogout", Value::Null).await
}

#[tauri::command]
pub async fn claude_account_import_current(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "claude.accountImportCurrent", Value::Null).await
}

#[tauri::command]
pub async fn claude_account_login_new(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "claude.accountLoginNew", Value::Null).await
}

#[tauri::command]
pub async fn claude_account_switch(
    app: AppHandle,
    state: State<'_, SidecarState>,
    account_id: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "claude.accountSwitch",
        json!({ "accountId": account_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_account_remove(
    app: AppHandle,
    state: State<'_, SidecarState>,
    account_id: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "claude.accountRemove",
        json!({ "accountId": account_id }),
    )
    .await
}

#[tauri::command]
pub async fn claude_account_mark_warning_shown(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "claude.accountMarkWarningShown", Value::Null).await
}

// --- read-only metadata ---------------------------------------------------

#[tauri::command]
pub async fn claude_get_cli_path(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "claude.getCliPath", Value::Null).await
}

#[tauri::command]
pub async fn claude_list_sessions(
    app: AppHandle,
    state: State<'_, SidecarState>,
    cwd: String,
    agent_kind: Option<String>,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "claude.listSessions",
        json!({ "cwd": cwd, "agentKind": agent_kind }),
    )
    .await
}

#[tauri::command]
pub async fn claude_get_supported_models(
    app: AppHandle,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if codex_state.is_owned(&session_id) {
        return Ok(codex_state.supported_models());
    }
    call_blocking(
        app,
        state,
        "claude.getSupportedModels",
        json!({ "sessionId": session_id }),
    )
    .await
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
        "claude.getAccountInfo",
        json!({ "sessionId": session_id }),
    )
    .await
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
    app: AppHandle,
    state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "claude.scanSkills", json!({ "cwd": cwd })).await
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
    state: State<'_, SidecarState>,
    session_id: String,
    messages: Value,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "claude.archiveMessages",
        json!({
            "sessionId": session_id, "messages": messages,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_load_archived(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    offset: u32,
    limit: u32,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "claude.loadArchived",
        json!({
            "sessionId": session_id, "offset": offset, "limit": limit,
        }),
    )
    .await
}

#[tauri::command]
pub async fn claude_clear_archive(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "claude.clearArchive",
        json!({ "sessionId": session_id }),
    )
    .await
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
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    sdk_session_id: String,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
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
    app: AppHandle,
    state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "claude.checkMcpJsonStatus",
        json!({ "cwd": cwd }),
    )
    .await
}

#[tauri::command]
pub async fn claude_enable_all_project_mcp(
    app: AppHandle,
    state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "claude.enableAllProjectMcp",
        json!({ "cwd": cwd }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
