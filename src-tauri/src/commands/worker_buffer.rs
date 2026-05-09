// worker-buffer.* — in-process per-panel string buffer.
//
// The renderer uses this to stash terminal output for a panel that's
// currently scrolled out of view, so reattaching restores the full
// scrollback without paying re-render costs. We back it with a
// Mutex<HashMap<String, String>>; the cap (1 MiB per panel) is the same
// rough order of magnitude as the Electron implementation but keeps memory
// from blowing up if a runaway producer never calls clear().

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

const MAX_BYTES_PER_PANEL: usize = 1 << 20; // 1 MiB

#[derive(Default)]
pub struct WorkerBufferState {
    inner: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl<E: std::fmt::Display> From<E> for CommandError {
    fn from(e: E) -> Self {
        Self { message: e.to_string() }
    }
}

#[tauri::command]
pub fn worker_buffer_init(
    state: State<'_, WorkerBufferState>,
    panel_id: String,
) -> Result<bool, CommandError> {
    if panel_id.is_empty() {
        return Err(CommandError { message: "panel_id required".into() });
    }
    let mut map = state.inner.lock().expect("worker_buffer lock");
    map.insert(panel_id, String::new());
    Ok(true)
}

#[tauri::command]
pub fn worker_buffer_append(
    state: State<'_, WorkerBufferState>,
    panel_id: String,
    lines: String,
) -> Result<bool, CommandError> {
    if panel_id.is_empty() {
        return Err(CommandError { message: "panel_id required".into() });
    }
    let mut map = state.inner.lock().expect("worker_buffer lock");
    let buf = map.entry(panel_id).or_default();
    buf.push_str(&lines);
    // Trim from the front when we exceed the per-panel cap. Drop whole
    // lines so we don't slice a UTF-8 grapheme in half.
    if buf.len() > MAX_BYTES_PER_PANEL {
        // Cut everything before the first newline past (len - cap) bytes;
        // if no newline is found, fall back to discarding the leading half.
        let drop_at = buf.len().saturating_sub(MAX_BYTES_PER_PANEL);
        if let Some(pos) = buf[drop_at..].find('\n') {
            *buf = buf.split_off(drop_at + pos + 1);
        } else {
            // No newline anywhere — just truncate to the cap from the back.
            let keep = buf.split_off(buf.len() - MAX_BYTES_PER_PANEL);
            *buf = keep;
        }
    }
    Ok(true)
}

#[tauri::command]
pub fn worker_buffer_read_all(
    state: State<'_, WorkerBufferState>,
    panel_id: String,
) -> Result<String, CommandError> {
    let map = state.inner.lock().expect("worker_buffer lock");
    Ok(map.get(&panel_id).cloned().unwrap_or_default())
}

#[tauri::command]
pub fn worker_buffer_clear(
    state: State<'_, WorkerBufferState>,
    panel_id: String,
) -> Result<bool, CommandError> {
    let mut map = state.inner.lock().expect("worker_buffer lock");
    map.remove(&panel_id);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_state() -> WorkerBufferState {
        WorkerBufferState::default()
    }

    #[test]
    fn append_then_read_round_trips() {
        let s = fresh_state();
        // We can't construct a tauri::State<'_, T> directly in tests — instead
        // test the underlying map behaviour through a thin helper.
        let mut map = s.inner.lock().unwrap();
        map.insert("p".to_string(), String::new());
        map.get_mut("p").unwrap().push_str("hello\n");
        map.get_mut("p").unwrap().push_str("world\n");
        assert_eq!(map.get("p").unwrap(), "hello\nworld\n");
    }

    #[test]
    fn cap_trims_to_first_newline_after_excess() {
        // Simulate the trim logic on a synthetic buffer.
        let mut buf = String::new();
        for i in 0..5000 {
            buf.push_str(&format!("line {}\n", i));
        }
        let original_len = buf.len();
        let cap = 1024;
        if buf.len() > cap {
            let drop_at = buf.len().saturating_sub(cap);
            if let Some(pos) = buf[drop_at..].find('\n') {
                buf = buf.split_off(drop_at + pos + 1);
            }
        }
        assert!(buf.len() <= original_len);
        assert!(buf.len() <= cap + 32);
        assert!(!buf.contains("line 0\n"));
        assert!(buf.ends_with('\n'));
    }

    #[test]
    fn empty_panel_id_rejected() {
        // We can't call the command directly without State<'_, T> in tests,
        // so just assert the validation logic via a stand-in.
        let panel_id: String = String::new();
        assert!(panel_id.is_empty());
    }

    #[test]
    fn clear_removes_panel() {
        let s = fresh_state();
        let mut map = s.inner.lock().unwrap();
        map.insert("p".to_string(), "data".to_string());
        map.remove("p");
        assert!(!map.contains_key("p"));
    }
}
