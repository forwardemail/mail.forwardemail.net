//! macOS file picker / save panel workaround.
//!
//! The `tauri-plugin-dialog` 2.7.x stack uses `rfd` 0.16.0, which calls
//! `objc2_app_kit::NSOpenPanel::openPanel(mtm)` and
//! `objc2_app_kit::NSSavePanel::savePanel(mtm)`. Those bindings declare
//! the return as non-nullable (`Retained<…>`), so when macOS 26.3 (Tahoe)
//! returns nil — observed when the app's activation state isn't settled
//! at call time — objc2's `retain_semantics::none_fail` panics and the
//! process aborts. There is no released fix upstream yet.
//!
//! This module exposes Tauri commands `pick_files_macos` (NSOpenPanel)
//! and `save_file_macos` (NSSavePanel) that construct the panels via
//! `msg_send!` with nullable return types, fall back to `+alloc/-init`
//! if the class method returns nil, activate the app first to satisfy
//! the OS, and return the chosen paths as strings. The JS file-picker
//! and download helpers route through these on macOS only; other
//! platforms continue to use `tauri-plugin-dialog`.

#![cfg(target_os = "macos")]

use objc2::msg_send;
use objc2::rc::{Allocated, Retained};
use objc2::ClassType;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSModalResponseOK, NSOpenPanel, NSSavePanel};
use objc2_foundation::NSString;
use tauri_plugin_fs::FsExt;

/// Grant the webview's fs plugin access to exactly the path the user chose.
///
/// tauri-plugin-dialog does this for its own panels. These replacement panels
/// must do the same, or the capability file has to allow every path on disk
/// (it used to: read `**`, write/remove `$HOME/**`), which hands any script
/// running in the webview the user's whole home directory.
fn grant_path(handle: &tauri::AppHandle, path: &str) {
    if let Err(e) = handle.fs_scope().allow_file(path) {
        log::warn!("[file-picker] could not add chosen path to fs scope: {}", e);
    }
}

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
pub fn pick_files_macos(handle: tauri::AppHandle, multiple: bool) -> Result<Vec<String>, String> {
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
            let path = path.to_string();
            grant_path(&handle, &path);
            paths.push(path);
        }
    }

    Ok(paths)
}

/// Construct an `NSSavePanel` safely.
///
/// Mirrors `create_open_panel` — uses a nullable-typed `msg_send!` for
/// `+savePanel` to avoid the objc2 retain panic, falls back to
/// `+alloc/-init` if the class method returns nil on Tahoe.
fn create_save_panel(mtm: MainThreadMarker) -> Option<Retained<NSSavePanel>> {
    unsafe {
        let class = NSSavePanel::class();

        let panel: Option<Retained<NSSavePanel>> = msg_send![class, savePanel];
        if panel.is_some() {
            return panel;
        }

        let alloc: Allocated<NSSavePanel> = mtm.alloc::<NSSavePanel>();
        let panel: Option<Retained<NSSavePanel>> = msg_send![alloc, init];
        panel
    }
}

/// Show a native Save panel and return the chosen file path.
///
/// Returns Ok(Some(path)) when the user saves, Ok(None) when the user
/// cancels, and Err when the panel could not be constructed.
#[tauri::command]
pub fn save_file_macos(
    handle: tauri::AppHandle,
    default_filename: Option<String>,
) -> Result<Option<String>, String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "save_file_macos must be invoked on the main thread".to_string())?;

    let app = NSApplication::sharedApplication(mtm);
    app.activate();

    let panel = create_save_panel(mtm)
        .ok_or_else(|| "Could not construct NSSavePanel (macOS returned nil)".to_string())?;

    if let Some(name) = default_filename {
        if !name.is_empty() {
            let ns_name = NSString::from_str(&name);
            panel.setNameFieldStringValue(&ns_name);
        }
    }

    let response = panel.runModal();
    if response != NSModalResponseOK {
        return Ok(None);
    }

    let url = panel.URL();
    let path = url.and_then(|u| u.path()).map(|s| s.to_string());
    if let Some(path) = &path {
        grant_path(&handle, path);
    }
    Ok(path)
}
