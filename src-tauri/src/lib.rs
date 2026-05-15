// Tauri shell entrypoint for Better Agent Terminal.
//
// This file is intentionally small: the Electron preload still owns most of
// the host surface during the migration. Each new command lands here behind
// a strongly typed signature, and the renderer reaches it via the
// host-api adapter (renderer/src/host-api.ts). See plans/tauri-migration-plan.md.

mod account_store;
mod app_data;
mod app_menu;
mod codex_app_server;
mod codex_auth;
mod commands;
mod electron_safe_storage;
mod event_hub;
mod log_file;
mod network_addresses;
mod path_guard;
mod remote_client;
pub mod remote_core;
mod remote_server;
mod sidecar;
mod subprocess;
mod window_registry;

use commands::{
    agent as agent_cmd, app as app_cmd, claude as claude_cmd, clipboard as clipboard_cmd,
    debug as debug_cmd, dialog as dialog_cmd, fs as fs_cmd, git as git_cmd, github as github_cmd,
    image as image_cmd, notification as notification_cmd, profile as profile_cmd, pty as pty_cmd,
    remote as remote_cmd, settings, shell as shell_cmd, snippet as snippet_cmd,
    tunnel as tunnel_cmd, update as update_cmd, worker_buffer as worker_buffer_cmd,
    workspace as workspace_cmd, worktree as worktree_cmd,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, PartialEq, Eq)]
struct HeadlessServerArgs {
    port: u16,
    bind_interface: String,
    data_dir: Option<PathBuf>,
    token: Option<String>,
}

#[derive(Debug)]
enum HeadlessCliAction {
    Run(HeadlessServerArgs),
    Help,
}

pub fn is_headless_server_invocation() -> bool {
    std::env::args().any(|arg| arg == "--bat-server")
}

pub fn run_headless_server_cli() -> i32 {
    match parse_headless_server_args(std::env::args().skip(1)) {
        Ok(HeadlessCliAction::Help) => {
            print_headless_server_help();
            0
        }
        Ok(HeadlessCliAction::Run(args)) => match run_headless_server(args) {
            Ok(()) => 0,
            Err(err) => {
                eprintln!("bat-server failed to start: {err}");
                1
            }
        },
        Err(err) => {
            eprintln!("bat-server: {err}");
            eprintln!("Try `bat-server --help` for usage.");
            1
        }
    }
}

pub fn run() {
    let context = app_context();
    app_builder(false)
        .run(context)
        .expect("error while running better-agent-terminal");
}

fn app_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

fn app_builder(headless: bool) -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .menu(app_menu::build)
        .on_menu_event(app_menu::handle_event)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(pty_cmd::PtyState::default())
        .manage(notification_cmd::NotificationState::default())
        .manage(notification_cmd::AgentNotificationState::default())
        .manage(fs_cmd::FsWatcherState::default())
        .manage(snippet_cmd::SnippetState::default())
        .manage(worker_buffer_cmd::WorkerBufferState::default())
        .manage(worktree_cmd::WorktreeState::default())
        .manage(event_hub::RuntimeEventHubState::default())
        .manage(remote_client::RustRemoteClientState::default())
        .manage(remote_server::RustRemoteServerState::default())
        .manage(codex_app_server::CodexAppServerState::default())
        .manage(window_registry::WindowRegistryState::default())
        .manage(sidecar::SidecarState::new())
        .setup(move |app| {
            if !headless {
                if let Some(window) = app.get_webview_window("main") {
                    app_cmd::attach_window_lifecycle(&window);
                }
                remote_cmd::spawn_auto_start_remote_server(app.handle().clone());
                if let Ok(token) = std::env::var("BAT_TAURI_DYNAMIC_WINDOW_SMOKE_TOKEN") {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1200));
                        for _ in 0..12 {
                            let _ = handle.emit_to("main", "bat:smoke-new-window", token.clone());
                            std::thread::sleep(std::time::Duration::from_millis(500));
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::settings_load,
            settings::settings_save,
            settings::settings_get_shell_path,
            settings::settings_clear_terminal_history,
            settings::settings_detect_cx,
            shell_cmd::shell_open_external,
            shell_cmd::shell_open_path,
            dialog_cmd::dialog_confirm,
            dialog_cmd::dialog_select_folder,
            dialog_cmd::dialog_select_files,
            dialog_cmd::dialog_select_images,
            fs_cmd::fs_read_file,
            fs_cmd::fs_home,
            fs_cmd::fs_readdir,
            fs_cmd::fs_is_directory,
            fs_cmd::fs_list_dirs,
            fs_cmd::fs_mkdir,
            fs_cmd::fs_delete_path,
            fs_cmd::fs_quick_locations,
            fs_cmd::fs_resolve_path_links,
            fs_cmd::fs_search,
            fs_cmd::fs_watch,
            fs_cmd::fs_unwatch,
            clipboard_cmd::clipboard_save_image,
            clipboard_cmd::clipboard_write_text,
            clipboard_cmd::clipboard_write_image,
            image_cmd::image_read_as_data_url,
            image_cmd::image_save_data_url,
            pty_cmd::pty_create,
            pty_cmd::pty_write,
            pty_cmd::pty_resize,
            pty_cmd::pty_kill,
            pty_cmd::pty_restart,
            pty_cmd::pty_get_cwd,
            workspace_cmd::workspace_load,
            workspace_cmd::workspace_save,
            workspace_cmd::workspace_detach,
            workspace_cmd::workspace_reattach,
            workspace_cmd::workspace_move_to_window,
            update_cmd::update_get_version,
            update_cmd::update_check,
            debug_cmd::debug_is_debug_mode,
            debug_cmd::debug_log,
            debug_cmd::debug_open_logs_folder,
            git_cmd::git_get_github_url,
            git_cmd::git_get_branch,
            git_cmd::git_get_log,
            git_cmd::git_get_diff,
            git_cmd::git_get_diff_files,
            git_cmd::git_get_root,
            git_cmd::git_get_status,
            app_cmd::app_get_window_id,
            app_cmd::app_get_window_index,
            app_cmd::app_get_launch_profile,
            app_cmd::app_get_window_profile,
            app_cmd::app_set_title,
            app_cmd::app_new_window,
            app_cmd::app_focus_next_window,
            app_cmd::app_open_new_instance,
            app_cmd::app_restore_active_profiles,
            app_cmd::app_set_dock_badge,
            notification_cmd::notification_list,
            notification_cmd::notification_mark_read,
            notification_cmd::notification_mark_all_read,
            notification_cmd::notification_mark_window_read,
            notification_cmd::notification_clear,
            notification_cmd::notification_focus_latest_unread,
            notification_cmd::notification_focus_entry,
            github_cmd::github_check_cli,
            github_cmd::github_pr_list,
            github_cmd::github_issue_list,
            github_cmd::github_pr_view,
            github_cmd::github_issue_view,
            github_cmd::github_pr_comment,
            github_cmd::github_issue_comment,
            snippet_cmd::snippet_get_all,
            snippet_cmd::snippet_get_by_id,
            snippet_cmd::snippet_get_favorites,
            snippet_cmd::snippet_search,
            snippet_cmd::snippet_get_by_workspace,
            snippet_cmd::snippet_get_categories,
            snippet_cmd::snippet_create,
            snippet_cmd::snippet_update,
            snippet_cmd::snippet_delete,
            snippet_cmd::snippet_toggle_favorite,
            profile_cmd::profile_list,
            profile_cmd::profile_list_local,
            profile_cmd::profile_get,
            profile_cmd::profile_get_active_ids,
            profile_cmd::profile_create,
            profile_cmd::profile_save,
            profile_cmd::profile_load,
            profile_cmd::profile_delete,
            profile_cmd::profile_rename,
            profile_cmd::profile_update,
            profile_cmd::profile_duplicate,
            profile_cmd::profile_activate,
            profile_cmd::profile_deactivate,
            claude_cmd::claude_ping,
            claude_cmd::claude_auth_status,
            claude_cmd::claude_account_list,
            claude_cmd::claude_start_session,
            claude_cmd::claude_send_message,
            claude_cmd::claude_stop_session,
            claude_cmd::claude_abort_session,
            claude_cmd::claude_stop_task,
            claude_cmd::claude_auth_login,
            claude_cmd::claude_auth_logout,
            claude_cmd::claude_account_import_current,
            claude_cmd::claude_account_login_new,
            claude_cmd::claude_account_switch,
            claude_cmd::claude_account_remove,
            claude_cmd::claude_account_mark_warning_shown,
            claude_cmd::claude_get_cli_path,
            claude_cmd::claude_prepare_cli_session,
            claude_cmd::claude_list_sessions,
            claude_cmd::claude_get_supported_models,
            claude_cmd::claude_get_supported_commands,
            claude_cmd::claude_get_supported_agents,
            claude_cmd::claude_get_account_info,
            claude_cmd::claude_get_session_state,
            claude_cmd::claude_get_session_meta,
            claude_cmd::claude_get_context_usage,
            claude_cmd::claude_get_worktree_status,
            claude_cmd::claude_scan_skills,
            claude_cmd::claude_cleanup_worktree,
            claude_cmd::claude_set_auto_continue,
            claude_cmd::claude_get_auto_continue,
            claude_cmd::claude_set_permission_mode,
            claude_cmd::claude_set_codex_sandbox_mode,
            claude_cmd::claude_set_codex_approval_policy,
            claude_cmd::claude_set_model,
            claude_cmd::claude_set_effort,
            claude_cmd::claude_reset_session,
            claude_cmd::claude_resume_session,
            claude_cmd::claude_fork_session,
            claude_cmd::claude_fetch_subagent_messages,
            claude_cmd::claude_rest_session,
            claude_cmd::claude_wake_session,
            claude_cmd::claude_is_resting,
            claude_cmd::claude_archive_messages,
            claude_cmd::claude_load_archived,
            claude_cmd::claude_clear_archive,
            claude_cmd::claude_rewind_to_prompt,
            claude_cmd::claude_resolve_permission,
            claude_cmd::claude_resolve_ask_user,
            claude_cmd::claude_check_mcp_json_status,
            claude_cmd::claude_enable_all_project_mcp,
            worktree_cmd::worktree_create,
            worktree_cmd::worktree_remove,
            worktree_cmd::worktree_status,
            worktree_cmd::worktree_merge,
            worktree_cmd::worktree_rehydrate,
            agent_cmd::agent_list_presets,
            worker_buffer_cmd::worker_buffer_init,
            worker_buffer_cmd::worker_buffer_append,
            worker_buffer_cmd::worker_buffer_read_all,
            worker_buffer_cmd::worker_buffer_clear,
            worker_buffer_cmd::worker_procfile_load,
            worker_buffer_cmd::worker_procfile_start,
            worker_buffer_cmd::worker_procfile_stop,
            remote_cmd::remote_start_server,
            remote_cmd::remote_stop_server,
            remote_cmd::remote_server_status,
            remote_cmd::remote_connect,
            remote_cmd::remote_disconnect,
            remote_cmd::remote_client_status,
            remote_cmd::remote_test_connection,
            remote_cmd::remote_list_profiles,
            tunnel_cmd::tunnel_get_connection,
        ])
}

fn run_headless_server(args: HeadlessServerArgs) -> Result<(), String> {
    if let Some(data_dir) = &args.data_dir {
        std::env::set_var(app_data::TAURI_DATA_DIR_ENV, data_dir);
    }

    let mut context = app_context();
    context.config_mut().app.windows.clear();

    let app = app_builder(true)
        .build(context)
        .map_err(|err| format!("headless Tauri runtime build failed: {err}"))?;
    start_headless_remote_server(app.handle(), &args)?;
    app.run(|_app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
        }
    });
    Ok(())
}

fn start_headless_remote_server(
    app: &tauri::AppHandle,
    args: &HeadlessServerArgs,
) -> Result<(), String> {
    let remote_state = app.state::<remote_server::RustRemoteServerState>();
    let sidecar_state = app.state::<sidecar::SidecarState>().inner().clone();
    let mut options = json!({
        "port": args.port,
        "bindInterface": args.bind_interface,
    });
    if let Some(token) = &args.token {
        options["token"] = Value::String(token.clone());
    }

    let result = remote_state.start(app.clone(), sidecar_state, Some(options))?;
    print_headless_server_banner(app, &result)?;
    Ok(())
}

fn print_headless_server_banner(app: &tauri::AppHandle, result: &Value) -> Result<(), String> {
    let port = result
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| "remote server result missing port".to_string())?;
    let bound_host = result
        .get("boundHost")
        .and_then(Value::as_str)
        .ok_or_else(|| "remote server result missing boundHost".to_string())?;
    let bind_interface = result
        .get("bindInterface")
        .and_then(Value::as_str)
        .ok_or_else(|| "remote server result missing bindInterface".to_string())?;
    let token = result
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "remote server result missing token".to_string())?;
    let fingerprint = result
        .get("fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(|| "remote server result missing fingerprint".to_string())?;
    let data_dir = app_data::app_data_dir(app)?;
    let connect_url = format!(
        "wss://{bound_host}:{port}?token={}&fp={}",
        encode_query_component(token),
        encode_query_component(fingerprint)
    );

    println!();
    println!("bat-server ready");
    println!("  url:         wss://{bound_host}:{port}");
    println!("  bind:        {bind_interface}");
    println!("  token:       {token}");
    println!("  fingerprint: {fingerprint}");
    println!("  data-dir:    {}", data_dir.display());
    println!("  connect:     {connect_url}");
    println!();
    Ok(())
}

fn encode_query_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn parse_headless_server_args<I>(args: I) -> Result<HeadlessCliAction, String>
where
    I: IntoIterator<Item = String>,
{
    let mut port = parse_env_port()?.unwrap_or(9876);
    let mut bind_interface = std::env::var("BAT_BIND").unwrap_or_else(|_| "localhost".into());
    let mut data_dir = std::env::var_os("BAT_DATA_DIR")
        .or_else(|| std::env::var_os(app_data::TAURI_DATA_DIR_ENV))
        .map(PathBuf::from)
        .or_else(default_headless_data_dir);
    let mut token = std::env::var("BAT_TOKEN")
        .ok()
        .filter(|value| !value.is_empty());
    let mut iter = args.into_iter().peekable();

    while let Some(arg) = iter.next() {
        if arg == "--bat-server" {
            continue;
        }
        if arg == "--help" || arg == "-h" {
            return Ok(HeadlessCliAction::Help);
        }
        if arg == "--debug" {
            std::env::set_var("BAT_DEBUG", "1");
            continue;
        }
        if let Some(value) = arg.strip_prefix("--port=") {
            port = parse_port(value)?;
            continue;
        }
        if arg == "--port" {
            let value = iter
                .next()
                .ok_or_else(|| "--port requires a value".to_string())?;
            port = parse_port(&value)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--bind=") {
            bind_interface = value.to_string();
            continue;
        }
        if arg == "--bind" {
            bind_interface = iter
                .next()
                .ok_or_else(|| "--bind requires a value".to_string())?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--data-dir=") {
            data_dir = Some(PathBuf::from(value));
            continue;
        }
        if arg == "--data-dir" {
            data_dir = Some(PathBuf::from(
                iter.next()
                    .ok_or_else(|| "--data-dir requires a value".to_string())?,
            ));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--token=") {
            token = Some(value.to_string());
            continue;
        }
        if arg == "--token" {
            token = Some(
                iter.next()
                    .ok_or_else(|| "--token requires a value".to_string())?,
            );
            continue;
        }
        if arg.starts_with('-') {
            return Err(format!("unknown flag: {arg}"));
        }
        return Err(format!("unexpected argument: {arg}"));
    }

    let bind_interface = normalize_headless_bind(&bind_interface)?;
    Ok(HeadlessCliAction::Run(HeadlessServerArgs {
        port,
        bind_interface,
        data_dir,
        token,
    }))
}

fn parse_env_port() -> Result<Option<u16>, String> {
    match std::env::var("BAT_PORT") {
        Ok(value) if !value.trim().is_empty() => parse_port(&value).map(Some),
        _ => Ok(None),
    }
}

fn default_headless_data_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    if cfg!(target_os = "macos") {
        return Some(
            home.join("Library")
                .join("Application Support")
                .join("better-agent-terminal"),
        );
    }
    if cfg!(windows) {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        return Some(base.join("better-agent-terminal"));
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    Some(base.join("better-agent-terminal"))
}

fn parse_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| format!("invalid port: {value}"))?;
    if port == 0 {
        return Err("port must be between 1 and 65535".into());
    }
    Ok(port)
}

fn normalize_headless_bind(value: &str) -> Result<String, String> {
    match value {
        "localhost" | "tailscale" | "all" => Ok(value.to_string()),
        _ => Err(format!(
            "invalid bind interface: {value} (expected localhost|tailscale|all)"
        )),
    }
}

fn print_headless_server_help() {
    println!(
        "bat-server - headless RemoteServer for Better Agent Terminal\n\n\
Usage:\n  bat-server [options]\n\n\
Options:\n  --port=N            TCP port to listen on (default: 9876)\n  \
--bind=IFACE        localhost | tailscale | all (default: localhost)\n  \
--data-dir=PATH     persistent state directory\n  \
--token=HEX         pin a known token (default: persisted or random)\n  \
--debug             write debug logs inside the app data dir\n  \
-h, --help          show this help\n\n\
Environment variables: BAT_DATA_DIR BAT_TAURI_DATA_DIR BAT_PORT BAT_BIND BAT_TOKEN BAT_DEBUG"
    );
}

#[cfg(test)]
mod headless_tests {
    use super::*;

    #[test]
    fn parse_headless_args_accepts_stable_flags() {
        let parsed = parse_headless_server_args([
            "--bat-server".to_string(),
            "--port=12345".to_string(),
            "--bind=tailscale".to_string(),
            "--data-dir=/tmp/bat".to_string(),
            "--token=abc123".to_string(),
        ])
        .unwrap();
        let HeadlessCliAction::Run(args) = parsed else {
            panic!("expected run action");
        };
        assert_eq!(args.port, 12345);
        assert_eq!(args.bind_interface, "tailscale");
        assert_eq!(args.data_dir, Some(PathBuf::from("/tmp/bat")));
        assert_eq!(args.token.as_deref(), Some("abc123"));
    }

    #[test]
    fn parse_headless_args_defaults_data_dir_to_history_path() {
        let parsed = parse_headless_server_args(Vec::<String>::new()).unwrap();
        let HeadlessCliAction::Run(args) = parsed else {
            panic!("expected run action");
        };
        let dir = args.data_dir.expect("default data dir");
        assert_eq!(
            dir.file_name().and_then(|name| name.to_str()),
            Some("better-agent-terminal")
        );
    }

    #[test]
    fn parse_headless_args_rejects_invalid_bind() {
        let err = parse_headless_server_args(["--bind=public".to_string()]).unwrap_err();
        assert!(err.contains("invalid bind interface"));
    }

    #[test]
    fn encode_query_component_percent_encodes_fingerprint_colons() {
        assert_eq!(encode_query_component("AA:BB cc"), "AA%3ABB%20cc");
    }
}
