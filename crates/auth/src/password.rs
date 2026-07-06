use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::rngs::OsRng;

use crate::error::AuthError;

/// Hash a plaintext password using Argon2id, returning the PHC-encoded string
/// safe to store verbatim in `password_credentials.password_hash`.
pub fn hash_password(plaintext: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default().hash_password(plaintext.as_bytes(), &salt)?;
    Ok(hash.to_string())
}

/// Verify a plaintext password against a stored PHC-encoded hash.
///
/// Returns `Ok(())` on success and `Err(AuthError::InvalidCredentials)` when
/// either the password is wrong or the hash is malformed.
pub fn verify_password(plaintext: &str, stored_phc: &str) -> Result<(), AuthError> {
    let parsed = PasswordHash::new(stored_phc).map_err(|e| {
        tracing::warn!(error = ?e, "password hash was malformed");
        AuthError::InvalidCredentials
    })?;
    Argon2::default()
        .verify_password(plaintext.as_bytes(), &parsed)
        .map_err(|_| AuthError::InvalidCredentials)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_round_trips() {
        let hash = hash_password("hunter2").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("hunter2", &hash).is_ok());
        assert!(verify_password("wrong", &hash).is_err());
    }

    #[test]
    fn verify_rejects_malformed_hash() {
        assert!(matches!(
            verify_password("x", "not-a-hash"),
            Err(AuthError::InvalidCredentials)
        ));
    }
}
