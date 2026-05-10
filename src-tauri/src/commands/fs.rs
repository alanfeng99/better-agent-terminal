// fs:read-file — first port of the filesystem surface.
//
// Mirrors the Electron contract from electron/preload.ts: takes an
// arbitrary path string and returns one of three shapes:
//   { content }  — utf-8 file contents (for files <= 512 KiB)
//   { error }    — sensitive path or read failure
//   { error, size } — file exceeds the 512 KiB limit
//
// We keep the same payload and same byte cap so renderer call sites don't
// have to branch on host kind. The deny-list logic lives in
// crate::path_guard so we can unit-test it independently of Tauri.

use crate::path_guard::is_sensitive_path;
use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, BridgeError, SidecarState};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;
use tauri::{AppHandle, State};

const MAX_READ_BYTES: u64 = 512 * 1024;
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(15);

// Directory names we skip in listings/search — these are typically build
// outputs or VCS internals, not anything the user wants to wade through.
const IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    "dist",
    "dist-electron",
    "dist-tauri",
    ".cache",
    "__pycache__",
    ".DS_Store",
    "release",
    "target",
];

fn is_ignored_name(name: &str) -> bool {
    IGNORED_DIR_NAMES.iter().any(|n| *n == name)
}

fn home_string(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().home_dir().ok()
}

fn expand_tilde(p: &str, home: &Path) -> PathBuf {
    if p == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return home.join(rest);
    }
    PathBuf::from(p)
}

#[derive(Debug, Serialize, Default)]
pub struct FsReadResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> FsReadResult {
    let abs = match PathBuf::from(&path).canonicalize() {
        // canonicalize fails for non-existent paths; fall back to a
        // best-effort absolute resolution against cwd so the deny-list
        // still gets to see a comparable shape.
        Ok(p) => p,
        Err(_) => match std::path::absolute(&path) {
            Ok(p) => p,
            Err(_) => PathBuf::from(&path),
        },
    };
    let abs_str = abs.to_string_lossy().to_string();
    if is_sensitive_path(&abs_str) {
        return FsReadResult {
            error: Some("Access denied (sensitive path)".into()),
            ..Default::default()
        };
    }
    let metadata = match fs::metadata(&abs) {
        Ok(m) => m,
        Err(_) => {
            return FsReadResult {
                error: Some("Failed to read file".into()),
                ..Default::default()
            };
        }
    };
    if metadata.len() > MAX_READ_BYTES {
        return FsReadResult {
            error: Some("File too large".into()),
            size: Some(metadata.len()),
            ..Default::default()
        };
    }
    match fs::read_to_string(&abs) {
        Ok(content) => FsReadResult {
            content: Some(content),
            ..Default::default()
        },
        Err(_) => FsReadResult {
            error: Some("Failed to read file".into()),
            ..Default::default()
        },
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

fn entry_sort_key(a: &FsEntry, b: &FsEntry) -> std::cmp::Ordering {
    if a.is_directory != b.is_directory {
        // directories first
        return if a.is_directory {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
    }
    a.name.to_lowercase().cmp(&b.name.to_lowercase())
}

#[tauri::command]
pub fn fs_home(app: tauri::AppHandle) -> String {
    home_string(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| String::from("/"))
}

#[tauri::command]
pub async fn fs_readdir(dir_path: String) -> Vec<FsEntry> {
    tauri::async_runtime::spawn_blocking(move || fs_readdir_impl(dir_path))
        .await
        .unwrap_or_default()
}

fn fs_readdir_impl(dir_path: String) -> Vec<FsEntry> {
    let abs = match std::path::absolute(&dir_path) {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    let abs_str = abs.to_string_lossy().to_string();
    if is_sensitive_path(&abs_str) {
        return vec![];
    }
    let read = match fs::read_dir(&abs) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let mut out: Vec<FsEntry> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue;
        }
        let path = entry.path();
        let path_str = path.to_string_lossy().to_string();
        if is_sensitive_path(&path_str) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(FsEntry {
            name,
            path: path_str,
            is_directory: is_dir,
        });
    }
    out.sort_by(entry_sort_key);
    out
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirsItem {
    pub name: String,
    pub path: String,
}

// list-dirs is a tagged union { current, parent, entries } | { error }.
// We model the success and error variants as two structs sharing
// Option fields and serialize via skip_serializing_if so the JS side sees
// exactly the Electron shape.
#[derive(Debug, Serialize, Default)]
pub struct ListDirsResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    // null means no parent (we're at root). The Electron handler emits
    // `null` literally rather than omitting the field, so we serialize the
    // outer Option<...> as null when we're at the root, and skip it
    // entirely when an error happened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<ListDirsItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn fs_list_dirs(
    app: tauri::AppHandle,
    dir_path: String,
    include_hidden: bool,
) -> ListDirsResult {
    let home = home_string(&app).unwrap_or_else(|| PathBuf::from("/"));
    tauri::async_runtime::spawn_blocking(move || fs_list_dirs_impl(home, dir_path, include_hidden))
        .await
        .unwrap_or_else(|e| ListDirsResult {
            error: Some(format!("list dirs task failed: {e}")),
            ..Default::default()
        })
}

fn fs_list_dirs_impl(home: PathBuf, dir_path: String, include_hidden: bool) -> ListDirsResult {
    let expanded = expand_tilde(&dir_path, &home);
    let abs = match std::path::absolute(&expanded) {
        Ok(p) => p,
        Err(e) => {
            return ListDirsResult {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };
    if is_sensitive_path(&abs.to_string_lossy()) {
        return ListDirsResult {
            error: Some("Access denied (sensitive path)".into()),
            ..Default::default()
        };
    }
    let read = match fs::read_dir(&abs) {
        Ok(r) => r,
        Err(e) => {
            return ListDirsResult {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };
    let mut entries: Vec<ListDirsItem> = Vec::new();
    for entry in read.flatten() {
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let p = entry.path();
        if is_sensitive_path(&p.to_string_lossy()) {
            continue;
        }
        entries.push(ListDirsItem {
            name,
            path: p.to_string_lossy().to_string(),
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let parent = abs
        .parent()
        .filter(|p| p.as_os_str() != abs.as_os_str())
        .map(|p| p.to_string_lossy().to_string());
    ListDirsResult {
        current: Some(abs.to_string_lossy().to_string()),
        // Wrap in Some(Option) so the field always serializes (as
        // string-or-null) when we're on the success branch.
        parent: Some(parent),
        entries: Some(entries),
        error: None,
    }
}

#[derive(Debug, Serialize, Default)]
pub struct PathOrError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn validate_dir_name(name: &str) -> Result<(), &'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed == "."
        || trimmed == ".."
    {
        return Err("Invalid folder name");
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_mkdir(parent_path: String, name: String) -> PathOrError {
    let trimmed = name.trim();
    if let Err(msg) = validate_dir_name(&name) {
        return PathOrError {
            error: Some(msg.into()),
            ..Default::default()
        };
    }
    let parent_abs = match std::path::absolute(&parent_path) {
        Ok(p) => p,
        Err(e) => {
            return PathOrError {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };
    if is_sensitive_path(&parent_abs.to_string_lossy()) {
        return PathOrError {
            error: Some("Access denied (sensitive path)".into()),
            ..Default::default()
        };
    }
    let target = parent_abs.join(trimmed);
    match fs::create_dir(&target) {
        Ok(_) => PathOrError {
            path: Some(target.to_string_lossy().to_string()),
            error: None,
        },
        Err(e) => PathOrError {
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

#[tauri::command]
pub async fn fs_delete_path(target_path: String) -> PathOrError {
    let abs = match std::path::absolute(&target_path) {
        Ok(p) => p,
        Err(e) => {
            return PathOrError {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };
    if is_sensitive_path(&abs.to_string_lossy()) {
        return PathOrError {
            error: Some("Access denied (sensitive path)".into()),
            ..Default::default()
        };
    }
    let metadata = match fs::symlink_metadata(&abs) {
        Ok(m) => m,
        Err(e) => {
            return PathOrError {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };
    if !metadata.is_dir() {
        return PathOrError {
            error: Some("Only directories can be deleted here".into()),
            ..Default::default()
        };
    }
    match fs::remove_dir_all(&abs) {
        Ok(_) => PathOrError {
            path: Some(abs.to_string_lossy().to_string()),
            error: None,
        },
        Err(e) => PathOrError {
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickLocation {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[cfg(target_os = "windows")]
fn windows_logical_drive_roots() -> Vec<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLogicalDrives() -> u32;
    }

    let mask = unsafe { GetLogicalDrives() };
    let mut roots = Vec::new();
    for idx in 0..26 {
        if (mask & (1 << idx)) != 0 {
            let letter = (b'A' + idx as u8) as char;
            roots.push(format!("{letter}:\\"));
        }
    }
    roots
}

#[tauri::command]
pub async fn fs_quick_locations(app: tauri::AppHandle) -> Vec<QuickLocation> {
    let home = home_string(&app);
    tauri::async_runtime::spawn_blocking(move || fs_quick_locations_impl(home))
        .await
        .unwrap_or_default()
}

fn fs_quick_locations_impl(home: Option<PathBuf>) -> Vec<QuickLocation> {
    let mut out: Vec<QuickLocation> = Vec::new();
    if let Some(home) = home {
        out.push(QuickLocation {
            name: "Home".into(),
            path: home.to_string_lossy().to_string(),
            kind: "home".into(),
        });
    }
    if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        for root in windows_logical_drive_roots() {
            let name = root.trim_end_matches('\\').to_string();
            out.push(QuickLocation {
                name,
                path: root,
                kind: "drive".into(),
            });
        }
    } else {
        out.push(QuickLocation {
            name: "/".into(),
            path: "/".into(),
            kind: "root".into(),
        });
        if cfg!(target_os = "macos") {
            if let Ok(read) = fs::read_dir("/Volumes") {
                for entry in read.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let p = entry.path();
                    let is_dir_or_link = entry
                        .file_type()
                        .map(|t| t.is_dir() || t.is_symlink())
                        .unwrap_or(false);
                    if is_dir_or_link {
                        out.push(QuickLocation {
                            name,
                            path: p.to_string_lossy().to_string(),
                            kind: "volume".into(),
                        });
                    }
                }
            }
        }
    }
    out
}

const SEARCH_MAX_DEPTH: usize = 8;
const SEARCH_MAX_RESULTS: usize = 100;

fn search_walk(dir: &Path, lower_query: &str, depth: usize, results: &mut Vec<FsEntry>) {
    if depth > SEARCH_MAX_DEPTH || results.len() >= SEARCH_MAX_RESULTS {
        return;
    }
    if is_sensitive_path(&dir.to_string_lossy()) {
        return;
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        if results.len() >= SEARCH_MAX_RESULTS {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue;
        }
        let p = entry.path();
        let p_str = p.to_string_lossy().to_string();
        if is_sensitive_path(&p_str) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if name.to_lowercase().contains(lower_query) {
            results.push(FsEntry {
                name: name.clone(),
                path: p_str,
                is_directory: is_dir,
            });
        }
        if is_dir {
            search_walk(&p, lower_query, depth + 1, results);
        }
    }
}

#[tauri::command]
pub async fn fs_search(dir_path: String, query: String) -> Vec<FsEntry> {
    let abs = match std::path::absolute(&dir_path) {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    let mut results: Vec<FsEntry> = Vec::new();
    let lower = query.to_lowercase();
    search_walk(&abs, &lower, 0, &mut results);
    results.sort_by(entry_sort_key);
    results
}

fn call_sidecar_fs(
    app: &AppHandle,
    state: &SidecarState,
    method: &str,
    params: Value,
) -> Result<Value, BridgeError> {
    let cfg = resolve_spawn_config(app)?;
    let sink = app_handle_emit_sink(app.clone());
    state.call_with_emit(&cfg, Some(sink), method, params, SIDECAR_TIMEOUT)
}

#[tauri::command]
pub fn fs_resolve_path_links(
    app: AppHandle,
    state: State<'_, SidecarState>,
    cwd: String,
    raw_paths: Vec<String>,
) -> Result<Value, BridgeError> {
    call_sidecar_fs(
        &app,
        &state,
        "fs.resolvePathLinks",
        json!({ "cwd": cwd, "rawPaths": raw_paths }),
    )
}

#[tauri::command]
pub fn fs_watch(
    app: AppHandle,
    state: State<'_, SidecarState>,
    dir_path: String,
) -> Result<Value, BridgeError> {
    call_sidecar_fs(&app, &state, "fs.watch", json!({ "dirPath": dir_path }))
}

#[tauri::command]
pub fn fs_unwatch(
    app: AppHandle,
    state: State<'_, SidecarState>,
    dir_path: String,
) -> Result<Value, BridgeError> {
    call_sidecar_fs(&app, &state, "fs.unwatch", json!({ "dirPath": dir_path }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_small_utf8_file() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("bat-fs-{}.txt", std::process::id()));
        {
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(b"hello world").unwrap();
        }
        let result = tauri::async_runtime::block_on(fs_read_file(path.to_string_lossy().into()));
        assert_eq!(result.content.as_deref(), Some("hello world"));
        assert!(result.error.is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_files_above_size_cap() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("bat-fs-large-{}.bin", std::process::id()));
        {
            let mut f = fs::File::create(&path).unwrap();
            // 513 KiB — one byte past the cap.
            let chunk = vec![b'x'; 1024];
            for _ in 0..513 {
                f.write_all(&chunk).unwrap();
            }
        }
        let result = tauri::async_runtime::block_on(fs_read_file(path.to_string_lossy().into()));
        assert!(result.content.is_none());
        assert_eq!(result.error.as_deref(), Some("File too large"));
        assert_eq!(result.size, Some(513 * 1024));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_nonexistent_paths() {
        let result =
            tauri::async_runtime::block_on(fs_read_file("/this/path/does/not/exist/xyz".into()));
        assert!(result.content.is_none());
        assert_eq!(result.error.as_deref(), Some("Failed to read file"));
    }

    #[test]
    fn ignored_names_are_filtered() {
        for name in ["node_modules", ".git", "dist", "target"] {
            assert!(is_ignored_name(name), "{name} should be ignored");
        }
        assert!(!is_ignored_name("src"));
        assert!(!is_ignored_name("README.md"));
    }

    #[test]
    fn dir_name_validation_rejects_separators_and_dots() {
        assert!(validate_dir_name("foo").is_ok());
        assert!(validate_dir_name("foo bar").is_ok());
        assert!(validate_dir_name("").is_err());
        assert!(validate_dir_name("   ").is_err());
        assert!(validate_dir_name(".").is_err());
        assert!(validate_dir_name("..").is_err());
        assert!(validate_dir_name("a/b").is_err());
        assert!(validate_dir_name("a\\b").is_err());
    }

    #[test]
    fn tilde_expansion_handles_root_and_subpath() {
        let home = Path::new("/home/me");
        assert_eq!(expand_tilde("~", home), PathBuf::from("/home/me"));
        assert_eq!(expand_tilde("~/docs", home), PathBuf::from("/home/me/docs"));
        assert_eq!(
            expand_tilde("/etc/hosts", home),
            PathBuf::from("/etc/hosts")
        );
        // A literal "~user" form should pass through; we only strip "~" or "~/".
        assert_eq!(expand_tilde("~user", home), PathBuf::from("~user"));
    }

    #[test]
    fn entry_sort_puts_directories_first() {
        let mut entries = vec![
            FsEntry {
                name: "zfile".into(),
                path: "/a/zfile".into(),
                is_directory: false,
            },
            FsEntry {
                name: "ADir".into(),
                path: "/a/ADir".into(),
                is_directory: true,
            },
            FsEntry {
                name: "afile".into(),
                path: "/a/afile".into(),
                is_directory: false,
            },
            FsEntry {
                name: "bdir".into(),
                path: "/a/bdir".into(),
                is_directory: true,
            },
        ];
        entries.sort_by(entry_sort_key);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Directories first (sorted case-insensitively), then files alphabetical.
        assert_eq!(names, vec!["ADir", "bdir", "afile", "zfile"]);
    }

    #[test]
    fn readdir_skips_ignored_subdirs() {
        let dir = std::env::temp_dir().join(format!("bat-readdir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("README.md"), b"hi").unwrap();
        let result = tauri::async_runtime::block_on(fs_readdir(dir.to_string_lossy().into()));
        let names: Vec<&str> = result.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"src"));
        assert!(names.contains(&"README.md"));
        assert!(!names.contains(&"node_modules"));
        assert!(!names.contains(&".git"));
        // src is a directory, README.md is a file → src first.
        assert_eq!(names[0], "src");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_dirs_impl_filters_and_expands_home() {
        let base = std::env::temp_dir().join(format!("bat-list-dirs-{}", std::process::id()));
        let home = base.join("home");
        let docs = home.join("docs");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(docs.join("Visible")).unwrap();
        fs::create_dir_all(docs.join(".hidden")).unwrap();
        fs::write(docs.join("file.txt"), b"hi").unwrap();

        let visible = fs_list_dirs_impl(home.clone(), "~/docs".into(), false);
        let names: Vec<&str> = visible
            .entries
            .as_ref()
            .unwrap()
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        let docs_str = docs.to_string_lossy().to_string();
        assert_eq!(visible.current.as_deref(), Some(docs_str.as_str()));
        assert!(names.contains(&"Visible"));
        assert!(!names.contains(&".hidden"));
        assert!(!names.contains(&"file.txt"));

        let with_hidden = fs_list_dirs_impl(home, docs.to_string_lossy().into(), true);
        let hidden_names: Vec<&str> = with_hidden
            .entries
            .as_ref()
            .unwrap()
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert!(hidden_names.contains(&".hidden"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn quick_locations_impl_includes_home() {
        let home = PathBuf::from("/tmp/bat-home");
        let locations = fs_quick_locations_impl(Some(home.clone()));
        assert_eq!(locations[0].name, "Home");
        assert_eq!(locations[0].path, home.to_string_lossy().to_string());
        assert_eq!(locations[0].kind, "home");
    }

    #[test]
    fn search_respects_max_results_and_depth() {
        let dir = std::env::temp_dir().join(format!("bat-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // 3 matching files at the top level.
        for n in 0..3 {
            fs::write(dir.join(format!("hello-{n}.txt")), b"x").unwrap();
        }
        // Plus a deeply nested matching file (still within depth 8).
        let nested = dir.join("a/b/c/hello-deep.txt");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, b"x").unwrap();
        let result =
            tauri::async_runtime::block_on(fs_search(dir.to_string_lossy().into(), "hello".into()));
        let names: Vec<&str> = result.iter().map(|e| e.name.as_str()).collect();
        assert!(names.iter().any(|n| n.contains("hello-deep.txt")));
        assert!(result.len() >= 4);
        assert!(result.len() <= SEARCH_MAX_RESULTS);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mkdir_rejects_invalid_names() {
        let parent = std::env::temp_dir();
        let r =
            tauri::async_runtime::block_on(fs_mkdir(parent.to_string_lossy().into(), "..".into()));
        assert_eq!(r.error.as_deref(), Some("Invalid folder name"));
        let r =
            tauri::async_runtime::block_on(fs_mkdir(parent.to_string_lossy().into(), "a/b".into()));
        assert_eq!(r.error.as_deref(), Some("Invalid folder name"));
    }

    #[test]
    fn delete_path_only_targets_directories() {
        let dir = std::env::temp_dir().join(format!("bat-delete-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, b"x").unwrap();
        // File deletion should be refused.
        let r = tauri::async_runtime::block_on(fs_delete_path(file.to_string_lossy().into()));
        assert_eq!(
            r.error.as_deref(),
            Some("Only directories can be deleted here")
        );
        // Directory deletion succeeds.
        let r = tauri::async_runtime::block_on(fs_delete_path(dir.to_string_lossy().into()));
        assert!(r.error.is_none());
        assert_eq!(r.path.as_deref(), Some(dir.to_string_lossy().as_ref()));
    }
}
