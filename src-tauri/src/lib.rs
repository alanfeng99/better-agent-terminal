// Tauri shell entrypoint for Better Agent Terminal.
//
// This file is intentionally small: the Electron preload still owns most of
// the host surface during the migration. Each new command lands here behind
// a strongly typed signature, and the renderer reaches it via the
// host-api adapter (src/host-api.ts). See plans/tauri-migration-plan.md.

mod commands;
mod path_guard;

use commands::{
    app as app_cmd, clipboard as clipboard_cmd, debug as debug_cmd, dialog as dialog_cmd,
    fs as fs_cmd, git as git_cmd, github as github_cmd, image as image_cmd,
    notification as notification_cmd, pty as pty_cmd, settings, shell as shell_cmd,
    update as update_cmd, workspace as workspace_cmd,
};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(pty_cmd::PtyState::default())
        .manage(notification_cmd::NotificationState::default())
        .invoke_handler(tauri::generate_handler![
            settings::settings_load,
            settings::settings_save,
            settings::settings_get_shell_path,
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
            fs_cmd::fs_search,
            clipboard_cmd::clipboard_write_text,
            image_cmd::image_read_as_data_url,
            pty_cmd::pty_create,
            pty_cmd::pty_write,
            pty_cmd::pty_resize,
            pty_cmd::pty_kill,
            workspace_cmd::workspace_load,
            workspace_cmd::workspace_save,
            update_cmd::update_get_version,
            debug_cmd::debug_log,
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
            app_cmd::app_new_window,
            app_cmd::app_focus_next_window,
            app_cmd::app_open_new_instance,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running better-agent-terminal");
}
