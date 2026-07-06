use base64::Engine;
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
use sqlx::SqlitePool;

use crate::error::{AuthError, AuthResult};

type HmacSha256 = Hmac<Sha256>;

const SESSION_ID_BYTES: usize = 32;
const SECRET_BYTES: usize = 32;
const SESSION_SECRET_KEY: &str = "session_secret";

/// Server-side HMAC secret used to sign session cookies. Stable across
/// restarts: loaded from `app_meta` (or auto-generated and persisted on first
/// boot) unless `CASTIFY_SESSION_SECRET` overrides it.
#[derive(Clone, Debug)]
pub struct SessionSecret(Vec<u8>);

impl SessionSecret {
    pub fn from_bytes(bytes: Vec<u8>) -> AuthResult<Self> {
        if bytes.len() < 32 {
            return Err(AuthError::Validation(format!(
                "session secret must be at least 32 bytes; got {}",
                bytes.len()
            )));
        }
        Ok(Self(bytes))
    }

    /// Resolve the session secret, preferring `env_value`, then a stored row in
    /// `app_meta`, finally generating and persisting a fresh secret.
    pub async fn resolve(pool: &SqlitePool, env_value: Option<String>) -> AuthResult<Self> {
        if let Some(raw) = env_value {
            let bytes = decode_or_raw(&raw)?;
            return Self::from_bytes(bytes);
        }

        if let Some(stored) =
            sqlx::query_scalar::<_, String>("SELECT value FROM app_meta WHERE key = ?")
                .bind(SESSION_SECRET_KEY)
                .fetch_optional(pool)
                .await?
        {
            let bytes = decode_or_raw(&stored)?;
            return Self::from_bytes(bytes);
        }

        let mut bytes = vec![0u8; SECRET_BYTES];
        OsRng.fill_bytes(&mut bytes);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let now = iso_now();
        sqlx::query("INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)")
            .bind(SESSION_SECRET_KEY)
            .bind(&encoded)
            .bind(&now)
            .execute(pool)
            .await?;
        tracing::info!("generated and persisted a new session secret");
        Self::from_bytes(bytes)
    }

    fn mac(&self) -> AuthResult<HmacSha256> {
        HmacSha256::new_from_slice(&self.0)
            .map_err(|e| AuthError::Internal(anyhow::anyhow!("hmac init failed: {e}")))
    }

    pub fn sign(&self, payload: &str) -> AuthResult<String> {
        let mut mac = self.mac()?;
        mac.update(payload.as_bytes());
        let tag = mac.finalize().into_bytes();
        Ok(format!(
            "{payload}.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(tag)
        ))
    }

    pub fn verify(&self, signed: &str) -> AuthResult<String> {
        let (payload, tag_b64) = signed.rsplit_once('.').ok_or(AuthError::InvalidSession)?;
        let mut mac = self.mac()?;
        mac.update(payload.as_bytes());
        let expected = mac.finalize().into_bytes();
        let provided = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(tag_b64.trim())?;
        if expected.as_slice() == provided.as_slice() {
            Ok(payload.to_string())
        } else {
            Err(AuthError::InvalidSession)
        }
    }
}

fn decode_or_raw(raw: &str) -> AuthResult<Vec<u8>> {
    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(raw) {
        return Ok(decoded);
    }
    Ok(raw.as_bytes().to_vec())
}

/// An opaque session ID — the database primary key for `sessions`.
#[derive(Clone, Debug)]
pub struct SessionId(pub String);

impl SessionId {
    /// Generate a fresh, cryptographically random session id (base64url, no pad).
    pub fn generate() -> Self {
        let mut bytes = [0u8; SESSION_ID_BYTES];
        OsRng.fill_bytes(&mut bytes);
        Self(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
    }
}

/// A session token as it travels in the signed cookie: `<session_id>.<hmac>`.
#[derive(Clone, Debug)]
pub struct SessionToken(pub String);

impl SessionToken {
    pub fn issue(secret: &SessionSecret, id: &SessionId) -> AuthResult<Self> {
        Ok(Self(secret.sign(&id.0)?))
    }

    pub fn verify(&self, secret: &SessionSecret) -> AuthResult<SessionId> {
        secret.verify(&self.0).map(SessionId)
    }
}

pub fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn iso_in(days: i64) -> String {
    chrono::Utc::now()
        .checked_add_signed(chrono::Duration::days(days))
        .expect("valid timestamp")
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_secret() -> SessionSecret {
        SessionSecret::from_bytes(vec![1u8; 32]).unwrap()
    }

    #[test]
    fn sign_verify_round_trips() {
        let s = test_secret();
        let id = SessionId::generate();
        let token = SessionToken::issue(&s, &id).unwrap();
        let recovered = token.verify(&s).unwrap();
        assert_eq!(recovered.0, id.0);
    }

    #[test]
    fn verify_rejects_tampered_token() {
        let s = test_secret();
        let id = SessionId::generate();
        let mut raw = SessionToken::issue(&s, &id).unwrap().0;
        // Flip the last character of the tag.
        let last = raw.pop().unwrap();
        raw.push(if last == 'a' { 'b' } else { 'a' });
        let tampered = SessionToken(raw);
        assert!(tampered.verify(&s).is_err());
    }

    #[test]
    fn verify_rejects_foreign_secret() {
        let s1 = SessionSecret::from_bytes(vec![1u8; 32]).unwrap();
        let s2 = SessionSecret::from_bytes(vec![2u8; 32]).unwrap();
        let id = SessionId::generate();
        let token = SessionToken::issue(&s1, &id).unwrap();
        assert!(token.verify(&s2).is_err());
    }

    #[test]
    fn rejects_short_secret() {
        let err = SessionSecret::from_bytes(vec![0u8; 10]).unwrap_err();
        assert!(matches!(err, AuthError::Validation(_)));
    }
}
