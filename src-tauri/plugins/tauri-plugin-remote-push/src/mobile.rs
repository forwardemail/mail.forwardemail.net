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

impl<R: Runtime> RemotePush<R> {
  pub fn get_token(&self) -> crate::Result<String> {
    self.0
      .run_mobile_plugin::<TokenResponse>("getToken", ())
      .map(|response| response.token)
      .map_err(Into::into)
  }

  pub fn request_permission(&self) -> crate::Result<PermissionState> {
    self.0
      .run_mobile_plugin("requestPermissions", ())
      .map_err(Into::into)
  }
}
