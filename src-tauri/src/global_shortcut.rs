//! Configurable shortcut that opens or focuses the desktop app from anywhere.
//!
//! v1.0.11 registered Command+Shift+M (macOS) or Ctrl+Shift+M (other desktops)
//! at startup and never let go of it. That combination is Chrome's profile
//! switcher on macOS, and because the shortcut is global it wins over every
//! other app. The choice is now a setting: change the combination, or turn the
//! shortcut off.
//!
//! The preference is stored in the app config directory and applied before the
//! webview loads, so a shortcut the user turned off is not grabbed for the
//! moment between launch and the settings page. Changing it replaces the
//! registration immediately. A combo another app already holds is declined and
//! the previous shortcut is put back; a failure at launch is logged and the
//! app still starts.
//!
//! The webview cannot call the global-shortcut plugin's own register command
//! (that permission is not granted). It can only ask for a combo this module
//! has checked: one modifier other than Shift, and one key.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const CONFIG_FILE: &str = "global-shortcut.json";
const MAX_ACCELERATOR_LEN: usize = 80;
const MAX_CONFIG_BYTES: u64 = 4096;

const TAKEN_MESSAGE: &str = "Couldn't register that shortcut. Another app may already be using it.";
const UPDATE_MESSAGE: &str = "Couldn't update the global shortcut. Try again, or restart the app.";
const SAVE_MESSAGE: &str = "Couldn't save the shortcut setting on this device.";
const INVALID_MESSAGE: &str = "That shortcut isn't supported. Use Ctrl, Alt, or Command with a letter, number, or function key.";
const MODIFIER_MESSAGE: &str =
    "Include Ctrl, Alt, or the Command key. Shift alone would block normal typing.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlobalShortcutConfig {
    pub enabled: bool,
    pub accelerator: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutStatus {
    pub enabled: bool,
    pub accelerator: String,
    pub registered: bool,
    pub error: Option<String>,
    pub default_accelerator: String,
}

#[derive(Debug, Clone)]
struct Inner {
    path: Option<PathBuf>,
    config: GlobalShortcutConfig,
    /// Accelerator currently held with the OS. `None` when the shortcut is
    /// off, or when registration was declined.
    registered: Option<String>,
    error: Option<String>,
}

pub struct GlobalShortcutState {
    inner: Mutex<Inner>,
}

/// Command+Shift+M on macOS, Ctrl+Shift+M elsewhere: the same combo v1.0.11
/// registered unconditionally. Returned in the plugin's canonical form
/// (`shift+super+KeyM` / `shift+control+KeyM`).
pub fn default_accelerator() -> String {
    #[cfg(target_os = "macos")]
    let modifiers = Modifiers::SUPER | Modifiers::SHIFT;
    #[cfg(not(target_os = "macos"))]
    let modifiers = Modifiers::CONTROL | Modifiers::SHIFT;
    Shortcut::new(Some(modifiers), Code::KeyM).into_string()
}

pub fn default_config() -> GlobalShortcutConfig {
    GlobalShortcutConfig {
        enabled: true,
        accelerator: default_accelerator(),
    }
}

/// Accept a shortcut string and return the canonical form the plugin stores.
///
/// Shift by itself is refused: a global Shift+M would swallow every capital M.
/// A bare key is refused for the same reason.
pub fn canonicalize_accelerator(raw: &str) -> Result<String, String> {
    // Reject control characters before trimming: trim() would otherwise hide a
    // trailing newline and accept the combo.
    if raw.chars().any(|c| c.is_control()) {
        return Err(INVALID_MESSAGE.to_string());
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_ACCELERATOR_LEN {
        return Err(INVALID_MESSAGE.to_string());
    }

    let shortcut = Shortcut::from_str(trimmed).map_err(|_| INVALID_MESSAGE.to_string())?;
    let has_modifier = shortcut.mods.contains(Modifiers::CONTROL)
        || shortcut.mods.contains(Modifiers::ALT)
        || shortcut.mods.contains(Modifiers::SUPER);
    if !has_modifier {
        return Err(MODIFIER_MESSAGE.to_string());
    }
    Ok(shortcut.into_string())
}

pub fn load_config(path: &Path) -> GlobalShortcutConfig {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return default_config(),
        Err(err) => {
            log::warn!("could not read global shortcut config: {err}");
            return default_config();
        }
    };

    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if size > MAX_CONFIG_BYTES {
        log::warn!("global shortcut config is unexpectedly large; using the default");
        return default_config();
    }

    let mut text = String::new();
    if let Err(err) = file.take(MAX_CONFIG_BYTES).read_to_string(&mut text) {
        log::warn!("could not read global shortcut config: {err}");
        return default_config();
    }

    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            log::warn!("global shortcut config is not valid JSON ({err}); using the default");
            return default_config();
        }
    };
    config_from_json(value)
}

fn config_from_json(value: serde_json::Value) -> GlobalShortcutConfig {
    let Some(object) = value.as_object() else {
        log::warn!("global shortcut config is not an object; using the default");
        return default_config();
    };

    let enabled = match object.get("enabled") {
        Some(serde_json::Value::Bool(enabled)) => *enabled,
        Some(_) => {
            log::warn!("global shortcut enabled flag is not a boolean; using the default");
            return default_config();
        }
        // A file written by an older build that only stored the combo stays on.
        None => true,
    };

    let raw = match object.get("accelerator") {
        Some(serde_json::Value::String(accelerator)) => accelerator.as_str(),
        Some(_) => "",
        None => {
            return GlobalShortcutConfig {
                enabled,
                accelerator: default_accelerator(),
            }
        }
    };

    match canonicalize_accelerator(raw) {
        Ok(accelerator) => GlobalShortcutConfig {
            enabled,
            accelerator,
        },
        Err(err) => {
            log::warn!("ignoring saved global shortcut ({err})");
            // Keep the saved on/off choice and only replace the combo, so a
            // shortcut the user turned off is not switched back on.
            GlobalShortcutConfig {
                enabled,
                accelerator: default_accelerator(),
            }
        }
    }
}

pub fn save_config(path: &Path, config: &GlobalShortcutConfig) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| SAVE_MESSAGE.to_string())?;
    fs::create_dir_all(parent).map_err(|err| {
        log::warn!("could not create shortcut config directory: {err}");
        SAVE_MESSAGE.to_string()
    })?;

    let json = serde_json::to_string_pretty(config).map_err(|err| {
        log::warn!("could not serialize shortcut config: {err}");
        SAVE_MESSAGE.to_string()
    })?;
    // Write aside the real file and then replace it, so a crash mid-write
    // cannot leave a half-written config that would re-enable the default.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|err| {
        log::warn!("could not write shortcut config: {err}");
        SAVE_MESSAGE.to_string()
    })?;
    replace_file(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        log::warn!("could not replace shortcut config: {err}");
        SAVE_MESSAGE.to_string()
    })
}

fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(err) => {
            // Windows will not rename over a file that already exists.
            if to.exists() {
                fs::remove_file(to)?;
                fs::rename(from, to)
            } else {
                Err(err)
            }
        }
    }
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    match app.path().app_config_dir() {
        Ok(dir) => Some(dir.join(CONFIG_FILE)),
        Err(err) => {
            log::warn!("global shortcut config directory unavailable: {err}");
            None
        }
    }
}

fn focus_main_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // show() leaves a minimized window sitting in the Dock. Unminimize first
    // so the shortcut still brings the app forward.
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Drop any shortcut this app holds, then register `config` when it is on.
/// Returns the accelerator now held, or `None` when the shortcut is off.
fn apply(app: &AppHandle, config: &GlobalShortcutConfig) -> Result<Option<String>, String> {
    let shortcuts = app.global_shortcut();
    shortcuts.unregister_all().map_err(|err| {
        log::warn!("failed to release global shortcut: {err}");
        UPDATE_MESSAGE.to_string()
    })?;

    if !config.enabled {
        return Ok(None);
    }

    let accelerator = config.accelerator.clone();
    shortcuts
        .on_shortcut(accelerator.as_str(), |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                focus_main_window(app);
            }
        })
        .map(|_| Some(accelerator))
        .map_err(|err| {
            log::warn!("global shortcut registration failed: {err}");
            TAKEN_MESSAGE.to_string()
        })
}

fn resolve_request(
    current: &GlobalShortcutConfig,
    enabled: bool,
    accelerator: Option<String>,
) -> Result<GlobalShortcutConfig, String> {
    let raw = match accelerator {
        Some(value) => value,
        None => current.accelerator.clone(),
    };
    Ok(GlobalShortcutConfig {
        enabled,
        accelerator: canonicalize_accelerator(&raw)?,
    })
}

fn status_of(inner: &Inner) -> GlobalShortcutStatus {
    GlobalShortcutStatus {
        enabled: inner.config.enabled,
        accelerator: inner.config.accelerator.clone(),
        registered: inner.registered.is_some(),
        error: inner.error.clone(),
        default_accelerator: default_accelerator(),
    }
}

fn lock(state: &GlobalShortcutState) -> std::sync::MutexGuard<'_, Inner> {
    state.inner.lock().unwrap_or_else(|err| err.into_inner())
}

/// Read the saved shortcut and register it. Registration errors are stored on
/// the state and logged; they do not stop the app from opening.
pub fn install(app: &AppHandle) -> GlobalShortcutState {
    let path = config_path(app);
    let config = match &path {
        Some(path) => load_config(path),
        None => default_config(),
    };

    let (registered, error) = match apply(app, &config) {
        Ok(registered) => (registered, None),
        Err(err) => {
            log::warn!("global shortcut was not registered: {err}");
            let error = if config.enabled { Some(err) } else { None };
            (None, error)
        }
    };

    GlobalShortcutState {
        inner: Mutex::new(Inner {
            path,
            config,
            registered,
            error,
        }),
    }
}

fn restore(app: &AppHandle, previous: &Inner) -> Inner {
    let mut restored = previous.clone();
    match apply(app, &previous.config) {
        Ok(registered) => {
            restored.error = if previous.config.enabled && registered.is_none() {
                previous.error.clone()
            } else {
                None
            };
            restored.registered = registered;
        }
        Err(err) => {
            restored.registered = None;
            restored.error = Some(err);
        }
    }
    restored
}

#[tauri::command]
pub fn get_global_shortcut(state: tauri::State<'_, GlobalShortcutState>) -> GlobalShortcutStatus {
    status_of(&lock(&state))
}

#[tauri::command]
pub fn set_global_shortcut(
    app: AppHandle,
    state: tauri::State<'_, GlobalShortcutState>,
    enabled: bool,
    accelerator: Option<String>,
) -> Result<GlobalShortcutStatus, String> {
    let mut inner = lock(&state);
    let requested = resolve_request(&inner.config, enabled, accelerator)?;

    // Leave a working registration alone when nothing changed. Retry when the
    // last attempt failed, so the user can ask for the same combo again after
    // the other app has released it.
    let unchanged = requested == inner.config;
    let healthy = inner.error.is_none() && inner.registered.is_some() == requested.enabled;
    if unchanged && healthy {
        return Ok(status_of(&inner));
    }

    let path = inner.path.clone().ok_or_else(|| SAVE_MESSAGE.to_string())?;
    let previous = inner.clone();

    match apply(&app, &requested) {
        Ok(registered) => {
            let updated = Inner {
                path: Some(path.clone()),
                config: requested,
                registered,
                error: None,
            };
            if let Err(err) = save_config(&path, &updated.config) {
                *inner = restore(&app, &previous);
                return Err(err);
            }
            *inner = updated;
            Ok(status_of(&inner))
        }
        Err(err) => {
            // The new combo was declined after the old one was released.
            // Put the old one back so a conflict does not leave the user
            // with no shortcut and a setting that no longer matches.
            *inner = restore(&app, &previous);
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fe-global-shortcut-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir.join(CONFIG_FILE)
    }

    #[test]
    fn default_is_shift_and_the_primary_modifier_with_m() {
        let shortcut = Shortcut::from_str(&default_accelerator()).unwrap();
        assert_eq!(shortcut.key, Code::KeyM);
        assert!(shortcut.mods.contains(Modifiers::SHIFT));
        #[cfg(target_os = "macos")]
        assert!(shortcut.mods.contains(Modifiers::SUPER));
        #[cfg(not(target_os = "macos"))]
        assert!(shortcut.mods.contains(Modifiers::CONTROL));
        assert!(!shortcut.mods.contains(Modifiers::ALT));
    }

    #[test]
    fn command_or_control_shift_m_is_the_shipped_default() {
        let canonical = canonicalize_accelerator("CommandOrControl+Shift+M").unwrap();
        assert_eq!(canonical, default_accelerator());
        assert_eq!(
            canonicalize_accelerator("CommandOrControl+Shift+KeyM").unwrap(),
            default_accelerator()
        );
    }

    #[test]
    fn command_and_control_stay_distinct() {
        let command = canonicalize_accelerator("cmd+shift+m").unwrap();
        let control = canonicalize_accelerator("ctrl+shift+m").unwrap();
        assert_ne!(command, control);
        assert_eq!(command, "shift+super+KeyM");
        assert_eq!(control, "shift+control+KeyM");
    }

    #[test]
    fn spaces_and_aliases_canonicalize() {
        assert_eq!(
            canonicalize_accelerator("CTRL + ALT + K").unwrap(),
            "control+alt+KeyK"
        );
        assert_eq!(canonicalize_accelerator("option+1").unwrap(), "alt+Digit1");
        assert_eq!(canonicalize_accelerator("super+f5").unwrap(), "super+F5");
    }

    #[test]
    fn shift_alone_and_a_bare_key_are_refused() {
        for raw in ["m", "KeyM", "shift+m", "shift+KeyM", "shift+f1", ""] {
            let err = canonicalize_accelerator(raw).unwrap_err();
            assert!(
                err.contains("Ctrl") || err.contains("supported"),
                "{raw}: {err}"
            );
        }
    }

    #[test]
    fn modifiers_without_a_key_and_control_characters_are_refused() {
        assert!(canonicalize_accelerator("shift+ctrl").is_err());
        assert!(canonicalize_accelerator("ctrl+shift+m\n").is_err());
        assert!(canonicalize_accelerator(&format!("ctrl+{}", "a".repeat(80))).is_err());
        assert!(canonicalize_accelerator("ctrl+notakey").is_err());
    }

    #[test]
    fn a_missing_file_uses_the_shipped_default() {
        let path = temp_path("missing");
        assert_eq!(load_config(&path), default_config());
    }

    #[test]
    fn config_round_trips() {
        let path = temp_path("roundtrip");
        let config = GlobalShortcutConfig {
            enabled: false,
            accelerator: canonicalize_accelerator("ctrl+alt+k").unwrap(),
        };
        save_config(&path, &config).unwrap();
        assert_eq!(load_config(&path), config);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn invalid_json_falls_back_to_the_default() {
        let path = temp_path("garbage");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load_config(&path), default_config());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_disabled_shortcut_stays_off_when_its_combo_cannot_be_parsed() {
        let path = temp_path("disabled-bad");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"enabled":false,"accelerator":"shift+m"}"#).unwrap();
        let loaded = load_config(&path);
        assert!(!loaded.enabled);
        assert_eq!(loaded.accelerator, default_accelerator());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn an_enabled_unusable_combo_falls_back_to_the_default_combo() {
        let path = temp_path("enabled-bad");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"enabled":true,"accelerator":"m"}"#).unwrap();
        assert_eq!(load_config(&path), default_config());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_saved_combo_is_canonicalized_on_load() {
        let path = temp_path("alias");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"enabled":true,"accelerator":"Ctrl + Shift + K"}"#,
        )
        .unwrap();
        let loaded = load_config(&path);
        assert!(loaded.enabled);
        assert_eq!(loaded.accelerator, "shift+control+KeyK");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn saving_replaces_an_existing_file() {
        let path = temp_path("replace");
        let first = default_config();
        let second = GlobalShortcutConfig {
            enabled: false,
            accelerator: first.accelerator.clone(),
        };
        save_config(&path, &first).unwrap();
        save_config(&path, &second).unwrap();
        assert_eq!(load_config(&path), second);
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
