// app:* — Tauri window/profile shell.
//
// Electron owns multi-window behaviour in its main process. The Tauri port
// keeps the renderer-facing contract intact, but the window registry and local
// profile restore now live in Rust so profile windows do not need the Node
// sidecar.

use super::profile as profile_cmd;
use crate::log_file::append_line;
use crate::window_registry;
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct OpenNewInstanceResult {
    #[serde(rename = "alreadyOpen")]
    pub already_open: bool,
    #[serde(rename = "windowIds", skip_serializing_if = "Vec::is_empty")]
    pub window_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

static ACTIVE_PROFILE_RESTORE_DONE: OnceLock<Mutex<bool>> = OnceLock::new();

fn active_profile_restore_done() -> &'static Mutex<bool> {
    ACTIVE_PROFILE_RESTORE_DONE.get_or_init(|| Mutex::new(false))
}

fn active_profiles_to_restore(
    active_profile_ids: &[String],
    current_profile_id: Option<&str>,
) -> Vec<String> {
    let mut seen = Vec::<String>::new();
    for profile_id in active_profile_ids {
        if profile_id.trim().is_empty() {
            continue;
        }
        if current_profile_id == Some(profile_id.as_str()) {
            continue;
        }
        if !seen.iter().any(|seen_id| seen_id == profile_id) {
            seen.push(profile_id.clone());
        }
    }
    seen
}

pub(crate) fn renderer_url(path: &str) -> WebviewUrl {
    WebviewUrl::App(path.into())
}

pub(crate) fn log_tauri(app: &AppHandle, message: &str) {
    eprintln!("[tauri] {message}");
    let Some(path) = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("logs").join("debug.log"))
    else {
        return;
    };
    let line = tauri_log_line(message);
    tauri::async_runtime::spawn_blocking(move || {
        let _ = append_line(&path, &line);
    });
}

fn tauri_log_line(message: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{millis} [tauri] {message}\n")
}

fn webview_url_debug(url: &WebviewUrl) -> String {
    match url {
        WebviewUrl::App(path) => format!("app:{}", path.to_string_lossy()),
        WebviewUrl::External(url) => format!("external:{url}"),
        other => format!("{other:?}"),
    }
}

fn build_window(app: &AppHandle, window_id: &str) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(window_id) {
        window_registry::mark_window_active(app, window_id);
        let _ = win.set_focus();
        return Ok(());
    }
    let build_app = app.clone();
    let build_window_id = window_id.to_string();
    log_tauri(
        app,
        &format!("[window] queue-build label={build_window_id}"),
    );
    app.run_on_main_thread(move || {
        if let Err(error) = build_window_now(&build_app, &build_window_id) {
            log_tauri(
                &build_app,
                &format!("[window] queued-build-failed label={build_window_id} error={error}"),
            );
        }
    })
    .map_err(|err| err.to_string())
}

fn build_window_now(app: &AppHandle, window_id: &str) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(window_id) {
        window_registry::mark_window_active(app, window_id);
        let _ = win.set_focus();
        return Ok(());
    }
    let url = renderer_url("index.html");
    log_tauri(
        app,
        &format!(
            "[window] create label={window_id} url={}",
            webview_url_debug(&url)
        ),
    );
    let nav_app = app.clone();
    let nav_label = window_id.to_string();
    let load_label = window_id.to_string();
    let mut builder = WebviewWindowBuilder::new(app, window_id, url)
        .title("Better Agent Terminal")
        .min_inner_size(800.0, 600.0)
        .on_navigation(move |url| {
            log_tauri(
                &nav_app,
                &format!("[window] navigation label={nav_label} url={url}"),
            );
            true
        })
        .on_page_load(move |window, payload| {
            log_tauri(
                window.app_handle(),
                &format!(
                    "[window] page-load label={load_label} event={:?} url={}",
                    payload.event(),
                    payload.url()
                ),
            );
        });
    if let Some((x, y, width, height)) = window_registry::window_bounds(app, window_id) {
        builder = builder.inner_size(width, height).position(x, y);
    } else {
        builder = builder.inner_size(1280.0, 800.0);
    }
    let window = builder.build().map_err(|err| {
        let error = err.to_string();
        log_tauri(
            app,
            &format!("[window] build-failed label={window_id} error={error}"),
        );
        error
    })?;
    log_tauri(app, &format!("[window] created label={window_id}"));
    attach_window_lifecycle(&window);
    Ok(())
}

pub fn attach_window_lifecycle(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let window_id = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(true)) {
            window_registry::mark_window_active(&app, &window_id);
        } else if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            if let Some(window) = app.get_webview_window(&window_id) {
                if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
                    window_registry::update_window_bounds(
                        &app,
                        &window_id,
                        position.x as f64,
                        position.y as f64,
                        size.width as f64,
                        size.height as f64,
                    );
                }
            }
        } else if matches!(event, WindowEvent::Destroyed) {
            log_tauri(&app, &format!("[window] destroyed label={window_id}"));
            if let Some(profile_id) = window_registry::profile_id_for_window(&app, &window_id) {
                if !window_registry::has_other_live_profile_windows(&app, &profile_id, &window_id) {
                    let _ = profile_cmd::deactivate_profile_id(&app, &profile_id);
                }
            }
        }
    });
}

fn parse_launch_profile_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let arg = arg.as_ref();
        if let Some(profile_id) = arg.strip_prefix("--profile=") {
            let profile_id = profile_id.trim();
            if !profile_id.is_empty() {
                return Some(profile_id.to_string());
            }
        }
        if arg == "--profile" {
            if let Some(profile_id) = iter.next() {
                let profile_id = profile_id.as_ref().trim();
                if !profile_id.is_empty() {
                    return Some(profile_id.to_string());
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn app_get_window_id(window: WebviewWindow) -> String {
    window.label().to_string()
}

#[tauri::command]
pub fn app_get_window_index(app: AppHandle, window: WebviewWindow) -> u32 {
    window_registry::window_index(&app, window.label())
}

#[tauri::command]
pub fn app_get_launch_profile() -> Option<String> {
    parse_launch_profile_args(std::env::args())
}

#[tauri::command]
pub fn app_get_window_profile(app: AppHandle, window: WebviewWindow) -> Option<String> {
    Some(window_registry::get_entry(&app, window.label()).profile_id)
}

#[tauri::command]
pub fn app_new_window(app: AppHandle, window: WebviewWindow) -> String {
    let current = window_registry::get_entry(&app, window.label());
    let entry = window_registry::create_empty_entry_for_profile(&app, &current.profile_id);
    let id = entry.id;
    let _ = build_window(&app, &id);
    id
}

#[tauri::command]
pub fn app_focus_next_window(app: AppHandle, window: WebviewWindow) -> bool {
    let windows = app.webview_windows();
    if windows.len() <= 1 {
        return false;
    }
    let mut labels = windows.keys().cloned().collect::<Vec<_>>();
    labels.sort();
    let current = window.label().to_string();
    let next = labels
        .iter()
        .position(|label| label == &current)
        .map(|idx| labels[(idx + 1) % labels.len()].clone())
        .or_else(|| labels.first().cloned());
    if let Some(label) = next {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_focus();
            return true;
        }
    }
    false
}

#[tauri::command]
pub fn app_open_new_instance(app: AppHandle, profile_id: String) -> OpenNewInstanceResult {
    let _ = profile_cmd::activate_profile_id(&app, &profile_id);
    let live = window_registry::entries_for_profile(&app, &profile_id)
        .into_iter()
        .filter(|entry| app.get_webview_window(&entry.id).is_some())
        .collect::<Vec<_>>();
    if let Some(entry) = live.iter().max_by_key(|entry| entry.last_active_at) {
        if let Some(win) = app.get_webview_window(&entry.id) {
            let _ = win.set_focus();
        }
        return OpenNewInstanceResult {
            already_open: true,
            window_ids: live.into_iter().map(|entry| entry.id).collect(),
            error: None,
        };
    }

    let created = window_registry::create_entries_for_profile(&app, &profile_id);
    let mut ids = Vec::new();
    for entry in &created {
        if let Err(error) = build_window(&app, &entry.id) {
            return OpenNewInstanceResult {
                already_open: false,
                window_ids: ids,
                error: Some(error),
            };
        }
        ids.push(entry.id.clone());
    }
    OpenNewInstanceResult {
        already_open: false,
        window_ids: ids,
        error: None,
    }
}

#[tauri::command]
pub fn app_restore_active_profiles(
    app: AppHandle,
    current_profile_id: Option<String>,
) -> Vec<String> {
    {
        let mut done = active_profile_restore_done().lock().unwrap();
        if *done {
            return Vec::new();
        }
        *done = true;
    }

    let active_ids = profile_cmd::profile_get_active_ids(app.clone());
    let targets = active_profiles_to_restore(&active_ids, current_profile_id.as_deref());
    let mut restored = Vec::new();
    for profile_id in targets {
        let result = app_open_new_instance(app.clone(), profile_id);
        restored.extend(result.window_ids);
    }
    restored
}

fn badge_count_value(count: i64) -> Option<i64> {
    if count > 0 {
        Some(count)
    } else {
        None
    }
}

#[tauri::command]
pub fn app_set_dock_badge(app: AppHandle, count: i64) {
    let badge = badge_count_value(count);
    for window in app.webview_windows().values() {
        let _ = window.set_badge_count(badge);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_new_instance_serializes_camel_case() {
        let r = OpenNewInstanceResult {
            already_open: false,
            window_ids: vec!["w1".into()],
            error: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"alreadyOpen\":false"), "got: {json}");
        assert!(json.contains("\"windowIds\":[\"w1\"]"), "got: {json}");
        assert!(!json.contains("already_open"), "snake_case leaked: {json}");
    }

    #[test]
    fn badge_count_value_clears_non_positive_counts() {
        assert_eq!(badge_count_value(0), None);
        assert_eq!(badge_count_value(-1), None);
        assert_eq!(badge_count_value(42), Some(42));
    }

    #[test]
    fn parse_launch_profile_supports_equals_and_split_args() {
        assert_eq!(
            parse_launch_profile_args(["bat", "--profile=remote-1"]),
            Some("remote-1".into())
        );
        assert_eq!(
            parse_launch_profile_args(["bat", "--profile", "local-2"]),
            Some("local-2".into())
        );
        assert_eq!(parse_launch_profile_args(["bat", "--profile="]), None);
    }

    #[test]
    fn active_profiles_restore_skips_current_and_duplicates() {
        let ids = vec![
            "default".to_string(),
            "work".to_string(),
            "work".to_string(),
            "".to_string(),
            "remote".to_string(),
        ];
        assert_eq!(
            active_profiles_to_restore(&ids, Some("default")),
            vec!["work".to_string(), "remote".to_string()]
        );
        assert_eq!(
            active_profiles_to_restore(&ids, Some("work")),
            vec!["default".to_string(), "remote".to_string()]
        );
    }

    #[test]
    fn renderer_url_uses_app_url_for_dynamic_windows() {
        let url = renderer_url("index.html?detached=w1");
        match url {
            WebviewUrl::App(path) => {
                assert_eq!(path.to_string_lossy(), "index.html?detached=w1")
            }
            other => panic!("expected Tauri app URL, got {other:?}"),
        }
    }

    #[test]
    fn tauri_log_line_has_tauri_prefix() {
        let line = tauri_log_line("hello");
        assert!(line.contains(" [tauri] hello\n"));
    }
}
