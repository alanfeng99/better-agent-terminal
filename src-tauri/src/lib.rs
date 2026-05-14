// Tauri shell entrypoint for Better Agent Terminal.
//
// This file is intentionally small: the Electron preload still owns most of
// the host surface during the migration. Each new command lands here behind
// a strongly typed signature, and the renderer reaches it via the
// host-api adapter (renderer/src/host-api.ts). See plans/tauri-migration-plan.md.

mod account_store;
mod app_data;
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
use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
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
        .setup(|app| {
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
        .run(tauri::generate_context!())
        .expect("error while running better-agent-terminal");
}
