use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedPushSubscription {
    pub instance: String,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub temporary: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedPushState {
    pub available_distributors: Vec<String>,
    pub distributor: Option<String>,
    pub selection_required: bool,
    pub subscription: Option<UnifiedPushSubscription>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub instance: String,
    pub payload: serde_json::Value,
    pub displayed_by_system: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainMessagesResult {
    pub messages: Vec<QueuedMessage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub instance: String,
    pub message_for_distributor: String,
    pub vapid_public_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnregisterRequest {
    pub instance: String,
}
