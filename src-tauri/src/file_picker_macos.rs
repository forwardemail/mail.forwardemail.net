//! macOS file picker workaround.
//!
//! The `tauri-plugin-dialog` 2.7.x stack uses `rfd` 0.16.0, which calls
//! `objc2_app_kit::NSOpenPanel::openPanel(mtm)`. That binding declares the
//! return as non-nullable (`Retained<NSOpenPanel>`), so when macOS 26.3
//! (Tahoe) returns nil — observed when the app's activation state isn't
//! settled at call time — objc2's `retain_semantics::none_fail` panics and
//! the process aborts. There is no released fix upstream yet.
//!
//! This module exposes a `pick_files_macos` Tauri command that constructs
//! the panel via `msg_send!` with a nullable return type, falls back to
//! `+alloc/-init` if `+openPanel` returns nil, activates the app first to
//! satisfy the OS, and returns the chosen file paths as strings. The JS
//! `pickFiles()` helper routes through this on macOS only; other platforms
//! continue to use `tauri-plugin-dialog`.

#![cfg(target_os = "macos")]

use objc2::msg_send;
use objc2::rc::{Allocated, Retained};
use objc2::ClassType;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSModalResponseOK, NSOpenPanel};

/// Construct an `NSOpenPanel` safely.
///
/// Tries `+[NSOpenPanel openPanel]` first via a nullable-typed `msg_send!`
/// so the objc2 retain assertion can't fire. Falls back to `+alloc/-init`
/// if the class method returns nil, which it does on macOS 26 under some
/// activation states.
fn create_open_panel(mtm: MainThreadMarker) -> Option<Retained<NSOpenPanel>> {
    unsafe {
        let class = NSOpenPanel::class();

        // Primary path: the documented class method, but with a nullable
        // return so we get None instead of a panic when the OS returns nil.
        // objc2 0.6 unified retain handling into `msg_send!` — the macro
        // applies retain semantics automatically when the return type is
        // Retained or Option<Retained>.
        let panel: Option<Retained<NSOpenPanel>> = msg_send![class, openPanel];
        if panel.is_some() {
            return panel;
        }

        // Fallback: explicit alloc + init. Different code path inside AppKit,
        // doesn't rely on whatever activation/sandbox check fails on Tahoe.
        // `MainThreadMarker::alloc` is the public entry point for allocating
        // main-thread-only classes like NSOpenPanel.
        let alloc: Allocated<NSOpenPanel> = mtm.alloc::<NSOpenPanel>();
        let panel: Option<Retained<NSOpenPanel>> = msg_send![alloc, init];
        panel
    }
}

#[tauri::command]
pub fn pick_files_macos(multiple: bool) -> Result<Vec<String>, String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "pick_files_macos must be invoked on the main thread".to_string())?;

    // Activating the app before showing the panel resolves a class of nil-
    // return cases on Tahoe — NSOpenPanel needs a key window context.
    let app = NSApplication::sharedApplication(mtm);
    app.activate();

    let panel = create_open_panel(mtm)
        .ok_or_else(|| "Could not construct NSOpenPanel (macOS returned nil)".to_string())?;

    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(false);
    panel.setAllowsMultipleSelection(multiple);
    panel.setResolvesAliases(true);

    let response = panel.runModal();
    if response != NSModalResponseOK {
        return Ok(Vec::new());
    }

    let urls = panel.URLs();
    let count = urls.count();
    let mut paths = Vec::with_capacity(count);
    for i in 0..count {
        let url = urls.objectAtIndex(i);
        if let Some(path) = url.path() {
            paths.push(path.to_string());
        }
    }

    Ok(paths)
}
