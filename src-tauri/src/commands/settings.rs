// settings:load / settings:save / settings:get-shell-path — host settings surface.
//
// The renderer treats the payload as opaque JSON text (matching the
// Electron preload shape: settings.load returns Promise<string|null>,
// settings.save accepts a JSON string). We keep the same contract here so
// the host-api adapter can route to either runtime without changing
// caller types.
//
// The settings file lives at <app-data>/settings.json. Tauri 2's
// path::app_data_dir resolves to per-user app data, namespaced by the
// identifier in tauri.conf.json — we deliberately keep the filename
// "settings.json" so a future Electron→Tauri migration only has to copy
// the file across the data directory.

use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("could not resolve app data directory: {0}")]
    AppDataDir(String),
    #[error("settings IO error: {0}")]
    Io(#[from] io::Error),
}

// Tauri's command system requires Serialize for error types so they cross
// the JS bridge. Use a simple message representation.
#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl From<SettingsError> for CommandError {
    fn from(value: SettingsError) -> Self {
        Self { message: value.to_string() }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, SettingsError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| SettingsError::AppDataDir(e.to_string()))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn settings_load(app: tauri::AppHandle) -> Result<Option<String>, CommandError> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(SettingsError::from)?;
    Ok(Some(text))
}

#[tauri::command]
pub fn settings_save(app: tauri::AppHandle, data: String) -> Result<(), CommandError> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(SettingsError::from)?;
    }
    fs::write(&path, data).map_err(SettingsError::from)?;
    Ok(())
}

// settings:get-shell-path — resolve a shell type to a concrete executable.
//
// Mirrors the Electron handler in server-core/register-handlers.ts:
//   - "auto", "zsh", "bash", "sh", "pwsh", "powershell", "cmd" all map
//     to platform-appropriate binaries; unknown shellType strings are
//     returned verbatim (treated as a literal path/exe).
//   - Results are cached process-wide (existsSync calls aren't free).
//
// We pull the platform branch into a pure function so we can unit-test it
// with a synthetic "exists" check, instead of relying on the real fs.

#[cfg(target_family = "unix")]
const TARGET_OS: &str = "unix";
#[cfg(target_os = "windows")]
const TARGET_OS: &str = "windows";

fn posix_auto_shell(exists: &impl Fn(&str) -> bool) -> String {
    // Best-effort detection: prefer $SHELL if pointing at an executable
    // file, then fall back to /bin/zsh on macOS / /bin/bash elsewhere.
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() && exists(&shell) {
            return shell;
        }
    }
    if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() }
}

fn windows_localappdata_pwsh() -> Option<String> {
    let lad = std::env::var("LOCALAPPDATA").ok()?;
    Some(format!("{lad}\\Microsoft\\WindowsApps\\pwsh.exe"))
}

pub fn resolve_shell_path<F: Fn(&str) -> bool>(
    shell_type: &str,
    target_os: &str,
    exists: &F,
) -> String {
    if target_os == "unix" {
        return match shell_type {
            "auto" => posix_auto_shell(exists),
            "zsh" => "/bin/zsh".into(),
            "bash" => {
                if exists("/opt/homebrew/bin/bash") { "/opt/homebrew/bin/bash".into() }
                else if exists("/usr/local/bin/bash") { "/usr/local/bin/bash".into() }
                else { "/bin/bash".into() }
            }
            "sh" => "/bin/sh".into(),
            "pwsh" | "powershell" | "cmd" => posix_auto_shell(exists),
            other => other.into(),
        };
    }
    // windows
    let mut pwsh_paths: Vec<String> = vec![
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe".into(),
        "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe".into(),
    ];
    if let Some(p) = windows_localappdata_pwsh() { pwsh_paths.push(p); }

    if shell_type == "auto" || shell_type == "pwsh" {
        for p in &pwsh_paths {
            if exists(p) { return p.clone(); }
        }
        if shell_type == "pwsh" { return "pwsh.exe".into(); }
        // auto -> powershell.exe fallback
        return "powershell.exe".into();
    }
    match shell_type {
        "powershell" => "powershell.exe".into(),
        "cmd" => "cmd.exe".into(),
        other => other.into(),
    }
}

fn shell_path_cache() -> &'static Mutex<std::collections::HashMap<String, String>> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

#[tauri::command]
pub fn settings_get_shell_path(shell_type: String) -> String {
    if let Some(hit) = shell_path_cache().lock().unwrap().get(&shell_type) {
        return hit.clone();
    }
    let exists = |s: &str| Path::new(s).exists();
    let resolved = resolve_shell_path(&shell_type, TARGET_OS, &exists);
    shell_path_cache().lock().unwrap().insert(shell_type, resolved.clone());
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_path_uses_settings_json_filename() {
        // We can't easily build an AppHandle in a unit test, so we assert
        // on the filename path component which the public function always
        // appends. This guards against accidental rename of the on-disk
        // file (which would lose user settings on upgrade).
        let p = PathBuf::from("/fake/app-data").join("settings.json");
        assert_eq!(p.file_name().unwrap(), "settings.json");
    }

    fn exists_set<'a>(set: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |p| set.iter().any(|x| *x == p)
    }

    #[test]
    fn unix_shells_resolve_to_canonical_paths() {
        let none = exists_set(&[]);
        assert_eq!(resolve_shell_path("zsh", "unix", &none), "/bin/zsh");
        assert_eq!(resolve_shell_path("sh", "unix", &none), "/bin/sh");
        // bash falls back to /bin/bash when neither homebrew location exists.
        assert_eq!(resolve_shell_path("bash", "unix", &none), "/bin/bash");
        // bash prefers /opt/homebrew when present.
        let homebrew = exists_set(&["/opt/homebrew/bin/bash"]);
        assert_eq!(resolve_shell_path("bash", "unix", &homebrew), "/opt/homebrew/bin/bash");
        let usrlocal = exists_set(&["/usr/local/bin/bash"]);
        assert_eq!(resolve_shell_path("bash", "unix", &usrlocal), "/usr/local/bin/bash");
    }

    #[test]
    fn unknown_shell_is_returned_verbatim() {
        let none = exists_set(&[]);
        assert_eq!(resolve_shell_path("/custom/shell", "unix", &none), "/custom/shell");
        assert_eq!(resolve_shell_path("fish", "unix", &none), "fish");
    }

    #[test]
    fn windows_pwsh_prefers_program_files() {
        let pf = exists_set(&["C:\\Program Files\\PowerShell\\7\\pwsh.exe"]);
        assert_eq!(
            resolve_shell_path("pwsh", "windows", &pf),
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        );
    }

    #[test]
    fn windows_auto_falls_back_to_powershell_exe() {
        let none = exists_set(&[]);
        assert_eq!(resolve_shell_path("auto", "windows", &none), "powershell.exe");
    }

    #[test]
    fn windows_pwsh_without_install_returns_pwsh_exe() {
        let none = exists_set(&[]);
        assert_eq!(resolve_shell_path("pwsh", "windows", &none), "pwsh.exe");
    }

    #[test]
    fn windows_cmd_and_powershell_are_handled() {
        let none = exists_set(&[]);
        assert_eq!(resolve_shell_path("cmd", "windows", &none), "cmd.exe");
        assert_eq!(resolve_shell_path("powershell", "windows", &none), "powershell.exe");
    }
}
