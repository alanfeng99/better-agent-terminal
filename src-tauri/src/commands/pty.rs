// pty:* — first cut of the cross-platform PTY surface for the Tauri shell.
//
// We mirror the Electron preload contract from src/types/index.ts and
// electron/preload.ts so the renderer doesn't have to branch on host:
//   pty.create({ id, cwd, type, shell?, customEnv?, … })
//   pty.write(id, data)
//   pty.resize(id, cols, rows)
//   pty.kill(id)
// Plus two event streams emitted from a per-session reader thread:
//   pty:output  -> { id, data }
//   pty:exit    -> { id, exitCode }
//
// portable-pty handles the cross-platform side (forkpty on Unix, ConPTY on
// Windows). We keep one PtySession per id, hold the writer + master in a
// shared map behind Arc<Mutex<…>>, and use background threads to pump
// bytes into Tauri events and to wait on the child exit.

use crate::app_data;
use crate::commands::settings::resolve_shell_path;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl<E: std::fmt::Display> From<E> for CommandError {
    fn from(value: E) -> Self {
        Self {
            message: value.to_string(),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreatePtyOptions {
    pub id: String,
    pub cwd: String,
    #[allow(dead_code)] // accepted for API compat with Electron contract
    pub r#type: String,
    pub shell: Option<String>,
    #[allow(dead_code)]
    pub agent_preset: Option<String>,
    #[serde(default)]
    pub custom_env: Option<HashMap<String, String>>,
    #[serde(default)]
    #[allow(dead_code)]
    pub per_terminal_history: Option<bool>,
    #[serde(default)]
    #[allow(dead_code)]
    pub history_key: Option<String>,
}

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    cwd: String,
    kind: String,
}

pub struct PtyState {
    inner: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl PtyState {
    fn handle(&self) -> Arc<Mutex<HashMap<String, PtySession>>> {
        Arc::clone(&self.inner)
    }

    fn with_session<R>(
        &self,
        id: &str,
        f: impl FnOnce(&mut PtySession) -> Result<R, CommandError>,
    ) -> Result<R, CommandError> {
        let mut map = self.inner.lock().map_err(|e| CommandError {
            message: e.to_string(),
        })?;
        let session = map.get_mut(id).ok_or_else(|| CommandError {
            message: format!("pty session {id} not found"),
        })?;
        f(session)
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyOutputEvent {
    id: String,
    data: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    id: String,
    exit_code: i32,
}

// Pure, host-agnostic "is this id safe to use as a key?" check we can
// unit-test without touching the OS. The renderer generates short string
// ids, but we still defend against empty / overly long inputs.
pub fn is_valid_pty_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 256 {
        return false;
    }
    // No control chars / null bytes.
    !id.chars().any(|c| c.is_control())
}

// Pure helper used to decide which shell we should hand to portable-pty.
// Matches the Electron rule: explicit option wins, otherwise resolve via
// settings::resolve_shell_path("auto", …) for the running OS.
pub fn select_shell<F: Fn(&str) -> bool>(
    requested: Option<&str>,
    target_os: &str,
    exists: &F,
) -> String {
    if let Some(s) = requested {
        if !s.trim().is_empty() {
            return s.to_string();
        }
    }
    resolve_shell_path("auto", target_os, exists)
}

#[cfg(target_family = "unix")]
const TARGET_OS: &str = "unix";
#[cfg(target_os = "windows")]
const TARGET_OS: &str = "windows";
const OUTPUT_FLUSH_MS: u64 = 8;

fn hash_history_key(id: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:012x}")
}

fn sanitize_history_key(raw: &str) -> String {
    let safe = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .chars()
        .take(80)
        .collect::<String>();
    if safe.is_empty() {
        "terminal".into()
    } else {
        safe
    }
}

fn history_file_name(opts: &CreatePtyOptions) -> String {
    let key = opts
        .history_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .map(sanitize_history_key)
        .unwrap_or_else(|| hash_history_key(&opts.id));
    format!("{key}_history")
}

fn is_zsh_shell(shell: &str) -> bool {
    Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell)
        .contains("zsh")
}

fn source_zsh_file(file: &str) -> String {
    format!("[ -f \"${{_BAT_ZDOTDIR:-$HOME}}/{file}\" ] && source \"${{_BAT_ZDOTDIR:-$HOME}}/{file}\"\n")
}

fn ensure_zsh_wrapper(wrapper_dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(wrapper_dir)?;
    fs::write(wrapper_dir.join(".zshenv"), source_zsh_file(".zshenv"))?;
    fs::write(wrapper_dir.join(".zprofile"), source_zsh_file(".zprofile"))?;
    fs::write(
        wrapper_dir.join(".zshrc"),
        [
            source_zsh_file(".zshrc").trim_end().to_string(),
            "export HISTFILE=\"$_BAT_HISTFILE\"".into(),
            "setopt INC_APPEND_HISTORY".into(),
            "ZDOTDIR=\"${_BAT_ZDOTDIR:-$HOME}\"".into(),
            String::new(),
        ]
        .join("\n"),
    )?;
    fs::write(wrapper_dir.join(".zlogin"), source_zsh_file(".zlogin"))?;
    Ok(())
}

fn configure_per_terminal_history(
    cmd: &mut CommandBuilder,
    shell: &str,
    opts: &CreatePtyOptions,
    app_data_dir: Option<&Path>,
) {
    if opts.per_terminal_history != Some(true) {
        return;
    }
    let Some(app_data_dir) = app_data_dir else {
        return;
    };
    let history_dir = app_data_dir.join("terminal-history");
    if fs::create_dir_all(&history_dir).is_err() {
        return;
    }
    let hist_file = history_dir.join(history_file_name(opts));
    let hist_file_text = hist_file.to_string_lossy().to_string();
    cmd.env("HISTFILE", &hist_file_text);

    if is_zsh_shell(shell) {
        let wrapper_dir = history_dir.join(".zsh-wrapper");
        if ensure_zsh_wrapper(&wrapper_dir).is_ok() {
            let original_zdotdir = std::env::var("ZDOTDIR")
                .ok()
                .or_else(|| std::env::var("HOME").ok())
                .unwrap_or_default();
            cmd.env("ZDOTDIR", wrapper_dir.to_string_lossy().as_ref());
            cmd.env("_BAT_ZDOTDIR", original_zdotdir);
            cmd.env("_BAT_HISTFILE", hist_file_text);
        }
    }
}

fn build_command(opts: &CreatePtyOptions, app_data_dir: Option<&Path>) -> CommandBuilder {
    let exists = |s: &str| Path::new(s).exists();
    let shell = select_shell(opts.shell.as_deref(), TARGET_OS, &exists);
    let mut cmd = CommandBuilder::new(&shell);
    let cwd = if Path::new(&opts.cwd).is_dir() {
        PathBuf::from(&opts.cwd)
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    };
    cmd.cwd(cwd);
    if let Some(env) = &opts.custom_env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    configure_per_terminal_history(&mut cmd, &shell, opts, app_data_dir);
    cmd
}

fn emit_pty_output(app: &AppHandle, id: &str, data: String) {
    let _ = app.emit(
        "pty:output",
        PtyOutputEvent {
            id: id.to_string(),
            data,
        },
    );
}

fn spawn_output_coalescer(app: AppHandle, id: String) -> Sender<String> {
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            emit_pty_output(&app, &id, first);

            let mut pending = String::new();
            let deadline = Instant::now() + Duration::from_millis(OUTPUT_FLUSH_MS);
            loop {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(chunk) => pending.push_str(&chunk),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if !pending.is_empty() {
                            emit_pty_output(&app, &id, pending);
                        }
                        return;
                    }
                }
            }

            if !pending.is_empty() {
                emit_pty_output(&app, &id, pending);
            }
        }
    });
    tx
}

fn start_pty_session(
    app: &AppHandle,
    map_handle: Arc<Mutex<HashMap<String, PtySession>>>,
    options: CreatePtyOptions,
) -> Result<String, CommandError> {
    if !is_valid_pty_id(&options.id) {
        return Err(CommandError {
            message: format!("invalid pty id: {:?}", options.id),
        });
    }
    {
        let map = map_handle.lock().map_err(|e| CommandError {
            message: e.to_string(),
        })?;
        if map.contains_key(&options.id) {
            return Err(CommandError {
                message: format!("pty session {} already exists", options.id),
            });
        }
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| CommandError {
            message: e.to_string(),
        })?;
    let app_data_dir = app_data::app_data_dir_opt(&app);
    let cmd = build_command(&options, app_data_dir.as_deref());
    let child = pair.slave.spawn_command(cmd).map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| CommandError {
        message: e.to_string(),
    })?;

    // Reader thread: pump bytes from PTY → coalesced pty:output events.
    // Lossy UTF-8 because xterm.js consumes strings and PTYs can split
    // codepoints across reads; renderer can stitch via terminal state.
    let id_for_reader = options.id.clone();
    let output_tx = spawn_output_coalescer(app.clone(), id_for_reader.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    if output_tx.send(chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Insert the session before kicking off the exit watcher so the
    // watcher can find it.
    {
        let mut map = map_handle.lock().map_err(|e| CommandError {
            message: e.to_string(),
        })?;
        map.insert(
            options.id.clone(),
            PtySession {
                writer,
                master: pair.master,
                child,
                cwd: options.cwd.clone(),
                kind: options.r#type.clone(),
            },
        );
    }

    // Exit watcher: poll try_wait on the session's child every 100ms,
    // emit pty:exit with the exit code, and remove the session entry.
    let id_for_exit = options.id.clone();
    let app_for_exit = app.clone();
    std::thread::spawn(move || {
        loop {
            let status = {
                let mut map = match map_handle.lock() {
                    Ok(m) => m,
                    Err(_) => break,
                };
                let session = match map.get_mut(&id_for_exit) {
                    Some(s) => s,
                    // Killed externally — nothing to wait on.
                    None => break,
                };
                match session.child.try_wait() {
                    Ok(opt) => opt,
                    Err(_) => break,
                }
            };
            if let Some(s) = status {
                let code = s.exit_code() as i32;
                let _ = app_for_exit.emit(
                    "pty:exit",
                    PtyExitEvent {
                        id: id_for_exit.clone(),
                        exit_code: code,
                    },
                );
                if let Ok(mut map) = map_handle.lock() {
                    map.remove(&id_for_exit);
                }
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });

    Ok(options.id)
}

#[tauri::command]
pub async fn pty_create(
    app: AppHandle,
    state: State<'_, PtyState>,
    options: CreatePtyOptions,
) -> Result<String, CommandError> {
    let handle = state.handle();
    tauri::async_runtime::spawn_blocking(move || start_pty_session(&app, handle, options))
        .await
        .map_err(|e| CommandError {
            message: format!("pty.create worker failed: {e}"),
        })?
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), CommandError> {
    state.with_session(&id, |s| {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| CommandError {
                message: e.to_string(),
            })?;
        s.writer.flush().map_err(|e| CommandError {
            message: e.to_string(),
        })?;
        Ok(())
    })
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    state.with_session(&id, |s| {
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| CommandError {
                message: e.to_string(),
            })?;
        Ok(())
    })
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), CommandError> {
    let mut map = state.inner.lock().map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    if let Some(mut session) = map.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_restart(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    cwd: String,
    shell: Option<String>,
) -> Result<bool, CommandError> {
    let handle = state.handle();
    tauri::async_runtime::spawn_blocking(move || pty_restart_impl(app, handle, id, cwd, shell))
        .await
        .map_err(|e| CommandError {
            message: format!("pty.restart worker failed: {e}"),
        })?
}

fn pty_restart_impl(
    app: AppHandle,
    handle: Arc<Mutex<HashMap<String, PtySession>>>,
    id: String,
    cwd: String,
    shell: Option<String>,
) -> Result<bool, CommandError> {
    let kind = {
        let mut map = handle.lock().map_err(|e| CommandError {
            message: e.to_string(),
        })?;
        let Some(mut session) = map.remove(&id) else {
            return Ok(false);
        };
        let kind = session.kind.clone();
        let _ = session.child.kill();
        kind
    };

    start_pty_session(
        &app,
        handle,
        CreatePtyOptions {
            id,
            cwd,
            r#type: kind,
            shell,
            agent_preset: None,
            custom_env: None,
            per_terminal_history: None,
            history_key: None,
        },
    )?;
    Ok(true)
}

#[tauri::command]
pub fn pty_get_cwd(state: State<'_, PtyState>, id: String) -> Result<Option<String>, CommandError> {
    let map = state.inner.lock().map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    Ok(map.get(&id).map(|session| session.cwd.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_must_be_non_empty_and_non_control() {
        assert!(is_valid_pty_id("term-1"));
        assert!(is_valid_pty_id("a"));
        assert!(!is_valid_pty_id(""));
        assert!(!is_valid_pty_id("with\nnewline"));
        assert!(!is_valid_pty_id("with\0null"));
        // Length cap: 256 chars is fine, 257 is not.
        let long = "a".repeat(256);
        assert!(is_valid_pty_id(&long));
        let too_long = "a".repeat(257);
        assert!(!is_valid_pty_id(&too_long));
    }

    #[test]
    fn select_shell_uses_explicit_option_when_provided() {
        let none = |_: &str| false;
        assert_eq!(select_shell(Some("/bin/zsh"), "unix", &none), "/bin/zsh");
        // Empty / whitespace falls back to auto-resolve.
        assert_eq!(select_shell(Some("   "), "unix", &none), "/bin/bash");
        assert_eq!(select_shell(Some(""), "unix", &none), "/bin/bash");
    }

    #[test]
    fn select_shell_auto_falls_back_per_platform() {
        let none = |_: &str| false;
        // posix_auto_shell returns /bin/bash on Linux when $SHELL is unset
        // (or the existing value isn't on disk per `exists`).
        let unix = select_shell(None, "unix", &none);
        assert!(unix.starts_with("/bin/"));

        // On Windows with no PowerShell installs detected, auto returns
        // powershell.exe (matches settings::resolve_shell_path).
        let win = select_shell(None, "windows", &none);
        assert_eq!(win, "powershell.exe");
    }

    #[test]
    fn history_file_name_prefers_sanitized_history_key() {
        let opts = CreatePtyOptions {
            id: "term-1".into(),
            cwd: ".".into(),
            r#type: "terminal".into(),
            shell: None,
            agent_preset: None,
            custom_env: None,
            per_terminal_history: Some(true),
            history_key: Some("workspace:one/term".into()),
        };
        assert_eq!(history_file_name(&opts), "workspace_one_term_history");
    }

    #[test]
    fn history_file_name_hashes_id_without_key() {
        let opts = CreatePtyOptions {
            id: "term-1".into(),
            cwd: ".".into(),
            r#type: "terminal".into(),
            shell: None,
            agent_preset: None,
            custom_env: None,
            per_terminal_history: Some(true),
            history_key: None,
        };
        assert!(history_file_name(&opts).ends_with("_history"));
        assert_ne!(history_file_name(&opts), "term-1_history");
    }

    #[test]
    fn zsh_wrapper_files_match_electron_shape() {
        let root = std::env::temp_dir().join(format!(
            "bat-zsh-wrapper-test-{}-{}",
            std::process::id(),
            hash_history_key("wrapper")
        ));
        let _ = fs::remove_dir_all(&root);
        ensure_zsh_wrapper(&root).unwrap();
        let zshrc = fs::read_to_string(root.join(".zshrc")).unwrap();
        assert!(zshrc.contains("source \"${_BAT_ZDOTDIR:-$HOME}/.zshrc\""));
        assert!(zshrc.contains("export HISTFILE=\"$_BAT_HISTFILE\""));
        assert!(zshrc.contains("setopt INC_APPEND_HISTORY"));
        assert!(root.join(".zshenv").exists());
        assert!(root.join(".zprofile").exists());
        assert!(root.join(".zlogin").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
