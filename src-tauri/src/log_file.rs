use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const DEFAULT_MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    append_line_with_limit(path, line, DEFAULT_MAX_LOG_BYTES)
}

fn append_line_with_limit(path: &Path, line: &str, max_bytes: u64) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    rotate_if_large(path, max_bytes)?;
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())
}

fn rotate_if_large(path: &Path, max_bytes: u64) -> std::io::Result<()> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() <= max_bytes {
        return Ok(());
    }
    let previous = previous_log_path(path);
    let _ = fs::remove_file(&previous);
    fs::rename(path, previous)
}

fn previous_log_path(path: &Path) -> PathBuf {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return path.with_file_name("log.prev");
    };
    if let Some(stem) = file_name.strip_suffix(".log") {
        path.with_file_name(format!("{stem}.prev.log"))
    } else {
        path.with_file_name(format!("{file_name}.prev"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_log_lines() {
        let path =
            std::env::temp_dir().join(format!("bat-log-file-{}-append.log", std::process::id()));
        let _ = fs::remove_file(&path);

        append_line_with_limit(&path, "one\n", 1024).unwrap();
        append_line_with_limit(&path, "two\n", 1024).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rotates_oversized_log_before_append() {
        let path =
            std::env::temp_dir().join(format!("bat-log-file-{}-rotate.log", std::process::id()));
        let previous = previous_log_path(&path);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&previous);
        fs::write(&path, "123456").unwrap();

        append_line_with_limit(&path, "new\n", 5).unwrap();

        assert_eq!(fs::read_to_string(&previous).unwrap(), "123456");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(previous);
    }

    #[test]
    fn previous_log_path_inserts_prev_before_log_extension() {
        let path = PathBuf::from("debug.log");
        assert_eq!(previous_log_path(&path), PathBuf::from("debug.prev.log"));
    }
}
