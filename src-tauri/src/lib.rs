use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Listener, Manager};

mod diagnostics;
mod redaction;

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

/// Holds deep-link URLs that arrived before the frontend was ready.
/// The frontend calls `get_pending_deep_links` once during bootstrap
/// to drain any URLs that arrived during cold start.
struct PendingDeepLinks(Mutex<Vec<String>>);

// ── IPC Commands ─────────────────────────────────────────────────────────────
//
// Every command validates its inputs on the Rust side.  The frontend is never
// trusted — all values are bounds-checked and sanitised before use.

/// Drain and return any deep-link URLs that arrived before the frontend
/// was ready (cold-start race condition fix).
#[tauri::command]
fn get_pending_deep_links(state: tauri::State<'_, PendingDeepLinks>) -> Vec<String> {
    let mut queue = state.0.lock().unwrap_or_else(|e| e.into_inner());
    queue.drain(..).collect()
}

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

// ── Mailto Handler Commands ─────────────────────────────────────────────────
//
// Cross-platform default mailto: handler check and registration.
//
// macOS:  Uses CoreServices LSCopyDefaultHandlerForURLScheme (read-only,
//         works inside the App Sandbox) and LSSetDefaultHandlerForURLScheme
//         (write — returns -54 inside the sandbox).  When the write fails
//         we open Apple Mail so the user can change the setting manually.
//
// Windows / Linux:  Delegates to the tauri-plugin-deep-link register() and
//         is_registered() APIs, which use the Windows registry and xdg-mime
//         respectively.

/// Result of checking whether we are the default mailto handler.
#[derive(Clone, Serialize)]
struct MailtoStatus {
    /// "default" | "not_default" | "unknown"
    status: String,
    /// The bundle ID of the current default handler (macOS only, empty otherwise)
    current_handler: String,
}

/// Check if this app is the default mailto: handler.
#[cfg(desktop)]
#[tauri::command]
async fn is_default_mailto_handler(
    app: tauri::AppHandle,
) -> Result<MailtoStatus, String> {
    is_default_mailto_handler_impl(&app).await
}

#[cfg(all(desktop, target_os = "macos"))]
async fn is_default_mailto_handler_impl(
    _app: &tauri::AppHandle,
) -> Result<MailtoStatus, String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    unsafe {
        let scheme = CFString::new("mailto");
        let handler: CFStringRef = LSCopyDefaultHandlerForURLScheme(scheme.as_concrete_TypeRef());

        if handler.is_null() {
            return Ok(MailtoStatus {
                status: "unknown".to_string(),
                current_handler: String::new(),
            });
        }

        let handler_cf = CFString::wrap_under_create_rule(handler);
        let handler_str = handler_cf.to_string();

        let is_us = handler_str == "net.forwardemail.mail";

        Ok(MailtoStatus {
            status: if is_us {
                "default".to_string()
            } else {
                "not_default".to_string()
            },
            current_handler: handler_str,
        })
    }
}

#[cfg(all(desktop, target_os = "windows"))]
async fn is_default_mailto_handler_impl(
    app: &tauri::AppHandle,
) -> Result<MailtoStatus, String> {
    use tauri_plugin_deep_link::DeepLinkExt;

    match app.deep_link().is_registered("mailto") {
        Ok(true) => Ok(MailtoStatus {
            // Windows does not allow silently changing the default mail app.
            // `register()` makes the app eligible in Settings, but it does not
            // prove that MAILTO is currently assigned to this app.
            status: "unknown".to_string(),
            current_handler: String::new(),
        }),
        Ok(false) => Ok(MailtoStatus {
            status: "not_default".to_string(),
            current_handler: String::new(),
        }),
        Err(e) => {
            log::warn!("deep-link is_registered check failed: {}", e);
            Ok(MailtoStatus {
                status: "unknown".to_string(),
                current_handler: String::new(),
            })
        }
    }
}

#[cfg(all(desktop, target_os = "linux"))]
async fn is_default_mailto_handler_impl(
    app: &tauri::AppHandle,
) -> Result<MailtoStatus, String> {
    use tauri_plugin_deep_link::DeepLinkExt;

    match app.deep_link().is_registered("mailto") {
        Ok(true) => Ok(MailtoStatus {
            status: "default".to_string(),
            current_handler: String::new(),
        }),
        Ok(false) => Ok(MailtoStatus {
            status: "not_default".to_string(),
            current_handler: String::new(),
        }),
        Err(e) => {
            log::warn!("deep-link is_registered check failed: {}", e);
            Ok(MailtoStatus {
                status: "unknown".to_string(),
                current_handler: String::new(),
            })
        }
    }
}

/// Result of attempting to set the default mailto handler.
#[derive(Clone, Serialize)]
struct SetMailtoResult {
    /// "registered" | "open_mail_settings" | "error"
    method: String,
    /// Human-readable message for the user
    message: String,
}

/// Attempt to set this app as the default mailto: handler.
#[cfg(desktop)]
#[tauri::command]
async fn set_default_mailto_handler(
    app: tauri::AppHandle,
) -> Result<SetMailtoResult, String> {
    set_default_mailto_handler_impl(&app).await
}

#[cfg(all(desktop, target_os = "macos"))]
async fn set_default_mailto_handler_impl(
    _app: &tauri::AppHandle,
) -> Result<SetMailtoResult, String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    unsafe {
        let scheme = CFString::new("mailto");
        let bundle_id = CFString::new("net.forwardemail.mail");

        let result = LSSetDefaultHandlerForURLScheme(
            scheme.as_concrete_TypeRef(),
            bundle_id.as_concrete_TypeRef(),
        );

        if result == 0 {
            // noErr \u{2014} success (works for non-sandboxed builds)
            return Ok(SetMailtoResult {
                method: "registered".to_string(),
                message: "Forward Email is now your default email app.".to_string(),
            });
        }

        // Error -54 (or any error): App Sandbox blocks this call.
        // Open Apple Mail so the user can change the setting manually.
        log::info!(
            "LSSetDefaultHandlerForURLScheme returned {}, falling back to Mail.app settings",
            result
        );

        let open_result = std::process::Command::new("open")
            .arg("-b")
            .arg("com.apple.mail")
            .output();

        match open_result {
            Ok(_) => Ok(SetMailtoResult {
                method: "open_mail_settings".to_string(),
                message: "Apple Mail has been opened. Please go to Mail \u{2192} Settings \u{2192} General \u{2192} \"Default email reader\" and select Forward Email.".to_string(),
            }),
            Err(e) => Ok(SetMailtoResult {
                method: "open_mail_settings".to_string(),
                message: format!(
                    "Please open Apple Mail, then go to Mail \u{2192} Settings \u{2192} General \u{2192} \"Default email reader\" and select Forward Email. (Could not open Mail automatically: {})",
                    e
                ),
            }),
        }
    }
}

#[cfg(all(desktop, target_os = "windows"))]
async fn set_default_mailto_handler_impl(
    app: &tauri::AppHandle,
) -> Result<SetMailtoResult, String> {
    use tauri_plugin_deep_link::DeepLinkExt;

    if let Err(e) = app.deep_link().register("mailto") {
        log::error!("deep-link register failed: {}", e);
        return Ok(SetMailtoResult {
            method: "error".to_string(),
            message: format!("Failed to register Forward Email with Windows: {}", e),
        });
    }

    match app
        .opener()
        .open_url("ms-settings:defaultapps", None::<&str>)
    {
        Ok(_) => Ok(SetMailtoResult {
            method: "open_mail_settings".to_string(),
            message: "Windows Settings has been opened. Under Default apps, set Forward Email as the MAILTO handler or choose Forward Email as the default email app.".to_string(),
        }),
        Err(e) => {
            log::warn!("failed to open Windows Default apps settings: {}", e);
            Ok(SetMailtoResult {
                method: "open_mail_settings".to_string(),
                message: format!(
                    "Forward Email has been registered with Windows, but Settings could not be opened automatically. Open Windows Settings > Apps > Default apps and set Forward Email as the MAILTO handler. ({})",
                    e
                ),
            })
        }
    }
}

#[cfg(all(desktop, target_os = "linux"))]
async fn set_default_mailto_handler_impl(
    app: &tauri::AppHandle,
) -> Result<SetMailtoResult, String> {
    use tauri_plugin_deep_link::DeepLinkExt;

    match app.deep_link().register("mailto") {
        Ok(_) => Ok(SetMailtoResult {
            method: "registered".to_string(),
            message: "Forward Email is now your default email app.".to_string(),
        }),
        Err(e) => {
            log::error!("deep-link register failed: {}", e);
            Ok(SetMailtoResult {
                method: "error".to_string(),
                message: format!("Failed to register as default email handler: {}", e),
            })
        }
    }
}

// CoreServices FFI declarations for macOS
#[cfg(target_os = "macos")]
extern "C" {
    fn LSCopyDefaultHandlerForURLScheme(
        inURLScheme: core_foundation::string::CFStringRef,
    ) -> core_foundation::string::CFStringRef;

    fn LSSetDefaultHandlerForURLScheme(
        inURLScheme: core_foundation::string::CFStringRef,
        inHandlerBundleID: core_foundation::string::CFStringRef,
    ) -> i32;
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
        .plugin({
            use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
            use time::macros::format_description;

            // 5 × 1 MB rotated log files keep a ~5 MB ceiling per device.
            // Every line passes through `redaction::redact` before hitting
            // disk, stdout, or the webview bridge — so secrets captured by
            // third-party crates (updater, tauri internals, plugins) never
            // enter the log in plaintext.
            let ts_fmt = format_description!(
                "[year]-[month]-[day]T[hour]:[minute]:[second]"
            );

            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .max_file_size(1_000_000)
                .rotation_strategy(RotationStrategy::KeepSome(5))
                // Verbose in debug builds, Info in release. The updater plugin
                // emits its HTTP activity at Debug — keep it visible in both
                // builds so "no visible update" tickets can be diagnosed from
                // the rotating log files.
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .level_for("tauri_plugin_updater", log::LevelFilter::Debug)
                .format(move |out, message, record| {
                    let redacted = redaction::redact(&message.to_string());
                    let ts = time::OffsetDateTime::now_utc()
                        .format(ts_fmt)
                        .unwrap_or_else(|_| String::from("?"));
                    out.finish(format_args!(
                        "{}Z [{}][{}] {}",
                        ts,
                        record.level(),
                        record.target(),
                        redacted
                    ));
                })
                .build()
        })
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_platform,
            get_build_info,
            set_badge_count,
            get_pending_deep_links,
            diagnostics::get_log_path,
            diagnostics::read_recent_logs,
            diagnostics::clear_logs,
            #[cfg(desktop)]
            toggle_window_visibility,
            #[cfg(desktop)]
            is_default_mailto_handler,
            #[cfg(desktop)]
            set_default_mailto_handler,
        ])
        .manage(PendingDeepLinks(Mutex::new(Vec::new())))
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

            // ── Cold-start deep-link capture ────────────────────────────
            // On cold start the OS delivers the URL before the webview JS
            // is ready.  We capture it here and the frontend drains it via
            // the `get_pending_deep_links` IPC command.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let safe_urls: Vec<String> = urls
                        .into_iter()
                        .map(|u| u.to_string())
                        .filter(|u| is_valid_deep_link(u))
                        .collect();
                    if !safe_urls.is_empty() {
                        if let Some(state) = app.try_state::<PendingDeepLinks>() {
                            let mut queue = state.0.lock().unwrap_or_else(|e| e.into_inner());
                            queue.extend(safe_urls);
                        }
                    }
                }
            }

            // Register deep-link handler with URL validation.
            // When the app is already running, URLs arrive here.
            // We also push to the pending queue in case the frontend
            // listener isn't ready yet (e.g. page reload).
            let handle = app.handle().clone();
            app.listen("deep-link://new-url", move |event| {
                if let Ok(urls) = serde_json::from_str::<Vec<String>>(event.payload()) {
                    // Filter to only allowed URL schemes
                    let safe_urls: Vec<String> = urls
                        .into_iter()
                        .filter(|u| is_valid_deep_link(u))
                        .collect();
                    if !safe_urls.is_empty() {
                        // Also push to pending queue as a safety net
                        if let Some(state) = handle.try_state::<PendingDeepLinks>() {
                            let mut queue = state.0.lock().unwrap_or_else(|e| e.into_inner());
                            queue.extend(safe_urls.clone());
                        }
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
