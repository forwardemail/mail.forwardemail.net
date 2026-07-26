use tauri::{
  plugin::{Builder, TauriPlugin},
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

#[cfg(desktop)]
use desktop::RemotePush;
#[cfg(mobile)]
use mobile::RemotePush;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the remote-push APIs.
pub trait RemotePushExt<R: Runtime> {
  fn remote_push(&self) -> &RemotePush<R>;
}

impl<R: Runtime, T: Manager<R>> crate::RemotePushExt<R> for T {
  fn remote_push(&self) -> &RemotePush<R> {
    self.state::<RemotePush<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R, Option<Config>> {
  Builder::<R, Option<Config>>::new("remote-push")
    .invoke_handler(tauri::generate_handler![
      commands::get_token,
      commands::request_permission
    ])
    .setup(|app, api| {
      let config = api.config().clone();
      #[cfg(mobile)]
      let remote_push = mobile::init(app, api, config)?;
      #[cfg(desktop)]
      let remote_push = desktop::init(app, api, config)?;
      app.manage(remote_push);
      Ok(())
    })
    .build()
}
