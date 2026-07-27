use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::Result;

/// No-op handler for register_listener.
/// Intercepts the call to prevent it from falling through to run_mobile_plugin
/// (which hangs due to the PluginManager dispatch issue).
/// Events (notification-received, notification-tapped, token-received) are not
/// yet delivered through this path — a future fix will use AppHandle.emit().
#[command]
pub(crate) async fn register_listener<R: Runtime>(_app: AppHandle<R>) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "ios")]
extern "C" {
    /// Request notification permission. Blocks until user responds.
    /// Returns 1 if granted, 0 if denied.
    fn mobile_push_request_permission() -> i32;

    /// Get APNs device token. Blocks until token received or timeout.
    /// Writes hex token string to buffer. Returns token length, -1 on error, -2 on timeout.
    fn mobile_push_get_device_token(buffer: *mut i8, buffer_len: i32, timeout_secs: i32) -> i32;
}

#[command]
pub(crate) async fn request_permission<R: Runtime>(
    _app: AppHandle<R>,
) -> Result<PermissionResponse> {
    eprintln!("[mobile-push] request_permission command called");

    #[cfg(target_os = "ios")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        eprintln!("[mobile-push] spawning thread for FFI call...");
        std::thread::spawn(move || {
            eprintln!("[mobile-push] thread started, calling mobile_push_request_permission...");
            let result = unsafe { mobile_push_request_permission() };
            eprintln!("[mobile-push] FFI returned: {}", result);
            let _ = tx.send(result == 1);
        });
        eprintln!("[mobile-push] waiting for FFI result...");
        let granted = rx.recv().unwrap_or(false);
        eprintln!("[mobile-push] request_permission result: granted={}", granted);
        Ok(PermissionResponse { granted })
    }

    #[cfg(not(target_os = "ios"))]
    {
        Ok(PermissionResponse { granted: false })
    }
}

#[command]
pub(crate) async fn get_token<R: Runtime>(_app: AppHandle<R>) -> Result<TokenResponse> {
    eprintln!("[mobile-push] get_token command called");

    #[cfg(target_os = "ios")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            eprintln!("[mobile-push] get_token thread: calling FFI...");
            let mut buffer = [0i8; 256];
            let result = unsafe {
                mobile_push_get_device_token(buffer.as_mut_ptr(), 256, 15)
            };
            eprintln!("[mobile-push] get_token FFI returned: {}", result);
            if result > 0 {
                let len = result as usize;
                let bytes: Vec<u8> = buffer[..len].iter().map(|&b| b as u8).collect();
                match String::from_utf8(bytes) {
                    Ok(token) => tx.send(Ok(token)),
                    Err(e) => tx.send(Err(format!("Invalid UTF-8 token: {}", e))),
                }
            } else if result == -2 {
                tx.send(Err("APNs token request timed out".to_string()))
            } else {
                tx.send(Err("Failed to get APNs device token".to_string()))
            }
        });

        match rx.recv() {
            Ok(Ok(token)) => {
                eprintln!("[mobile-push] get_token success, len={}", token.len());
                Ok(TokenResponse { token })
            }
            Ok(Err(e)) => {
                eprintln!("[mobile-push] get_token error: {}", e);
                Err(crate::Error::Io(std::io::Error::other(e)))
            }
            Err(_) => {
                eprintln!("[mobile-push] get_token: thread panicked");
                Err(crate::Error::Io(std::io::Error::other(
                    "Token fetch thread panicked",
                )))
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
