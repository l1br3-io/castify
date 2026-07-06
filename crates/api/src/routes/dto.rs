//! Response DTOs shared across `/api/setup*` and `/api/session*` routes.
use serde::Serialize;

/// Owner representation returned by setup and session endpoints.
#[derive(Debug, Serialize)]
pub struct OwnerDto {
    pub id: String,
    pub display_name: Option<String>,
}

impl OwnerDto {
    pub fn from_owner(owner: &castify_auth::Owner) -> Self {
        Self {
            id: owner.id.to_string(),
            display_name: owner.display_name.clone(),
        }
    }
}
