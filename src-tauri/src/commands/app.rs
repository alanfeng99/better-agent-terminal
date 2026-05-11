// app:* — Tauri window/profile shell.
//
// Electron owns multi-window behaviour in its main process. The Tauri port
// keeps the renderer-facing contract intact, but the window registry and local
// profile restore now live in Rust so profile windows do not need the Node
// sidecar.

use crate::window_registry;
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct OpenNewInstanceResult {
    #[serde(rename = "alreadyOpen")]
    pub already_open: bool,
    #[serde(rename = "windowIds", skip_serializing_if = "Vec::is_empty")]
    pub window_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn build_window(app: &AppHandle, window_id: &str) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(window_id) {
        let _ = win.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, window_id, WebviewUrl::App("index.html".into()))
        .title("Better Agent Terminal")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .build()
        .map(|_| ())
        .map_err(|err| err.to_string())
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
    None
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
pub fn app_set_dock_badge(_count: i64) {
    // Tauri tray badge needs a tray + per-platform icon work.
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
    fn set_dock_badge_is_a_noop() {
        app_set_dock_badge(0);
        app_set_dock_badge(42);
        app_set_dock_badge(-1);
    }
}
