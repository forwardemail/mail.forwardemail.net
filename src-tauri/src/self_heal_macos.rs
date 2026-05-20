//! Self-heal for users upgrading from broken 0.10.17–0.10.21 macOS bundles.
//!
//! Background: the aps-environment entitlement in those releases caused
//! macOS to reject the signed bundles at exec time. Users who downloaded
//! and ran the broken DMGs left a now-cached `Forward Email.app` in
//! `~/Downloads/` (or wherever they extracted the DMG). macOS's
//! LaunchServices registered that path for the bundle identifier and
//! continues to route launches there even after the user installs a
//! working 0.10.22 build into `/Applications/`. Users see the same
//! "the application can't be opened" error indefinitely.
//!
//! This module runs at app startup (macOS only) to:
//!   1. Re-register every .app with LaunchServices (`lsregister -kill -r`)
//!      so the OS forgets stale path bindings. Non-destructive.
//!   2. Scan user-writable directories for other `Forward Email.app`
//!      bundles that match our bundle identifier and aren't the running
//!      binary itself.
//!   3. Expose two Tauri commands so the frontend can prompt the user
//!      and, on consent, move the stale bundles to Trash via Finder
//!      (recoverable — never a hard `rm`).
//!
//! Documentation: see docs/desktop-postmortem-macos-entitlements-2026-05-19.md

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::process::Command;

const TARGET_BUNDLE_ID: &str = "net.forwardemail.mail";

const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework\
                          /Frameworks/LaunchServices.framework/Support/lsregister";

/// Re-register every .app on disk with LaunchServices. Non-destructive.
/// Forces the OS to forget cached path bindings that may point at stale
/// or deleted bundles. Safe to call on every launch.
#[tauri::command]
pub fn self_heal_flush_launch_services() -> Result<(), String> {
    flush_launch_services()
}

/// Return absolute paths to every `Forward Email.app` (matching our
/// bundle identifier) in common user-writable locations that ISN'T the
/// currently-running bundle. Empty list means nothing stale was found.
#[tauri::command]
pub fn self_heal_detect_stale_bundles() -> Vec<String> {
    let current_bundle = current_bundle_path();
    let mut found = Vec::new();
    for dir in candidate_dirs() {
        scan_dir_for_stale_apps(&dir, current_bundle.as_deref(), &mut found);
    }

    found
}

/// Move the provided .app paths to the Trash via Finder (recoverable),
/// then flush LaunchServices so the OS picks up the change. Returns the
/// number of bundles successfully moved.
///
/// Uses AppleScript-driven Finder rather than `rm -rf` so the user can
/// restore from Trash if the heuristic was wrong. Caller is expected to
/// have obtained user consent for each path.
#[tauri::command]
pub fn self_heal_cleanup_stale_bundles(paths: Vec<String>) -> Result<u32, String> {
    let mut moved = 0u32;
    for path in &paths {
        if move_to_trash(path).is_ok() {
            moved += 1;
        }
    }

    // Refresh LaunchServices regardless of how many moves succeeded — the
    // registry has changed.
    let _ = flush_launch_services();
    Ok(moved)
}

// ── internals ───────────────────────────────────────────────────────────────

fn flush_launch_services() -> Result<(), String> {
    Command::new(LSREGISTER)
        .args([
            "-kill", "-r", "-domain", "local", "-domain", "system", "-domain", "user",
        ])
        .output()
        .map_err(|e| format!("lsregister failed to spawn: {}", e))?;
    Ok(())
}

/// Walk up from the running executable to find the enclosing `.app`.
/// On a normal Tauri macOS bundle the path is
/// `…/Forward Email.app/Contents/MacOS/forwardemail-desktop`.
fn current_bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut p: &Path = exe.as_path();
    while let Some(parent) = p.parent() {
        if parent.extension().and_then(|s| s.to_str()) == Some("app") {
            return Some(parent.to_path_buf());
        }
        p = parent;
    }

    None
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return dirs;
    };
    // User-writable spots where DMG-extracted .apps commonly end up.
    for sub in ["Downloads", "Desktop", "Documents", "Applications"] {
        dirs.push(home.join(sub));
    }
    // Top-level home too, in case the user dragged an .app onto their
    // home folder.
    dirs.push(home);
    dirs
}

fn scan_dir_for_stale_apps(dir: &Path, current_bundle: Option<&Path>, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("app") {
            continue;
        }
        // Skip the currently-running bundle.
        if let Some(cur) = current_bundle {
            if path_equals(&path, cur) {
                continue;
            }
        }
        if bundle_id_matches(&path, TARGET_BUNDLE_ID) {
            if let Some(s) = path.to_str() {
                out.push(s.to_string());
            }
        }
    }
}

/// Compare two paths after canonicalizing both, falling back to literal
/// equality if canonicalization fails (e.g. one of them was removed
/// mid-scan).
fn path_equals(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}

/// Read `Contents/Info.plist` from an .app via `plutil` and compare its
/// CFBundleIdentifier to the target. Returns false on any error.
fn bundle_id_matches(app_path: &Path, target: &str) -> bool {
    let info_plist = app_path.join("Contents").join("Info.plist");
    if !info_plist.exists() {
        return false;
    }
    let output = match Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-", "--"])
        .arg(&info_plist)
        .output()
    {
        Ok(o) => o,
        Err(_) => return false,
    };
    if !output.status.success() {
        return false;
    }
    String::from_utf8_lossy(&output.stdout).trim() == target
}

/// Move a path to the Trash via Finder. Uses AppleScript so the file is
/// recoverable; never invokes `rm`.
fn move_to_trash(path: &str) -> Result<(), String> {
    // Defensive: refuse obviously-bad targets even if Finder would accept
    // them. We only ever move `*.app` bundles whose ID matched our scan.
    if !path.ends_with(".app") {
        return Err(format!("refusing to move non-.app path: {}", path));
    }
    // AppleScript string escaping: backslash and double-quote.
    let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"tell application "Finder" to delete (POSIX file "{}" as alias)"#,
        escaped
    );
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("osascript spawn failed: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "osascript exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}
