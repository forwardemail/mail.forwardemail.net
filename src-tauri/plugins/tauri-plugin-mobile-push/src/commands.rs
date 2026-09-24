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
#[cfg(target_os = "ios")]
const PERMISSION_TIMEOUT_SECS: i32 = 110;

/// How long to wait for the APNs registration callback. The JS side waits a
/// little longer (TOKEN_TIMEOUT_MS) so a slow APNs answer is reported with
/// the native reason instead of a bare JS timeout.
#[cfg(target_os = "ios")]
const TOKEN_TIMEOUT_SECS: i32 = 25;

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
}

#[cfg(target_os = "ios")]
fn c_buffer_to_string(buffer: &[std::os::raw::c_char]) -> String {
    let bytes: Vec<u8> = buffer
        .iter()
        .take_while(|&&b| b != 0)
        .map(|&b| b as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(target_os = "ios")]
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

    #[cfg(not(target_os = "ios"))]
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

    #[cfg(not(target_os = "ios"))]
    {
        Ok(TokenResponse {
            token: String::new(),
        })
    }
}

/// Open the app's page in the iOS Settings app so a previously denied
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

    #[cfg(not(target_os = "ios"))]
    {
        Ok(false)
    }
}
