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
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_READ_BYTES: u64 = 512 * 1024;
const WATCH_DEBOUNCE: Duration = Duration::from_millis(500);
const RESOLVE_PATH_LINK_LIMIT: usize = 200;

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

const RESOLVE_TEXT_EXTS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "json", "jsonl", "css", "scss", "less", "html", "htm", "md", "mdx",
    "txt", "yml", "yaml", "toml", "xml", "svg", "sh", "bash", "zsh", "py", "rb", "go", "rs",
    "java", "c", "cpp", "h", "hpp", "cs", "csproj", "sln", "slnx", "fs", "fsproj", "vue", "svelte",
    "sql", "graphql", "log",
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

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathLinkResult {
    pub raw_path: String,
    pub path: String,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u64>,
}

struct FsWatchEntry {
    _watcher: RecommendedWatcher,
}

#[derive(Clone, Default)]
pub struct FsWatcherState {
    watchers: Arc<Mutex<HashMap<String, FsWatchEntry>>>,
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
    tauri::async_runtime::spawn_blocking(move || fs_mkdir_impl(parent_path, name))
        .await
        .unwrap_or_else(|e| PathOrError {
            error: Some(e.to_string()),
            ..Default::default()
        })
}

fn fs_mkdir_impl(parent_path: String, name: String) -> PathOrError {
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
    tauri::async_runtime::spawn_blocking(move || fs_delete_path_impl(target_path))
        .await
        .unwrap_or_else(|e| PathOrError {
            error: Some(e.to_string()),
            ..Default::default()
        })
}

fn fs_delete_path_impl(target_path: String) -> PathOrError {
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

fn fs_search_impl(dir_path: String, query: String) -> Vec<FsEntry> {
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

#[tauri::command]
pub async fn fs_search(dir_path: String, query: String) -> Vec<FsEntry> {
    tauri::async_runtime::spawn_blocking(move || fs_search_impl(dir_path, query))
        .await
        .unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedPathLink {
    cleaned: String,
    path_text: String,
    line: Option<u64>,
    column: Option<u64>,
}

fn trim_path_link(raw: &str) -> String {
    raw.trim_matches(|ch: char| {
        matches!(
            ch,
            '`' | '\'' | '"' | '(' | '<' | '[' | ')' | ',' | '.' | ';' | '>' | ']'
        )
    })
    .to_string()
}

fn parse_path_link(raw: &str) -> ParsedPathLink {
    let cleaned = trim_path_link(raw);
    let mut path_text = cleaned.clone();
    let mut line = None;
    let mut column = None;

    let parts = cleaned.split(':').collect::<Vec<_>>();
    if parts.len() >= 2 {
        let last_is_number = parts
            .last()
            .and_then(|part| part.parse::<u64>().ok())
            .is_some();
        if last_is_number {
            let last_value = parts.last().and_then(|part| part.parse::<u64>().ok());
            let previous_value = if parts.len() >= 3 {
                parts
                    .get(parts.len() - 2)
                    .and_then(|part| part.parse::<u64>().ok())
            } else {
                None
            };
            if let Some(prev) = previous_value {
                path_text = parts[..parts.len() - 2].join(":");
                line = Some(prev);
                column = last_value;
            } else if let Some(last) = last_value {
                path_text = parts[..parts.len() - 1].join(":");
                line = Some(last);
            }
        }
    }

    ParsedPathLink {
        cleaned,
        path_text,
        line,
        column,
    }
}

fn is_resolvable_text_path(path_text: &str) -> bool {
    Path::new(path_text)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_lowercase();
            RESOLVE_TEXT_EXTS.iter().any(|candidate| *candidate == ext)
        })
        .unwrap_or(false)
}

fn is_absolute_path_text(path_text: &str) -> bool {
    Path::new(path_text).is_absolute()
        || (path_text.len() >= 3
            && path_text.as_bytes()[0].is_ascii_alphabetic()
            && path_text.as_bytes()[1] == b':'
            && matches!(path_text.as_bytes()[2], b'/' | b'\\'))
}

fn resolve_path_link_candidate(
    cwd_abs: Option<&Path>,
    parsed: ParsedPathLink,
) -> Option<PathLinkResult> {
    if parsed.path_text.is_empty() || !is_resolvable_text_path(&parsed.path_text) {
        return None;
    }
    let candidate = if is_absolute_path_text(&parsed.path_text) {
        PathBuf::from(&parsed.path_text)
    } else {
        cwd_abs?.join(&parsed.path_text)
    };
    let abs = std::path::absolute(&candidate).ok()?;
    let abs_string = abs.to_string_lossy().to_string();
    if is_sensitive_path(&abs_string) {
        return None;
    }
    if !fs::metadata(&abs)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
    {
        return None;
    }
    Some(PathLinkResult {
        raw_path: parsed.cleaned,
        path: abs_string,
        exists: true,
        line: parsed.line,
        column: parsed.column,
    })
}

fn fs_resolve_path_links_impl(cwd: String, raw_paths: Vec<String>) -> Vec<PathLinkResult> {
    let cwd_abs = if cwd.trim().is_empty() {
        None
    } else {
        std::path::absolute(cwd).ok()
    };
    let mut seen = BTreeSet::new();
    let mut results = Vec::new();
    for raw in raw_paths {
        if seen.len() >= RESOLVE_PATH_LINK_LIMIT {
            break;
        }
        if raw.len() > 500 || !seen.insert(raw.clone()) {
            continue;
        }
        if let Some(result) = resolve_path_link_candidate(cwd_abs.as_deref(), parse_path_link(&raw))
        {
            results.push(result);
        }
    }
    results
}

#[tauri::command]
pub async fn fs_resolve_path_links(cwd: String, raw_paths: Vec<String>) -> Vec<PathLinkResult> {
    tauri::async_runtime::spawn_blocking(move || fs_resolve_path_links_impl(cwd, raw_paths))
        .await
        .unwrap_or_default()
}

fn remove_watcher(state: &FsWatcherState, dir_path: &str) -> bool {
    let Ok(mut guard) = state.watchers.lock() else {
        return false;
    };
    guard.remove(dir_path);
    true
}

#[tauri::command]
pub fn fs_watch(app: AppHandle, state: State<'_, FsWatcherState>, dir_path: String) -> bool {
    if dir_path.trim().is_empty() {
        return false;
    }
    if state
        .watchers
        .lock()
        .map(|guard| guard.contains_key(&dir_path))
        .unwrap_or(false)
    {
        return true;
    }
    let abs = match std::path::absolute(&dir_path) {
        Ok(path) => path,
        Err(_) => return false,
    };
    let abs_string = abs.to_string_lossy().to_string();
    if is_sensitive_path(&abs_string) {
        return false;
    }
    let key = dir_path.clone();
    let watchers = state.watchers.clone();
    let debounce = Arc::new(AtomicU64::new(0));
    let debounce_for_event = debounce.clone();
    let app_for_event = app.clone();
    let abs_for_event = abs_string.clone();
    let key_for_error = key.clone();
    let mut watcher = match RecommendedWatcher::new(
        move |event| match event {
            Ok(_) => {
                let ticket = debounce_for_event.fetch_add(1, Ordering::SeqCst) + 1;
                let debounce_check = debounce_for_event.clone();
                let app_emit = app_for_event.clone();
                let changed_path = abs_for_event.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(WATCH_DEBOUNCE);
                    if debounce_check.load(Ordering::SeqCst) == ticket {
                        let _ = app_emit.emit("fs:changed", changed_path);
                    }
                });
            }
            Err(_) => {
                if let Ok(mut guard) = watchers.lock() {
                    guard.remove(&key_for_error);
                }
            }
        },
        Config::default(),
    ) {
        Ok(watcher) => watcher,
        Err(_) => return false,
    };
    if watcher.watch(&abs, RecursiveMode::Recursive).is_err() {
        return false;
    }
    let entry = FsWatchEntry { _watcher: watcher };
    if let Ok(mut guard) = state.watchers.lock() {
        if guard.contains_key(&key) {
            true
        } else {
            guard.insert(key, entry);
            true
        }
    } else {
        false
    }
}

#[tauri::command]
pub fn fs_unwatch(state: State<'_, FsWatcherState>, dir_path: String) -> bool {
    remove_watcher(&state, &dir_path)
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
    fn parse_path_link_extracts_line_and_column() {
        assert_eq!(
            parse_path_link("`src/main.ts:12:3`,"),
            ParsedPathLink {
                cleaned: "src/main.ts:12:3".into(),
                path_text: "src/main.ts".into(),
                line: Some(12),
                column: Some(3),
            }
        );
        assert_eq!(
            parse_path_link("C:\\repo\\src\\main.ts:9"),
            ParsedPathLink {
                cleaned: "C:\\repo\\src\\main.ts:9".into(),
                path_text: "C:\\repo\\src\\main.ts".into(),
                line: Some(9),
                column: None,
            }
        );
    }

    #[test]
    fn resolve_path_links_keeps_existing_text_files_only() {
        let dir = std::env::temp_dir().join(format!("bat-path-links-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.ts"), "export const a = 1").unwrap();
        fs::write(dir.join("image.png"), "not really png").unwrap();

        let results = fs_resolve_path_links_impl(
            dir.to_string_lossy().into(),
            vec![
                "a.ts:7:2".into(),
                "a.ts:7:2".into(),
                "missing.ts".into(),
                "image.png".into(),
            ],
        );

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].raw_path, "a.ts:7:2");
        assert_eq!(results[0].line, Some(7));
        assert_eq!(results[0].column, Some(2));
        assert!(results[0].path.ends_with("a.ts"));
        let _ = fs::remove_dir_all(dir);
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
