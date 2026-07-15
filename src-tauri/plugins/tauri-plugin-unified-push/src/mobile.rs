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

impl<R: Runtime> UnifiedPush<R> {
    pub fn get_state(&self) -> crate::Result<UnifiedPushState> {
        self.0.run_mobile_plugin("getState", ()).map_err(Into::into)
    }

    pub fn register(&self, request: RegisterRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("register", request)
            .map_err(Into::into)
    }

    pub fn pick_distributor(&self, request: RegisterRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("pickDistributor", request)
            .map_err(Into::into)
    }

    pub fn drain_messages(&self) -> crate::Result<DrainMessagesResult> {
        self.0
            .run_mobile_plugin("drainMessages", ())
            .map_err(Into::into)
    }

    pub fn unregister(&self, request: UnregisterRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("unregister", request)
            .map_err(Into::into)
    }
}
