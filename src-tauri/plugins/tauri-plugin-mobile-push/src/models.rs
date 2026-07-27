use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct PermissionResponse {
    pub granted: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TokenResponse {
    pub token: String,
}
