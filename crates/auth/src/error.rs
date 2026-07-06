#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("owner already exists; setup is complete")]
    OwnerAlreadyExists,
    #[error("no owner is configured; run first-run setup")]
    NoOwner,
    #[error("invalid credentials")]
    InvalidCredentials,
    #[error("invalid session")]
    InvalidSession,
    #[error("session expired")]
    SessionExpired,
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("webauthn error: {0}")]
    Webauthn(String),
    #[error("password hash error: {0}")]
    PasswordHash(String),
    #[error("database error: {0}")]
    Storage(#[from] sqlx::Error),
    #[error("database row count unexpected: {0}")]
    RowCount(String),
    #[error("base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl From<argon2::password_hash::Error> for AuthError {
    fn from(value: argon2::password_hash::Error) -> Self {
        AuthError::PasswordHash(value.to_string())
    }
}

pub type AuthResult<T> = Result<T, AuthError>;
