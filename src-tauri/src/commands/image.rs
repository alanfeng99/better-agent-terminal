// image:read-as-data-url — load a local image and return a data: URL.
//
// Mirrors the Electron handler: refuses sensitive paths via path_guard,
// caps reads at 10 MiB, and infers the MIME type from the file extension
// (defaulting to image/png to match the Electron behaviour).
//
// We deliberately keep the same byte cap and same error wording so error
// surfaces feel identical to the renderer.

use crate::path_guard::is_sensitive_path;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

pub fn mime_for_extension(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

#[tauri::command]
pub async fn image_read_as_data_url(path: String) -> Result<String, CommandError> {
    let abs = match std::path::absolute(&path) {
        Ok(p) => p,
        Err(e) => return Err(CommandError { message: e.to_string() }),
    };
    if is_sensitive_path(&abs.to_string_lossy()) {
        return Err(CommandError { message: "Access denied (sensitive path)".into() });
    }
    let metadata = fs::metadata(&abs)
        .map_err(|e| CommandError { message: e.to_string() })?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(CommandError {
            message: format!("Image too large ({}KB)", metadata.len() / 1024),
        });
    }
    let bytes = fs::read(&abs).map_err(|e| CommandError { message: e.to_string() })?;
    let ext = PathBuf::from(&abs)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let mime = mime_for_extension(&ext);
    let encoded = B64.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn mime_lookup_handles_common_extensions() {
        assert_eq!(mime_for_extension("png"), "image/png");
        assert_eq!(mime_for_extension("PNG"), "image/png");
        assert_eq!(mime_for_extension("jpg"), "image/jpeg");
        assert_eq!(mime_for_extension("jpeg"), "image/jpeg");
        assert_eq!(mime_for_extension("gif"), "image/gif");
        assert_eq!(mime_for_extension("webp"), "image/webp");
        // Unknown extensions fall back to image/png so the renderer still
        // gets something it can drop into <img src=…>.
        assert_eq!(mime_for_extension("bmp"), "image/png");
        assert_eq!(mime_for_extension(""), "image/png");
    }

    #[test]
    fn small_png_round_trips_to_data_url() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("bat-img-{}.png", std::process::id()));
        // Magic-only PNG header — we only care about the bytes, not the
        // image being valid.
        let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
        {
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(&bytes).unwrap();
        }
        let url = tauri::async_runtime::block_on(image_read_as_data_url(
            path.to_string_lossy().into(),
        ))
        .unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        // Round-trip check: payload after the prefix should decode back to
        // the source bytes.
        let payload = url.strip_prefix("data:image/png;base64,").unwrap();
        let decoded = B64.decode(payload).unwrap();
        assert_eq!(decoded, bytes);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn images_above_size_cap_are_refused() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("bat-img-large-{}.png", std::process::id()));
        {
            let mut f = fs::File::create(&path).unwrap();
            // 10 MiB + 1 byte: just past the cap.
            let chunk = vec![0u8; 1024 * 1024];
            for _ in 0..10 {
                f.write_all(&chunk).unwrap();
            }
            f.write_all(&[0u8]).unwrap();
        }
        let err = tauri::async_runtime::block_on(image_read_as_data_url(
            path.to_string_lossy().into(),
        ))
        .err()
        .unwrap();
        assert!(err.message.starts_with("Image too large"));
        let _ = fs::remove_file(path);
    }
}
