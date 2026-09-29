use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::Result;

/// No-op handler for register_listener.
/// Intercepts the call to prevent it from falling through to run_mobile_plugin
/// (which hangs due to the PluginManager dispatch issue). Native events reach
/// the page as DOM events dispatched by MobilePushPlugin.swift instead.
#[command]
pub(crate) async fn register_listener<R: Runtime>(_app: AppHandle<R>) -> Result<()> {
    Ok(())
}

/// No-op counterpart so `PluginListener.unregister()` resolves instead of
/// falling through to run_mobile_plugin.
#[command]
pub(crate) async fn remove_listener<R: Runtime>(_app: AppHandle<R>) -> Result<()> {
    Ok(())
}

/// How long the permission prompt may stay on screen. The JS side waits a
/// little longer (PERMISSION_PROMPT_TIMEOUT_MS) so it sees the native answer.
#[cfg(any(target_os = "ios", target_os = "macos"))]
const PERMISSION_TIMEOUT_SECS: i32 = 110;

/// How long to wait for the APNs registration callback. The JS side waits a
/// little longer (TOKEN_TIMEOUT_MS) so a slow APNs answer is reported with
/// the native reason instead of a bare JS timeout.
#[cfg(target_os = "ios")]
const TOKEN_TIMEOUT_SECS: i32 = 25;

/// macOS waits longer: after 15 seconds without an answer it unregisters and
/// registers again once (macos.rs), then waits for that registration.
#[cfg(target_os = "macos")]
const MACOS_TOKEN_TIMEOUT_SECS: u64 = 40;

#[cfg(target_os = "ios")]
const ERR_BUFFER_LEN: usize = 512;

#[cfg(target_os = "ios")]
extern "C" {
    /// Returns 1 granted, 0 denied now, 2 denied previously (no prompt
    /// possible), 3 error, -2 timeout. Error text goes to err_buffer.
    fn mobile_push_request_permission(
        timeout_secs: i32,
        err_buffer: *mut std::os::raw::c_char,
        err_buffer_len: i32,
    ) -> i32;

    /// Returns token length, -1 error, -2 timeout, -3 simulator.
    fn mobile_push_get_device_token(
        buffer: *mut std::os::raw::c_char,
        buffer_len: i32,
        timeout_secs: i32,
        err_buffer: *mut std::os::raw::c_char,
        err_buffer_len: i32,
    ) -> i32;

    /// Returns 1 when iOS opened the Settings app.
    fn mobile_push_open_settings() -> i32;

    /// Writes the pending taps as a JSON array; returns its length, 0 when
    /// there are none, -1 when the buffer is too small.
    fn mobile_push_take_pending_taps(buffer: *mut std::os::raw::c_char, buffer_len: i32) -> i32;
}

/// Room for the pending taps: at most 10 (MobilePushPlugin.swift), each an
/// APNs payload, which Apple caps at 4 KB.
#[cfg(target_os = "ios")]
const TAPS_BUFFER_LEN: usize = 64 * 1024;

#[cfg(target_os = "ios")]
fn c_buffer_to_string(buffer: &[std::os::raw::c_char]) -> String {
    let bytes: Vec<u8> = buffer
        .iter()
        .take_while(|&&b| b != 0)
        .map(|&b| b as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn io_error(message: impl Into<String>) -> crate::Error {
    crate::Error::Io(std::io::Error::other(message.into()))
}

/// The FFI functions block until the user or APNs answers. They run on the
/// blocking pool so they never occupy an async runtime worker — the previous
/// version parked a worker in a blocking channel recv for up to 30 seconds.
#[command]
pub(crate) async fn request_permission<R: Runtime>(
    _app: AppHandle<R>,
) -> Result<PermissionResponse> {
    #[cfg(target_os = "ios")]
    {
        let (code, message) = tauri::async_runtime::spawn_blocking(|| {
            let mut err = [0 as std::os::raw::c_char; ERR_BUFFER_LEN];
            let code = unsafe {
                mobile_push_request_permission(
                    PERMISSION_TIMEOUT_SECS,
                    err.as_mut_ptr(),
                    ERR_BUFFER_LEN as i32,
                )
            };
            (code, c_buffer_to_string(&err))
        })
        .await
        .map_err(|e| io_error(format!("Permission request task failed: {e}")))?;

        log::info!("[mobile-push] request_permission result code={code}");
        let (granted, status) = match code {
            1 => (true, "granted"),
            0 => (false, "denied"),
            2 => (false, "previously-denied"),
            -2 => (false, "timeout"),
            _ => (false, "error"),
        };
        Ok(PermissionResponse {
            granted,
            status: status.to_string(),
            error: if message.is_empty() {
                None
            } else {
                Some(message)
            },
        })
    }

    #[cfg(target_os = "macos")]
    {
        use crate::macos::PermissionOutcome;

        let app = _app.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            crate::macos::request_permission(
                &app,
                std::time::Duration::from_secs(PERMISSION_TIMEOUT_SECS as u64),
            )
        })
        .await
        .map_err(|e| io_error(format!("Permission request task failed: {e}")))?;

        let (granted, status, error) = match outcome {
            PermissionOutcome::Granted => (true, "granted", None),
            PermissionOutcome::Denied => (false, "denied", None),
            PermissionOutcome::PreviouslyDenied => (false, "previously-denied", None),
            PermissionOutcome::Timeout(message) => (false, "timeout", Some(message)),
            PermissionOutcome::Error(message) => (false, "error", Some(message)),
            PermissionOutcome::Unsupported => (false, "unsupported", None),
        };
        log::info!("[mobile-push] request_permission status={status}");
        Ok(PermissionResponse {
            granted,
            status: status.to_string(),
            error,
        })
    }

    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        Ok(PermissionResponse {
            granted: false,
            status: "unsupported".to_string(),
            error: None,
        })
    }
}

#[command]
pub(crate) async fn get_token<R: Runtime>(_app: AppHandle<R>) -> Result<TokenResponse> {
    #[cfg(target_os = "ios")]
    {
        let outcome = tauri::async_runtime::spawn_blocking(|| {
            let mut buffer = [0 as std::os::raw::c_char; 256];
            let mut err = [0 as std::os::raw::c_char; ERR_BUFFER_LEN];
            let result = unsafe {
                mobile_push_get_device_token(
                    buffer.as_mut_ptr(),
                    buffer.len() as i32,
                    TOKEN_TIMEOUT_SECS,
                    err.as_mut_ptr(),
                    ERR_BUFFER_LEN as i32,
                )
            };
            if result > 0 {
                Ok(c_buffer_to_string(&buffer[..result as usize]))
            } else {
                let detail = c_buffer_to_string(&err);
                let prefix = match result {
                    -2 => "APNs token request timed out",
                    -3 => "APNs is unavailable",
                    _ => "APNs registration failed",
                };
                Err(if detail.is_empty() {
                    prefix.to_string()
                } else {
                    format!("{prefix}: {detail}")
                })
            }
        })
        .await
        .map_err(|e| io_error(format!("Token request task failed: {e}")))?;

        match outcome {
            Ok(token) => {
                log::info!("[mobile-push] get_token success, len={}", token.len());
                Ok(TokenResponse { token })
            }
            Err(message) => {
                log::warn!("[mobile-push] get_token error: {message}");
                Err(io_error(message))
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let app = _app.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            crate::macos::get_token(
                &app,
                std::time::Duration::from_secs(MACOS_TOKEN_TIMEOUT_SECS),
            )
        })
        .await
        .map_err(|e| io_error(format!("Token request task failed: {e}")))?;

        match outcome {
            Ok(token) => {
                log::info!("[mobile-push] get_token success, len={}", token.len());
                Ok(TokenResponse { token })
            }
            Err(message) => {
                log::warn!("[mobile-push] get_token error: {message}");
                Err(io_error(message))
            }
        }
    }

    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        Ok(TokenResponse {
            token: String::new(),
        })
    }
}

/// Open the app's notification settings (the iOS Settings app, or the
/// Notifications pane of System Settings on macOS) so a previously denied
/// notification permission can be turned back on.
#[command]
pub(crate) async fn open_settings<R: Runtime>(_app: AppHandle<R>) -> Result<bool> {
    #[cfg(target_os = "ios")]
    {
        let opened =
            tauri::async_runtime::spawn_blocking(|| unsafe { mobile_push_open_settings() })
                .await
                .map_err(|e| io_error(format!("Open settings task failed: {e}")))?;
        Ok(opened == 1)
    }

    #[cfg(target_os = "macos")]
    {
        let app = _app.clone();
        tauri::async_runtime::spawn_blocking(move || crate::macos::open_settings(&app))
            .await
            .map_err(|e| io_error(format!("Open settings task failed: {e}")))
    }

    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        Ok(false)
    }
}

/// Current notification authorization without prompting. Implemented on
/// macOS, where tauri-plugin-notification cannot report it (it always says
/// granted on desktop) and where "unsupported" means the build is not signed
/// for APNs. iOS reads it through tauri-plugin-notification.
#[command]
pub(crate) async fn permission_state<R: Runtime>(
    _app: AppHandle<R>,
) -> Result<PermissionStateResponse> {
    #[cfg(target_os = "macos")]
    {
        let state = tauri::async_runtime::spawn_blocking(crate::macos::permission_state)
            .await
            .map_err(|e| io_error(format!("Permission state task failed: {e}")))?;
        Ok(PermissionStateResponse {
            state: state.to_string(),
        })
    }

    #[cfg(target_os = "ios")]
    {
        Ok(PermissionStateResponse {
            state: "unknown".to_string(),
        })
    }

    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        Ok(PermissionStateResponse {
            state: "unsupported".to_string(),
        })
    }
}

/// Notification taps the page has not taken yet, oldest first. A tap that
/// launches the app arrives before the page can listen for it, so the native
/// side keeps it until this is called (see initPushTapHandling in
/// src/utils/push-notifications.js).
#[command]
pub(crate) async fn take_pending_taps<R: Runtime>(
    _app: AppHandle<R>,
) -> Result<Vec<serde_json::Value>> {
    #[cfg(target_os = "ios")]
    {
        let json = tauri::async_runtime::spawn_blocking(|| {
            let mut buffer = vec![0 as std::os::raw::c_char; TAPS_BUFFER_LEN];
            let len = unsafe {
                mobile_push_take_pending_taps(buffer.as_mut_ptr(), TAPS_BUFFER_LEN as i32)
            };
            if len > 0 {
                Some(c_buffer_to_string(&buffer[..len as usize]))
            } else {
                None
            }
        })
        .await
        .map_err(|e| io_error(format!("Pending taps task failed: {e}")))?;

        match json {
            Some(json) => serde_json::from_str::<Vec<serde_json::Value>>(&json)
                .map_err(|e| io_error(format!("Pending taps are not valid JSON: {e}"))),
            None => Ok(Vec::new()),
        }
    }

    #[cfg(target_os = "macos")]
    {
        Ok(crate::macos::take_pending_taps())
    }

    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        Ok(Vec::new())
    }
}
