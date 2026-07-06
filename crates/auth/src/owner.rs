use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Owner {
    pub id: Uuid,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewOwner {
    pub id: Uuid,
    pub display_name: Option<String>,
}

impl NewOwner {
    pub fn new(display_name: Option<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            display_name,
        }
    }

    /// Construct a `NewOwner` with a caller-supplied id. Used by WebAuthn
    /// setup, where the owner id must match the WebAuthn user handle that was
    /// bound to the credential at `begin` time.
    pub fn with_id(id: Uuid, display_name: Option<String>) -> Self {
        Self { id, display_name }
    }
}
