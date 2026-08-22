use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::rngs::OsRng;

use crate::error::AuthError;

/// Unambiguous alphabet for generated temp passwords: `0O1lIo` are excluded
/// (spec requires `0O1lI`; `o` is excluded too so `o`/`0` can't be confused)
/// so the password survives being read aloud or retyped by a locked-out
/// owner. 24 upper + 24 lower + 8 digits = 56 characters.
const TEMP_PASSWORD_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const TEMP_PASSWORD_LEN: usize = 20;

/// Hash a plaintext password using Argon2id, returning the PHC-encoded string
/// safe to store verbatim in `password_credentials.password_hash`.
pub fn hash_password(plaintext: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default().hash_password(plaintext.as_bytes(), &salt)?;
    Ok(hash.to_string())
}

/// Generate a random 20-character temp password from an unambiguous
/// alphabet. Used by the `castify reset-password` recovery path only.
pub fn generate_temp_password() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let alphabet = TEMP_PASSWORD_ALPHABET.as_bytes();
    (0..TEMP_PASSWORD_LEN)
        .map(|_| alphabet[rng.gen_range(0..alphabet.len())] as char)
        .collect()
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

    #[test]
    fn temp_password_is_20_chars_from_unambiguous_alphabet() {
        for _ in 0..100 {
            let p = generate_temp_password();
            assert_eq!(p.chars().count(), 20, "got {p}");
            assert!(p.chars().all(|c| c.is_ascii_alphanumeric()), "got {p}");
            for ambiguous in ['0', 'O', '1', 'l', 'I', 'o'] {
                assert!(!p.contains(ambiguous), "{ambiguous} in {p}");
            }
        }
    }

    #[test]
    fn temp_passwords_differ_between_draws() {
        // Collision odds across a 57-char alphabet at length 20 are
        // astronomically small; a single differing pair proves randomness
        // is actually wired in (vs a constant).
        let a = generate_temp_password();
        let b = generate_temp_password();
        assert_ne!(a, b);
    }
}
