use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<MobilePush<R>> {
    Ok(MobilePush(app.clone()))
}

/// Plugin handle. Kept for Tauri's managed state requirement.
/// Commands return stub values on desktop (push notifications are mobile-only).
pub struct MobilePush<R: Runtime>(AppHandle<R>);
