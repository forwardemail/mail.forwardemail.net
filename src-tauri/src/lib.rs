use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Listener, Manager};

mod diagnostics;
mod redaction;
mod renderer_watchdog;

#[cfg(target_os = "macos")]
mod file_picker_macos;

#[cfg(target_os = "macos")]
mod self_heal_macos;

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
        window
            .set_focus()
            .map_err(|e: tauri::Error| e.to_string())?;
    }
    Ok(())
}

/// Disables the native genie close/miniaturize animation on the named window.
///
/// On macOS 26+, WebKit drives per-webview layout/scrolling sync
/// (RemoteLayerTreeDrawingAreaProxy, ScrollingTree) off a CVDisplayLink
/// callback that keeps firing while a window is being torn down. The
/// animated close runs that teardown across several frames on a background
/// dispatch queue (-[NSAnimation _runBlocking]); if a display-link refresh
/// lands mid-teardown it can dereference already-freed WebKit state and
/// crash with EXC_BAD_ACCESS (seen in both
/// WebPageProxy::dispatchSetObscuredContentInsets and
/// WebCore::ScrollingTree::takePendingScrollUpdates crash reports). Skipping
/// the animation makes the close synchronous and removes the race. Called
/// from the compose window right before it closes itself after a send —
/// the window that's created and destroyed most often in a session.
#[cfg(target_os = "macos")]
#[tauri::command]
fn macos_disable_close_animation(app: tauri::AppHandle, label: String) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("No window with label {label}"))?;
    let ns_window = window.ns_window().map_err(|e| e.to_string())?;
    let ns_window: *mut AnyObject = ns_window.cast();
    if ns_window.is_null() {
        return Err("ns_window is null".to_string());
    }
    // NSWindowAnimationBehaviorNone = 2.
    unsafe {
        let _: () = msg_send![ns_window, setAnimationBehavior: 2isize];
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
    /// "default" | "registered" | "not_default" | "unknown"
    status: String,
    /// The bundle ID of the current default handler (macOS only, empty otherwise)
    current_handler: String,
}

#[cfg(all(desktop, target_os = "windows"))]
const WINDOWS_MAIL_CLIENT_NAME: &str = "Forward Email";
#[cfg(all(desktop, target_os = "windows"))]
const WINDOWS_MAILTO_PROGID: &str = "net.forwardemail.mail.mailto";

// Registry writes go through the Win32 registry API (windows-registry, the
// crate tauri-plugin-deep-link already uses). Spawning reg.exe once per value
// flashed a console window a dozen times and, from the GUI process, could fail
// with 0xc0000142 before every value was written, which left Forward Email
// missing from Default apps.
#[cfg(all(desktop, target_os = "windows"))]
fn set_windows_registry_string(key: &str, name: &str, data: &str) -> Result<(), String> {
    windows_registry::CURRENT_USER
        .create(key)
        .and_then(|k| k.set_string(name, data))
        .map_err(|e| format!("could not write HKCU\\{}: {}", key, e))
}

#[cfg(all(desktop, target_os = "windows"))]
#[link(name = "shell32")]
extern "system" {
    fn SHChangeNotify(
        w_event_id: i32,
        u_flags: u32,
        dw_item1: *const std::ffi::c_void,
        dw_item2: *const std::ffi::c_void,
    );
}

/// Register Forward Email as a mail client for the current user so it is
/// listed under Settings > Apps > Default apps (by name and for MAILTO).
/// Idempotent and quick; it also refreshes the executable path after an
/// update moves the app.
#[cfg(all(desktop, target_os = "windows"))]
fn register_windows_mail_client() -> Result<(), String> {
    let exe_path =
        std::env::current_exe().map_err(|e| format!("current_exe unavailable: {}", e))?;
    let exe = dunce_simplified(&exe_path);
    let command = format!("\"{}\" \"%1\"", exe);
    let icon = format!("{},0", exe);
    let classes_key = format!(r"Software\Classes\{}", WINDOWS_MAILTO_PROGID);
    let mail_client_key = format!(r"Software\Clients\Mail\{}", WINDOWS_MAIL_CLIENT_NAME);
    let capabilities_key = format!(r"{}\Capabilities", mail_client_key);

    // Nothing to do when the registration already points at this executable;
    // rewriting it (and notifying the shell) on every launch would make
    // Explorer refresh its association cache for no reason.
    let read = |key: &str, name: &str| {
        windows_registry::CURRENT_USER
            .open(key)
            .and_then(|k| k.get_string(name))
            .ok()
    };
    let current = read(&format!(r"{}\shell\open\command", classes_key), "")
        .map(|value| value == command)
        .unwrap_or(false)
        && read(&format!(r"{}\URLAssociations", capabilities_key), "mailto").as_deref()
            == Some(WINDOWS_MAILTO_PROGID)
        && read(r"Software\RegisteredApplications", WINDOWS_MAIL_CLIENT_NAME).is_some();
    if current {
        return Ok(());
    }

    // ProgID the MAILTO association points at
    set_windows_registry_string(&classes_key, "", "URL:Forward Email MailTo Protocol")?;
    set_windows_registry_string(&classes_key, "URL Protocol", "")?;
    set_windows_registry_string(
        &classes_key,
        "FriendlyTypeName",
        "Forward Email MailTo Protocol",
    )?;
    set_windows_registry_string(&format!(r"{}\DefaultIcon", classes_key), "", &icon)?;
    set_windows_registry_string(
        &format!(r"{}\Application", classes_key),
        "ApplicationName",
        WINDOWS_MAIL_CLIENT_NAME,
    )?;
    set_windows_registry_string(
        &format!(r"{}\Application", classes_key),
        "ApplicationIcon",
        &icon,
    )?;
    set_windows_registry_string(
        &format!(r"{}\shell\open\command", classes_key),
        "",
        &command,
    )?;

    // Mail client and its capabilities (what Default apps lists)
    set_windows_registry_string(&mail_client_key, "", WINDOWS_MAIL_CLIENT_NAME)?;
    set_windows_registry_string(&format!(r"{}\DefaultIcon", mail_client_key), "", &icon)?;
    set_windows_registry_string(
        &format!(r"{}\shell\open\command", mail_client_key),
        "",
        &format!("\"{}\"", exe),
    )?;
    set_windows_registry_string(
        &capabilities_key,
        "ApplicationName",
        WINDOWS_MAIL_CLIENT_NAME,
    )?;
    set_windows_registry_string(
        &capabilities_key,
        "ApplicationDescription",
        "Private, open-source email for your own domain.",
    )?;
    set_windows_registry_string(&capabilities_key, "ApplicationIcon", &icon)?;
    set_windows_registry_string(
        &format!(r"{}\URLAssociations", capabilities_key),
        "mailto",
        WINDOWS_MAILTO_PROGID,
    )?;
    set_windows_registry_string(
        &format!(r"{}\StartMenu", capabilities_key),
        "Mail",
        WINDOWS_MAIL_CLIENT_NAME,
    )?;
    set_windows_registry_string(
        r"Software\RegisteredApplications",
        WINDOWS_MAIL_CLIENT_NAME,
        &format!(
            r"Software\Clients\Mail\{}\Capabilities",
            WINDOWS_MAIL_CLIENT_NAME
        ),
    )?;

    // Tell Explorer and Settings that associations changed so the new entry
    // shows up without signing out.
    const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;
    const SHCNF_IDLIST: u32 = 0;
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }

    Ok(())
}

/// `C:\Program Files\...` rather than the `\\?\C:\...` form current_exe() can
/// return, which the shell does not accept in an open command.
#[cfg(all(desktop, target_os = "windows"))]
fn dunce_simplified(path: &std::path::Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if !rest.starts_with(r"UNC\") {
            return rest.to_string();
        }
    }
    text
}

/// The ProgID Windows opens mailto: links with for this user, from the
/// per-user choice Settings writes.
#[cfg(all(desktop, target_os = "windows"))]
fn windows_mailto_user_choice() -> Option<String> {
    // Current Windows 11 builds keep the effective choice in UserChoiceLatest
    // and may leave a stale UserChoice beside it.
    let base = r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto";
    [
        format!(r"{}\UserChoiceLatest\ProgId", base),
        format!(r"{}\UserChoice", base),
    ]
    .iter()
    .find_map(|key| {
        windows_registry::CURRENT_USER
            .open(key)
            .and_then(|k| k.get_string("ProgId"))
            .ok()
            .filter(|value| !value.is_empty())
    })
}

/// Check if this app is the default mailto: handler.
#[cfg(desktop)]
#[tauri::command]
async fn is_default_mailto_handler(app: tauri::AppHandle) -> Result<MailtoStatus, String> {
    is_default_mailto_handler_impl(&app).await
}

#[cfg(all(desktop, target_os = "macos"))]
async fn is_default_mailto_handler_impl(_app: &tauri::AppHandle) -> Result<MailtoStatus, String> {
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
async fn is_default_mailto_handler_impl(app: &tauri::AppHandle) -> Result<MailtoStatus, String> {
    use tauri_plugin_deep_link::DeepLinkExt;

    // Windows does not let an app change the default silently, but it does
    // record the user's choice, so "default" can be told from "registered".
    let choice = windows_mailto_user_choice().unwrap_or_default();
    if choice.eq_ignore_ascii_case(WINDOWS_MAILTO_PROGID) {
        return Ok(MailtoStatus {
            status: "default".to_string(),
            current_handler: choice,
        });
    }

    let registered = windows_registry::CURRENT_USER
        .open(r"Software\RegisteredApplications")
        .and_then(|k| k.get_string(WINDOWS_MAIL_CLIENT_NAME))
        .is_ok()
        || app.deep_link().is_registered("mailto").unwrap_or(false);

    Ok(MailtoStatus {
        status: if registered {
            "registered".to_string()
        } else {
            "not_default".to_string()
        },
        current_handler: choice,
    })
}

#[cfg(all(desktop, target_os = "linux"))]
async fn is_default_mailto_handler_impl(app: &tauri::AppHandle) -> Result<MailtoStatus, String> {
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
async fn set_default_mailto_handler(app: tauri::AppHandle) -> Result<SetMailtoResult, String> {
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
    if let Err(e) = register_windows_mail_client() {
        log::error!("windows mail client registration failed: {}", e);
        return Ok(SetMailtoResult {
            method: "error".to_string(),
            message: format!("Failed to register Forward Email with Windows: {}", e),
        });
    }

    if windows_mailto_user_choice()
        .map(|choice| choice.eq_ignore_ascii_case(WINDOWS_MAILTO_PROGID))
        .unwrap_or(false)
    {
        return Ok(SetMailtoResult {
            method: "registered".to_string(),
            message: "Forward Email is your default email app.".to_string(),
        });
    }

    // Windows 11 opens Forward Email's own page in Default apps (with its
    // MAILTO entry) for registeredAppUser; Windows 10 ignores the parameter
    // and opens Default apps.
    let instructions = "Windows Settings has been opened to Forward Email's default apps page. Select MAILTO and choose Forward Email. If a list of all apps opens instead, search for Forward Email, or search for MAILTO under link types.";
    let page = "ms-settings:defaultapps?registeredAppUser=Forward%20Email";
    let opened = app.opener().open_url(page, None::<&str>).or_else(|_| {
        app.opener()
            .open_url("ms-settings:defaultapps", None::<&str>)
    });

    match opened {
        Ok(_) => Ok(SetMailtoResult {
            method: "open_mail_settings".to_string(),
            message: instructions.to_string(),
        }),
        Err(e) => {
            log::warn!("failed to open Windows Default apps settings: {}", e);
            Ok(SetMailtoResult {
                method: "open_mail_settings".to_string(),
                message: format!(
                    "Forward Email has been registered with Windows. Open Settings > Apps > Default apps, choose Forward Email, and set it for MAILTO. ({})",
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
    let compose = MenuItem::with_id(
        app,
        "tray_compose",
        "Compose New Message",
        true,
        None::<&str>,
    )?;
    let check_mail = MenuItem::with_id(
        app,
        "tray_check_mail",
        "Check for New Mail",
        true,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let show_hide = MenuItem::with_id(
        app,
        "tray_show_hide",
        "Show/Hide Forward Email",
        true,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit Forward Email", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&compose, &check_mail, &sep1, &show_hide, &sep2, &quit],
    )?;

    // macOS template icons must be monochrome with a real alpha channel so
    // the OS can invert them for light/dark menu bars. The default 32x32.png
    // is opaque RGBA (full square) — using it as a template would render as
    // a solid black block. The tray-template-32x32@2x.png asset is a white-
    // on-alpha silhouette at 64×64 px (the native @2x Retina resolution for
    // a 32pt menu-bar icon). Using the @2x variant avoids blurry upscaling
    // on HiDPI screens and ensures macOS correctly applies template tinting.
    #[cfg(target_os = "macos")]
    let icon = Image::from_bytes(include_bytes!("../icons/tray-template-32x32@2x.png"))?;
    #[cfg(not(target_os = "macos"))]
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
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
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )?;

    Ok(menu)
}

// ── Deep-link URL validation ─────────────────────────────────────────────────

/// Longest deep link accepted. Real mailto: links are far shorter; the cap
/// keeps a hostile link from pushing megabytes through IPC and the compose
/// parser (the frontend truncates to 2048 characters anyway).
const MAX_DEEP_LINK_LEN: usize = 8192;

/// Cold-start queue bound: links beyond this are dropped rather than growing
/// memory while the frontend is not yet draining the queue.
const MAX_PENDING_DEEP_LINKS: usize = 32;

/// Validates that a deep-link URL uses an allowed scheme.
/// Only `mailto:` and `forwardemail:` are permitted, without control
/// characters and within MAX_DEEP_LINK_LEN.
fn is_valid_deep_link(url: &str) -> bool {
    if url.len() > MAX_DEEP_LINK_LEN || url.chars().any(|c| c.is_control()) {
        return false;
    }
    let trimmed = url.trim().to_lowercase();
    trimmed.starts_with("mailto:") || trimmed.starts_with("forwardemail:")
}

fn push_pending_deep_links(queue: &mut Vec<String>, urls: Vec<String>) {
    for url in urls {
        if queue.len() >= MAX_PENDING_DEEP_LINKS {
            log::warn!("[deep-link] pending queue full; dropping link");
            break;
        }
        queue.push(url);
    }
}

// ── App Entry Point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Leave a breadcrumb before any panic aborts the process — e.g. an objc2
    // none_fail SIGABRT from a nil NSOpenPanel. tauri-plugin-log captures
    // log::error! into the rotating, redacted log file, so a field crash leaves
    // a record instead of depending on the user mailing in a macOS .ips report.
    // The default hook is chained so normal stderr output / abort is preserved.
    let default_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        log::error!("PANIC at {}: {}", location, message);
        default_panic_hook(info);
    }));

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
            .plugin(tauri_plugin_global_shortcut::Builder::new().build());

        // tauri-plugin-window-state persists window size/position across
        // launches. Under the webdriver feature this causes problems on
        // macOS-arm64 CI: the runner spawns the app fresh each spec, but
        // the plugin restores whatever tiny size the previous spec's
        // afterEach left behind (or a system-default 1024×190 if no
        // state file yet), leaving the Try Demo button below the
        // viewport and the helper's resize call racing the WebView's
        // own restore on next launch. Disabling it for e2e builds gives
        // each spawn the tauri.conf.json default (1280×800).
        #[cfg(not(feature = "webdriver"))]
        {
            builder = builder.plugin(tauri_plugin_window_state::Builder::new().build());
        }

        // The updater silently auto-installs (no onUpdateAvailable callback at
        // the call site in main.ts) the moment GitHub Releases reports a newer
        // version. In an e2e build the running binary is `--debug` and older
        // than the latest published release, so the updater downloads the
        // release binary and overwrites the on-disk debug binary mid-run —
        // killing every subsequent spec file with "binary not found".
        #[cfg(not(feature = "webdriver"))]
        {
            // Flatpak owns updates for Flatpak installations. Loading Tauri's
            // GitHub-release updater there would attempt to replace a binary
            // inside an immutable sandbox and bypass the user's Flatpak update
            // policy. Flatpak exports FLATPAK_ID to every confined process.
            // snapd owns updates the same way, and a snap's own files are
            // mounted read-only from squashfs, so a self-replacing updater
            // cannot write there at all. snapd exports SNAP to every confined
            // process.
            if std::env::var_os("FLATPAK_ID").is_none() && std::env::var_os("SNAP").is_none() {
                builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
            }
        }
    }

    #[cfg(all(desktop, feature = "webdriver"))]
    {
        builder = builder.plugin(tauri_plugin_webdriver::init());
    }

    // Native haptic feedback (iOS Taptic Engine / Android vibrator). Mobile-only:
    // navigator.vibrate is a no-op in the iOS WKWebView.
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_haptics::init());
    }

    // Direct APNs tokens on iOS and macOS. This crate must not be compiled on
    // Android, where its current Rust command shim returns empty/no-op
    // responses. On macOS it stays inert (its commands answer "unsupported")
    // unless the bundle is signed with the APNs entitlement.
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        builder = builder.plugin(tauri_plugin_mobile_push::init());
    }

    // UnifiedPush is the Google-free Android baseline. Play builds enable the
    // optional `fcm` Cargo feature and register Firebase as an additional
    // transport; F-Droid/Obtainium builds never link the FCM plugin.
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_unified_push::init());
    }

    #[cfg(all(target_os = "android", feature = "fcm"))]
    {
        builder = builder.plugin(tauri_plugin_remote_push::init());
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
            let ts_fmt = format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");

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
            #[cfg(target_os = "macos")]
            macos_disable_close_animation,
            #[cfg(desktop)]
            is_default_mailto_handler,
            #[cfg(desktop)]
            set_default_mailto_handler,
            renderer_watchdog::renderer_heartbeat,
            renderer_watchdog::renderer_watchdog_status,
            #[cfg(target_os = "macos")]
            file_picker_macos::pick_files_macos,
            #[cfg(target_os = "macos")]
            file_picker_macos::save_file_macos,
            #[cfg(target_os = "macos")]
            self_heal_macos::self_heal_flush_launch_services,
        ])
        .manage(PendingDeepLinks(Mutex::new(Vec::new())))
        .manage(renderer_watchdog::WatchdogState::default())
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
                        // The native reload, not location.reload() run in
                        // the page: a page whose WebKit content process died
                        // (the window gone blank) runs no script, so Reload
                        // did nothing at the one time it was needed.
                        if let Some(window) = app.get_webview_window("main") {
                            if let Err(e) = window.reload() {
                                log::error!("[menu] reload failed: {}", e);
                            }
                        }
                    }
                    "website" => {
                        let _ = app
                            .opener()
                            .open_url("https://forwardemail.net", None::<&str>);
                    }
                    "support" => {
                        let _ = app
                            .opener()
                            .open_url("https://forwardemail.net/help", None::<&str>);
                    }
                    _ => {}
                });

                setup_tray(app)?;

                // List Forward Email as a mail client in Windows Default apps
                // from the first launch (per user, no prompt), the way an
                // installer would. Choosing it as the default stays with the
                // user in Settings.
                // (release builds only: a dev build would register target\debug)
                #[cfg(all(target_os = "windows", not(debug_assertions)))]
                std::thread::spawn(|| {
                    if let Err(e) = register_windows_mail_client() {
                        log::warn!("windows mail client registration failed: {}", e);
                    }
                });

                // Reload the main webview if its content process stops
                // answering. See renderer_watchdog.rs for the why.
                renderer_watchdog::start(app.handle().clone());

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
                app.global_shortcut()
                    .on_shortcut(shortcut, move |_app, _shortcut, event| {
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

            // Size the webview inside the iOS safe areas (status bar, notch,
            // home indicator). Mirrors scripts/android/MainActivity.kt, where
            // the activity root view is padded with system-bar insets: the
            // native layer is the source of truth for inset safety, and CSS
            // env(safe-area-inset-*) correctly reports 0 inside the already
            // inset webview. Without this WRY lays the WKWebView over the
            // full screen and the web UI renders under the top/bottom trays.
            #[cfg(target_os = "ios")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| unsafe {
                    use objc2::msg_send;
                    use objc2::runtime::AnyObject;

                    let wk: *mut AnyObject = webview.inner().cast();
                    if wk.is_null() {
                        return;
                    }
                    let superview: *mut AnyObject = msg_send![wk, superview];
                    if superview.is_null() {
                        return;
                    }

                    // Paint the exposed strips in the app shell background so
                    // the trays read as chrome rather than a rendering gap.
                    let bg: *mut AnyObject = msg_send![
                        objc2::class!(UIColor),
                        colorWithRed: 0.0392_f64,
                        green: 0.0392_f64,
                        blue: 0.0392_f64,
                        alpha: 1.0_f64
                    ];
                    let _: () = msg_send![superview, setBackgroundColor: bg];

                    // Replace WRY's full-screen autoresizing frame with
                    // constraints against the safe area layout guide. Rotation
                    // and inset changes then re-layout automatically.
                    let _: () = msg_send![wk, setTranslatesAutoresizingMaskIntoConstraints: false];
                    let guide: *mut AnyObject = msg_send![superview, safeAreaLayoutGuide];

                    let wk_anchor: *mut AnyObject = msg_send![wk, topAnchor];
                    let guide_anchor: *mut AnyObject = msg_send![guide, topAnchor];
                    let constraint: *mut AnyObject =
                        msg_send![wk_anchor, constraintEqualToAnchor: guide_anchor];
                    let _: () = msg_send![constraint, setActive: true];

                    let wk_anchor: *mut AnyObject = msg_send![wk, bottomAnchor];
                    let guide_anchor: *mut AnyObject = msg_send![guide, bottomAnchor];
                    let constraint: *mut AnyObject =
                        msg_send![wk_anchor, constraintEqualToAnchor: guide_anchor];
                    let _: () = msg_send![constraint, setActive: true];

                    let wk_anchor: *mut AnyObject = msg_send![wk, leadingAnchor];
                    let guide_anchor: *mut AnyObject = msg_send![guide, leadingAnchor];
                    let constraint: *mut AnyObject =
                        msg_send![wk_anchor, constraintEqualToAnchor: guide_anchor];
                    let _: () = msg_send![constraint, setActive: true];

                    let wk_anchor: *mut AnyObject = msg_send![wk, trailingAnchor];
                    let guide_anchor: *mut AnyObject = msg_send![guide, trailingAnchor];
                    let constraint: *mut AnyObject =
                        msg_send![wk_anchor, constraintEqualToAnchor: guide_anchor];
                    let _: () = msg_send![constraint, setActive: true];

                    // Disable native scroll-view bounce so the JS-based
                    // pull-to-refresh gesture is not consumed by iOS rubber-
                    // banding. The CSS overscroll-behavior-y: none handles
                    // the web layer; this disables it at the UIKit level.
                    let scroll_view: *mut AnyObject = msg_send![wk, scrollView];
                    if !scroll_view.is_null() {
                        let _: () = msg_send![scroll_view, setBounces: false];
                    }
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
                            push_pending_deep_links(&mut queue, safe_urls);
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
                    let safe_urls: Vec<String> =
                        urls.into_iter().filter(|u| is_valid_deep_link(u)).collect();
                    if !safe_urls.is_empty() {
                        // Also push to pending queue as a safety net
                        if let Some(state) = handle.try_state::<PendingDeepLinks>() {
                            let mut queue = state.0.lock().unwrap_or_else(|e| e.into_inner());
                            push_pending_deep_links(&mut queue, safe_urls.clone());
                        }
                        let _ =
                            handle.emit("deep-link-received", DeepLinkPayload { urls: safe_urls });
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
                has_visible_windows,
                ..
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

#[cfg(test)]
mod deep_link_tests {
    use super::*;

    #[test]
    fn accepts_allowed_schemes() {
        assert!(is_valid_deep_link("mailto:a@example.com"));
        assert!(is_valid_deep_link("MAILTO:a@example.com?subject=hi"));
        assert!(is_valid_deep_link("forwardemail://mailbox"));
    }

    #[test]
    fn rejects_other_schemes_oversized_and_control_characters() {
        assert!(!is_valid_deep_link("https://example.com"));
        assert!(!is_valid_deep_link("file:///etc/passwd"));
        assert!(!is_valid_deep_link("javascript:alert(1)"));
        assert!(!is_valid_deep_link(&format!(
            "mailto:{}",
            "a".repeat(MAX_DEEP_LINK_LEN)
        )));
        assert!(!is_valid_deep_link(
            "mailto:a@example.com\nbcc=evil@example.com"
        ));
    }

    #[test]
    fn pending_queue_is_bounded() {
        let mut queue = Vec::new();
        let urls: Vec<String> = (0..100)
            .map(|i| format!("mailto:{i}@example.com"))
            .collect();
        push_pending_deep_links(&mut queue, urls);
        assert_eq!(queue.len(), MAX_PENDING_DEEP_LINKS);
    }
}
