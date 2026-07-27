use tauri::{
    plugin::{Builder as TauriPluginBuilder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

// ---------------------------------------------------------------------------
// Foreground presentation configuration (iOS)
// ---------------------------------------------------------------------------

/// Controls what iOS does when a notification arrives while the app is in
/// the foreground. Maps directly to `UNNotificationPresentationOptions`.
///
/// Apps that mirror their notification content inside the UI (chat,
/// messaging) typically want `silent()` so the user isn't interrupted by a
/// banner while looking at the conversation. Apps where notifications are
/// independently meaningful (reminders, alerts) should keep the default.
///
/// iOS bypasses this entirely when the app is backgrounded or the phone is
/// locked — in those states the system shows the notification natively.
#[derive(Debug, Clone, Copy)]
pub struct ForegroundPresentationOptions {
    /// Show the transient banner dropdown.
    pub banner: bool,
    /// Record the notification in Notification Center / Lock Screen list.
    pub list: bool,
    /// Play the notification sound.
    pub sound: bool,
    /// Update the app icon badge number.
    pub badge: bool,
}

impl Default for ForegroundPresentationOptions {
    /// Pre-0.1.4 hardcoded behavior: banner + list + sound + badge.
    /// Preserved as the default so upgrading doesn't silently change UX.
    fn default() -> Self {
        Self {
            banner: true,
            list: true,
            sound: true,
            badge: true,
        }
    }
}

impl ForegroundPresentationOptions {
    /// No banner or sound, but still recorded in Notification Center and
    /// increments the badge. The recommended preset for chat-style apps
    /// where the notification content is already visible in-app.
    pub fn silent() -> Self {
        Self {
            banner: false,
            list: true,
            sound: false,
            badge: true,
        }
    }

    /// Fully invisible — no banner, no list entry, no sound, no badge.
    /// Use for data-only / silent push where the JS event handler does
    /// all the work.
    pub fn none() -> Self {
        Self {
            banner: false,
            list: false,
            sound: false,
            badge: false,
        }
    }

    /// Matches `UNNotificationPresentationOptions.rawValue` bits:
    ///   badge = 1 << 0, sound = 1 << 1, list = 1 << 3, banner = 1 << 4.
    fn to_bitmask(self) -> u32 {
        let mut bits = 0u32;
        if self.badge {
            bits |= 1 << 0;
        }
        if self.sound {
            bits |= 1 << 1;
        }
        if self.list {
            bits |= 1 << 3;
        }
        if self.banner {
            bits |= 1 << 4;
        }
        bits
    }
}

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

/// Fluent builder for the mobile-push plugin.
///
/// Usage:
///
/// ```ignore
/// // default: banner + list + sound + badge when foreground
/// tauri_plugin_mobile_push::init()
///
/// // silent (recommended for chat apps):
/// tauri_plugin_mobile_push::Builder::new()
///     .ios_foreground_presentation(
///         tauri_plugin_mobile_push::ForegroundPresentationOptions::silent(),
///     )
///     .build()
/// ```
pub struct Builder {
    ios_foreground_presentation: ForegroundPresentationOptions,
}

impl Default for Builder {
    fn default() -> Self {
        Self::new()
    }
}

impl Builder {
    pub fn new() -> Self {
        Self {
            ios_foreground_presentation: ForegroundPresentationOptions::default(),
        }
    }

    /// Configure how notifications are presented when the app is in the
    /// foreground on iOS. No effect on Android or desktop.
    pub fn ios_foreground_presentation(
        mut self,
        options: ForegroundPresentationOptions,
    ) -> Self {
        self.ios_foreground_presentation = options;
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let foreground_bits = self.ios_foreground_presentation.to_bitmask();

        TauriPluginBuilder::<R, ()>::new("mobile-push")
            .invoke_handler(tauri::generate_handler![
                commands::request_permission,
                commands::get_token,
                commands::register_listener
            ])
            .setup(move |app, api| {
                #[cfg(mobile)]
                let mobile_push = mobile::init(app, api)?;
                #[cfg(desktop)]
                let mobile_push = desktop::init(app, api)?;
                app.manage(mobile_push);

                // Push the configured foreground options into the Swift
                // runtime now that `register_ios_plugin` has initialized it.
                #[cfg(target_os = "ios")]
                unsafe {
                    mobile_push_set_foreground_presentation(foreground_bits);
                }
                #[cfg(not(target_os = "ios"))]
                let _ = foreground_bits;

                Ok(())
            })
            .build()
    }
}

#[cfg(target_os = "ios")]
extern "C" {
    fn mobile_push_set_foreground_presentation(options: u32);
}

/// Initializes the plugin with default configuration
/// (banner + list + sound + badge when foreground).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}
