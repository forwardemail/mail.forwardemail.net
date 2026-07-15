use tauri::{command, AppHandle, Runtime};

use crate::{models::*, Result, UnifiedPushExt};

#[command]
pub(crate) fn get_state<R: Runtime>(app: AppHandle<R>) -> Result<UnifiedPushState> {
    app.unified_push().get_state()
}

#[command]
pub(crate) fn register<R: Runtime>(
    app: AppHandle<R>,
    instance: String,
    message_for_distributor: String,
    vapid_public_key: String,
) -> Result<()> {
    app.unified_push().register(RegisterRequest {
        instance,
        message_for_distributor,
        vapid_public_key,
    })
}

#[command]
pub(crate) fn pick_distributor<R: Runtime>(
    app: AppHandle<R>,
    instance: String,
    message_for_distributor: String,
    vapid_public_key: String,
) -> Result<()> {
    app.unified_push().pick_distributor(RegisterRequest {
        instance,
        message_for_distributor,
        vapid_public_key,
    })
}

#[command]
pub(crate) fn drain_messages<R: Runtime>(app: AppHandle<R>) -> Result<DrainMessagesResult> {
    app.unified_push().drain_messages()
}

#[command]
pub(crate) fn unregister<R: Runtime>(app: AppHandle<R>, instance: String) -> Result<()> {
    app.unified_push()
        .unregister(UnregisterRequest { instance })
}
