use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const TAURI_DATA_DIR_ENV: &str = "BAT_TAURI_DATA_DIR";

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var(TAURI_DATA_DIR_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    app.path().app_data_dir().map_err(|err| err.to_string())
}

pub fn app_data_dir_opt(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).ok()
}
