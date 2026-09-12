use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{DrainMessagesResult, RegisterRequest, UnifiedPushState, UnregisterRequest};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<UnifiedPush<R>> {
    let handle =
        api.register_android_plugin("net.forwardemail.unifiedpush", "UnifiedPushPlugin")?;
    Ok(UnifiedPush(handle))
}

pub struct UnifiedPush<R: Runtime>(PluginHandle<R>);

// These all go through run_mobile_plugin_async rather than run_mobile_plugin.
// The sync variant blocks the calling thread on a channel until the Kotlin
// command has run on the Android main thread. Called from a sync Tauri
// command that thread is the IPC thread holding the plugin store mutex, and
// the main thread contends for that mutex in wry's onPageLoaded, which is the
// deadlock behind the ANRs. Keep the plugin free of blocking waits so the
// commands in commands.rs can stay async.
impl<R: Runtime> UnifiedPush<R> {
    pub async fn get_state(&self) -> crate::Result<UnifiedPushState> {
        self.0
            .run_mobile_plugin_async("getState", ())
            .await
            .map_err(Into::into)
    }

    pub async fn register(&self, request: RegisterRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin_async("register", request)
            .await
            .map_err(Into::into)
    }

    pub async fn pick_distributor(&self, request: RegisterRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin_async("pickDistributor", request)
            .await
            .map_err(Into::into)
    }

    pub async fn drain_messages(&self) -> crate::Result<DrainMessagesResult> {
        self.0
            .run_mobile_plugin_async("drainMessages", ())
            .await
            .map_err(Into::into)
    }

    pub async fn unregister(&self, request: UnregisterRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin_async("unregister", request)
            .await
            .map_err(Into::into)
    }
}
