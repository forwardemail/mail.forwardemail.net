//! A random key kept in the OS credential store (macOS Keychain, Windows
//! Credential Manager, the Secret Service on Linux).
//!
//! The frontend seals credentials and PGP keys in localStorage with it when
//! App Lock is off (src/utils/device-seal.ts), so a copy of the profile
//! directory (a backup, a synced home folder, a lost disk) no longer carries
//! them in plaintext. It does not protect against code running as the same
//! user, which can ask the credential store too.
//!
//! The key is created by the frontend and stored here as base64. Rust never
//! looks at it.

use keyring::Entry;

const SERVICE: &str = "net.forwardemail.mail";
const ACCOUNT: &str = "local-storage-seal-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// The stored key, or None when there is none yet. An Err means the store
/// itself could not be reached (no Secret Service running, access denied).
///
/// Async, with the store call on a blocking thread: a sync command runs on
/// the main thread, and a credential store call that blocks there (a Keychain
/// or keyring unlock prompt, a slow D-Bus round trip) stalls the webview while
/// the page waits for this before it boots.
#[tauri::command]
pub async fn device_key_get() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| match entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn device_key_set(value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 {
        return Err("invalid key".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        entry()?.set_password(&value).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
