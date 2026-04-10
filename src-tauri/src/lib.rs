use serde::Serialize;
use tauri::{Emitter, Listener, Manager};

#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
};

#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

// ── Payload types ────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct DeepLinkPayload {
    urls: Vec<String>,
}

#[cfg(desktop)]
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

/// Returns build metadata for the About dialog (all compile-time constants).
#[tauri::command]
fn get_build_info() -> std::collections::HashMap<String, String> {
    let mut info = std::collections::HashMap::new();
    info.insert("version".into(), env!("CARGO_PKG_VERSION").to_string());
    info.insert("buildDate".into(), env!("BUILD_DATE").to_string());
    info.insert("os".into(), std::env::consts::OS.to_string());
    info.insert("arch".into(), std::env::consts::ARCH.to_string());
    info.insert("license".into(), env!("CARGO_PKG_LICENSE").to_string());
    info
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
        use objc::runtime::Object;

        unsafe {
            let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            let dock_tile: *mut Object = msg_send![app, dockTile];
            let label = if count == 0 {
                String::new()
            } else {
                count.to_string()
            };
            let c_label =
                std::ffi::CString::new(label).unwrap_or_else(|_| std::ffi::CString::default());
            let ns_string: *mut Object = msg_send![
                class!(NSString),
                stringWithUTF8String: c_label.as_ptr()
            ];
            let _: () = msg_send![dock_tile, setBadgeLabel: ns_string];
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = count;
    }
    Ok(())
}

/// Shows or hides the main window (for tray icon toggle).
/// Only operates on the "main" window label — never arbitrary windows.
#[cfg(desktop)]
#[tauri::command]
fn toggle_window_visibility(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|e: tauri::Error| e.to_string())?;
    } else {
        window.show().map_err(|e: tauri::Error| e.to_string())?;
        window.set_focus().map_err(|e: tauri::Error| e.to_string())?;
    }
    Ok(())
}

// ── Tray Icon ────────────────────────────────────────────────────────────────

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let compose = MenuItem::with_id(app, "tray_compose", "Compose New Message", true, None::<&str>)?;
    let check_mail = MenuItem::with_id(app, "tray_check_mail", "Check for New Mail", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let show_hide = MenuItem::with_id(app, "tray_show_hide", "Show/Hide Forward Email", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit Forward Email", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&compose, &check_mail, &sep1, &show_hide, &sep2, &quit])?;

    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Forward Email")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "tray_compose" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("menu:new-message", ());
                }
            }
            "tray_check_mail" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("menu:check-mail", ());
                }
            }
            "tray_show_hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            "tray_quit" => {
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

// ── Native Menu Bar ──────────────────────────────────────────────────────────

#[cfg(desktop)]
fn setup_menu(app: &tauri::App) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    // App menu (macOS shows this as the application menu)
    let about_item = MenuItem::with_id(app, "about", "About Forward Email", true, None::<&str>)?;

    let app_menu = Submenu::with_items(
        app,
        "Forward Email",
        true,
        &[
            &about_item,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // File menu
    let new_message =
        MenuItem::with_id(app, "new_message", "New Message", true, Some("CmdOrCtrl+N"))?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_message,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // Edit menu
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // View menu
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let view_menu = Submenu::with_items(app, "View", true, &[&reload])?;

    // Window menu
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // Help menu
    let website = MenuItem::with_id(app, "website", "Forward Email Website", true, None::<&str>)?;
    let support = MenuItem::with_id(app, "support", "Support", true, None::<&str>)?;
    let help_menu = Submenu::with_items(app, "Help", true, &[&website, &support])?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;

    Ok(menu)
}

// ── Deep-link URL validation ─────────────────────────────────────────────────

/// Validates that a deep-link URL uses an allowed scheme.
/// Only `mailto:` and `forwardemail:` are permitted.
fn is_valid_deep_link(url: &str) -> bool {
    let trimmed = url.trim().to_lowercase();
    trimmed.starts_with("mailto:")
        || trimmed.starts_with("forwardemail:")
}

// ── App Entry Point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
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
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_platform,
            get_build_info,
            set_badge_count,
            #[cfg(desktop)]
            toggle_window_visibility,
        ])
        .setup(|app| {
            // Set up native menu bar and tray icon on desktop
            #[cfg(desktop)]
            {
                let menu = setup_menu(app)?;
                app.set_menu(menu)?;

                app.on_menu_event(|app, event| match event.id().as_ref() {
                    "about" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("menu:about", ());
                        }
                    }
                    "new_message" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("menu:new-message", ());
                        }
                    }
                    "reload" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("window.location.reload()");
                        }
                    }
                    "website" => {
                        let _ = app.opener().open_url("https://forwardemail.net", None::<&str>);
                    }
                    "support" => {
                        let _ = app.opener().open_url("https://forwardemail.net/help", None::<&str>);
                    }
                    _ => {}
                });

                setup_tray(app)?;

                // Register global shortcut: Cmd+Shift+M (macOS) / Ctrl+Shift+M (others)
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                #[cfg(target_os = "macos")]
                let modifiers = Modifiers::SUPER | Modifiers::SHIFT;
                #[cfg(not(target_os = "macos"))]
                let modifiers = Modifiers::CONTROL | Modifiers::SHIFT;

                let shortcut = Shortcut::new(Some(modifiers), Code::KeyM);
                let handle = app.handle().clone();
                app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })?;
            }

            // Forward Android back button to the frontend
            #[cfg(mobile)]
            {
                let back_handle = app.handle().clone();
                app.listen("tauri://back-button", move |_event| {
                    let _ = back_handle.emit("app:back-button", ());
                });
            }

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

            // Open devtools only in debug builds
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Forward Email")
        .run(|_app_handle, _event| {
            // macOS: re-show the main window when the dock icon is clicked
            // and no windows are visible (e.g. after closing with the red ✕).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows, ..
            } = _event
            {
                if !has_visible_windows {
                    if let Some(window) = _app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });
}
