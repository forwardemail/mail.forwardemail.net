use tauri::{command, AppHandle, Runtime};

use crate::{models::*, Result, UnifiedPushExt};

// Every command here is async on purpose. Tauri runs a sync command inline on
// the IPC thread while holding the plugin store mutex, and run_mobile_plugin
// then parks that thread until the Kotlin side answers on the Android main
// thread. The main thread takes the same mutex from wry's onPageLoaded, which
// Chromium fires for every hash navigation, not just the first load. If both
// happen at once the app deadlocks and Android reports a 10s input ANR. An
// async command is spawned onto the async runtime instead, so the mutex is
// released before we wait on the main thread.

#[command]
pub(crate) async fn get_state<R: Runtime>(app: AppHandle<R>) -> Result<UnifiedPushState> {
    app.unified_push().get_state().await
}

#[command]
pub(crate) async fn register<R: Runtime>(
    app: AppHandle<R>,
    instance: String,
    message_for_distributor: String,
    vapid_public_key: String,
) -> Result<()> {
    app.unified_push()
        .register(RegisterRequest {
            instance,
            message_for_distributor,
            vapid_public_key,
        })
        .await
}

#[command]
pub(crate) async fn pick_distributor<R: Runtime>(
    app: AppHandle<R>,
    instance: String,
    message_for_distributor: String,
    vapid_public_key: String,
) -> Result<()> {
    app.unified_push()
        .pick_distributor(RegisterRequest {
            instance,
            message_for_distributor,
            vapid_public_key,
        })
        .await
}

#[command]
pub(crate) async fn drain_messages<R: Runtime>(app: AppHandle<R>) -> Result<DrainMessagesResult> {
    app.unified_push().drain_messages().await
}

#[command]
pub(crate) async fn unregister<R: Runtime>(app: AppHandle<R>, instance: String) -> Result<()> {
    app.unified_push()
        .unregister(UnregisterRequest { instance })
        .await
}
