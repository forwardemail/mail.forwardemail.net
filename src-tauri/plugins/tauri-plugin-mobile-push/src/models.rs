use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct PermissionResponse {
    pub granted: bool,
    /// "granted" | "denied" | "previously-denied" | "timeout" | "error" | "unsupported".
    /// "previously-denied" means iOS will not show the prompt again; the user
    /// must re-enable notifications in the Settings app.
    #[serde(default)]
    pub status: String,
    /// Native error text, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TokenResponse {
    pub token: String,
}
