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
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

const MAX_READ_BYTES: u64 = 512 * 1024;

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
}
