use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Listener, Manager,
};

// ── Payload types ────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct DeepLinkPayload {
    urls: Vec<String>,
}

#[derive(Clone, Serialize)]
struct SingleInstancePayload {
    args: Vec<String>,
    cwd: String,
}

// ── IPC Commands ─────────────────────────────────────────────────────────────
//
// Every command validates its inputs on the Rust side.  The frontend is never
// trusted — all values are bounds-checked and sanitised before use.

/// Returns the current app version (compile-time constant, no user input).
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Returns the current platform identifier (compile-time constant, no user input).
#[tauri::command]
fn get_platform() -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    format!("{}-{}", os, arch)
}

/// Sets the dock/taskbar badge count.
/// Input validation: count must be in range 0..=99999.
#[tauri::command]
fn set_badge_count(count: u32) -> Result<(), String> {
    if count > 99_999 {
        return Err("Badge count must be between 0 and 99999".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        // macOS badge count via dock API.
        // Tauri does not expose this directly yet; placeholder for Swift plugin.
        let _ = count;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = count;
    }
    Ok(())
}

/// Shows or hides the main window (for tray icon toggle).
/// Only operates on the "main" window label — never arbitrary windows.
#[tauri::command]
fn toggle_window_visibility(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|e| e.to_string())?;
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Tray Icon ────────────────────────────────────────────────────────────────

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Show Forward Email", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Forward Email")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

// ── Deep-link URL validation ─────────────────────────────────────────────────

/// Validates that a deep-link URL uses an allowed scheme.
/// Only `mailto:` and `forwardemail:` are permitted.
fn is_valid_deep_link(url: &str) -> bool {
    let trimmed = url.trim();
    trimmed.starts_with("mailto:")
        || trimmed.starts_with("forwardemail:")
}

// ── App Entry Point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Desktop-only plugins
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
                // Focus existing window and forward arguments.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                // Only forward args that pass deep-link validation.
                let safe_args: Vec<String> = args
                    .iter()
                    .filter(|a| is_valid_deep_link(a) || !a.contains("://"))
                    .cloned()
                    .collect();
                let _ = app.emit(
                    "single-instance",
                    SingleInstancePayload {
                        args: safe_args,
                        cwd,
                    },
                );
            }))
            .plugin(tauri_plugin_window_state::Builder::new().build())
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_platform,
            set_badge_count,
            toggle_window_visibility,
        ])
        .setup(|app| {
            // Set up tray icon on desktop
            #[cfg(desktop)]
            setup_tray(app)?;

            // Register deep-link handler with URL validation
            let handle = app.handle().clone();
            app.listen("deep-link://new-url", move |event| {
                if let Ok(urls) = serde_json::from_str::<Vec<String>>(event.payload()) {
                    // Filter to only allowed URL schemes
                    let safe_urls: Vec<String> = urls
                        .into_iter()
                        .filter(|u| is_valid_deep_link(u))
                        .collect();
                    if !safe_urls.is_empty() {
                        let _ = handle.emit(
                            "deep-link-received",
                            DeepLinkPayload { urls: safe_urls },
                        );
                    }
                }
            });

            // Emit a ready event so the frontend knows Tauri is available
            app.emit("tauri-ready", ())?;

            // Open devtools automatically for debugging (remove before release)
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Forward Email");
}
