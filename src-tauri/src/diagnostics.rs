//! Diagnostics commands — read/clear the native log file.
//!
//! These commands are the native-side counterpart to `src/utils/error-logger.ts`.
//! They let the feedback modal attach recent Rust/plugin logs (including updater
//! failures, tray events, mailto handler errors, etc.) when the user opts in.
//!
//! All log content has already been redacted at write time by the formatter
//! configured in `lib.rs` — these commands only read files the plugin produced.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use tauri::{AppHandle, Manager};

/// Maximum bytes callers are allowed to request in a single call.
const MAX_READ_BYTES: u64 = 256 * 1024;

fn log_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_log_dir()
        .map_err(|e| format!("app_log_dir unavailable: {}", e))
}

fn latest_log_file(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut latest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if latest.as_ref().is_none_or(|(t, _)| modified > *t) {
            latest = Some((modified, path));
        }
    }
    latest.map(|(_, p)| p)
}

/// Returns the app's log directory path so the Settings UI can link to it.
#[tauri::command]
pub fn get_log_path(app: AppHandle) -> Result<String, String> {
    let dir = log_dir(&app)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Returns up to `max_bytes` bytes (clamped to 256 KB) from the tail of the
/// latest log file. Returns an empty string if no log file exists yet.
#[tauri::command]
pub fn read_recent_logs(app: AppHandle, max_bytes: Option<u64>) -> Result<String, String> {
    let dir = log_dir(&app)?;
    let Some(path) = latest_log_file(&dir) else {
        return Ok(String::new());
    };
    let requested = max_bytes.unwrap_or(MAX_READ_BYTES).min(MAX_READ_BYTES);

    let mut file = fs::File::open(&path).map_err(|e| format!("open log: {}", e))?;
    let size = file
        .metadata()
        .map_err(|e| format!("stat log: {}", e))?
        .len();
    let start = size.saturating_sub(requested);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek log: {}", e))?;

    let mut buf = Vec::with_capacity(requested as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read log: {}", e))?;
    // If we started mid-line, discard the partial first line so callers see
    // a clean set of records.
    let text = String::from_utf8_lossy(&buf).into_owned();
    let trimmed = if start > 0 {
        text.split_once('\n').map(|(_, rest)| rest).unwrap_or(&text)
    } else {
        &text
    };
    Ok(trimmed.to_string())
}

/// Deletes every `.log` file in the app log directory. The running logger
/// will re-open a fresh file on its next write.
#[tauri::command]
pub fn clear_logs(app: AppHandle) -> Result<(), String> {
    let dir = log_dir(&app)?;
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("log") {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}
