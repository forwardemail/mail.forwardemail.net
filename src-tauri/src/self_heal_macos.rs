//! Self-heal for users upgrading from broken 0.10.17–0.10.21 macOS bundles.
//!
//! Background: the aps-environment entitlement in those releases caused
//! macOS to reject the signed bundles at exec time. Users who downloaded
//! and ran the broken DMGs left a now-cached `Forward Email.app` in
//! `~/Downloads/` (or wherever they extracted the DMG). macOS's
//! LaunchServices registered that path for the bundle identifier and
//! continues to route launches there even after the user installs a
//! working build into `/Applications/`. Users see the same "the
//! application can't be opened" error indefinitely.
//!
//! This module runs at app startup (macOS only) and re-registers every
//! .app with LaunchServices (`lsregister -kill -r`) so the OS forgets the
//! stale path bindings. Non-destructive and safe on every launch.
//!
//! NOTE: an earlier version also scanned ~/Downloads, ~/Desktop and
//! ~/Documents with `std::fs::read_dir` to find and Trash stray copies of
//! the app. Once the App Sandbox was removed (see the file-picker
//! postmortem) those reads stopped being silently denied and instead
//! tripped macOS TCC, prompting EVERY user — including fresh installs with
//! no stale bundle — for Downloads/Desktop/Documents access on first
//! launch. The scan was dropped 2026-06-02: that cohort is largely
//! migrated and the LaunchServices flush below already fixes the
//! launch-routing the postmortem was about, without touching protected
//! folders.
//!
//! Documentation: see docs/desktop-postmortem-macos-entitlements-2026-05-19.md
//! and docs/desktop-postmortem-macos-sandbox-filepicker-2026-06-02.md

#![cfg(target_os = "macos")]

use std::process::Command;

const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework\
                          /Frameworks/LaunchServices.framework/Support/lsregister";

/// Re-register every .app on disk with LaunchServices. Non-destructive.
/// Forces the OS to forget cached path bindings that may point at stale
/// or deleted bundles. Safe to call on every launch — touches no
/// TCC-protected user folders, so it never prompts.
#[tauri::command]
pub fn self_heal_flush_launch_services() -> Result<(), String> {
    flush_launch_services()
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
