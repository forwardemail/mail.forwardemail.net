use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod error;
mod mobile;
mod models;

pub use error::{Error, Result};
pub use mobile::UnifiedPush;
pub use models::*;

/// Access to the Android UnifiedPush connector.
pub trait UnifiedPushExt<R: Runtime> {
    fn unified_push(&self) -> &UnifiedPush<R>;
}

impl<R: Runtime, T: Manager<R>> UnifiedPushExt<R> for T {
    fn unified_push(&self) -> &UnifiedPush<R> {
        self.state::<UnifiedPush<R>>().inner()
    }
}

/// Initialize the Android UnifiedPush connector plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("unified-push")
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::register,
            commands::pick_distributor,
            commands::drain_messages,
            commands::unregister
        ])
        .setup(|app, api| {
            let unified_push = mobile::init(app, api)?;
            app.manage(unified_push);
            Ok(())
        })
        .build()
}
