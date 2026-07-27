use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mobile_push);

/// Initializes the Kotlin or Swift plugin classes.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<MobilePush<R>> {
    log::info!("[mobile-push] mobile::init() called");
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("app.tauri.mobilepush", "MobilePushPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mobile_push)?;
    log::info!("[mobile-push] Plugin registered successfully");
    Ok(MobilePush(handle))
}

/// Plugin handle. Kept for Tauri's managed state requirement.
/// Commands now use direct FFI instead of run_mobile_plugin.
pub struct MobilePush<R: Runtime>(PluginHandle<R>);
