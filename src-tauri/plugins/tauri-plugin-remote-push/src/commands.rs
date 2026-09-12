use tauri::{command, AppHandle, Runtime};

use crate::{PermissionState, RemotePushExt, Result};

// Both commands are async so Tauri spawns them instead of running them inline
// on the IPC thread under the plugin store mutex. A sync command that waits on
// the Android main thread from under that mutex deadlocks against wry's
// onPageLoaded, which also takes it. See the unified-push plugin for the
// full write-up; the same ANR shape applies here.

#[command]
pub(crate) async fn get_token<R: Runtime>(app: AppHandle<R>) -> Result<String> {
    app.remote_push().get_token().await
}

#[command]
pub(crate) async fn request_permission<R: Runtime>(app: AppHandle<R>) -> Result<PermissionState> {
    app.remote_push().request_permission().await
}
