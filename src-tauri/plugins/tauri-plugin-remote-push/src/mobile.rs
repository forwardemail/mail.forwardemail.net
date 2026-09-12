use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_remote_push);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  _api: PluginApi<R, C>,
  _config: Option<Config>,
) -> crate::Result<RemotePush<R>> {
  #[cfg(target_os = "android")]
  let handle = {
    let handle = _api.register_android_plugin("app.tauri.remotepush", "PushNotificationPlugin")?;
    handle
  };
  #[cfg(target_os = "ios")]
  let handle = _api.register_ios_plugin(init_plugin_remote_push)?;
  Ok(RemotePush(handle))
}

/// Access to the remote-push APIs.
pub struct RemotePush<R: Runtime>(PluginHandle<R>);

// run_mobile_plugin_async rather than run_mobile_plugin: the sync variant
// parks the calling thread until the native side answers on the main thread,
// and when that caller is the IPC thread holding the plugin store mutex the
// main thread can deadlock against it in wry's onPageLoaded.
impl<R: Runtime> RemotePush<R> {
  pub async fn get_token(&self) -> crate::Result<String> {
    self.0
      .run_mobile_plugin_async::<TokenResponse>("getToken", ())
      .await
      .map(|response| response.token)
      .map_err(Into::into)
  }

  pub async fn request_permission(&self) -> crate::Result<PermissionState> {
    self.0
      .run_mobile_plugin_async("requestPermissions", ())
      .await
      .map_err(Into::into)
  }
}
