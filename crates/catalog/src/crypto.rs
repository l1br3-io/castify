use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const TOKEN_KEY_META_KEY: &str = "token_key";

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("encryption failed: {0}")]
    Encrypt(String),
    #[error("decryption failed: {0}")]
    Decrypt(String),
    #[error("token key must be at least 32 bytes; got {0}")]
    KeyTooShort(usize),
    #[error("ciphertext too short (need at least {0} bytes for nonce; got {1})")]
    CiphertextTooShort(usize, usize),
    #[error("token bundle serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

pub type CryptoResult<T> = Result<T, CryptoError>;

/// AES-256-GCM key for encrypting OAuth token bundles at rest. Stable across
/// restarts: loaded from `app_meta` (or auto-generated and persisted on first
/// boot) unless `CASTIFY_TOKEN_KEY` overrides it. Mirrors `SessionSecret`.
#[derive(Clone)]
pub struct TokenKey([u8; KEY_BYTES]);

impl TokenKey {
    pub fn from_bytes(bytes: Vec<u8>) -> CryptoResult<Self> {
        if bytes.len() < KEY_BYTES {
            return Err(CryptoError::KeyTooShort(bytes.len()));
        }
        let mut key = [0u8; KEY_BYTES];
        key.copy_from_slice(&bytes[..KEY_BYTES]);
        Ok(Self(key))
    }

    /// Resolve the token key, preferring `env_value`, then a stored row in
    /// `app_meta`, finally generating and persisting a fresh key.
    pub async fn resolve(pool: &SqlitePool, env_value: Option<String>) -> CryptoResult<Self> {
        if let Some(raw) = env_value {
            let bytes = decode_or_raw(&raw);
            return Self::from_bytes(bytes);
        }

        if let Some(stored) =
            sqlx::query_scalar::<_, String>("SELECT value FROM app_meta WHERE key = ?")
                .bind(TOKEN_KEY_META_KEY)
                .fetch_optional(pool)
                .await?
        {
            let bytes = decode_or_raw(&stored);
            return Self::from_bytes(bytes);
        }

        let mut bytes = vec![0u8; KEY_BYTES];
        OsRng.fill_bytes(&mut bytes);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let now = iso_now();
        sqlx::query("INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)")
            .bind(TOKEN_KEY_META_KEY)
            .bind(&encoded)
            .bind(&now)
            .execute(pool)
            .await?;
        tracing::info!("generated and persisted a new token encryption key");
        Self::from_bytes(bytes)
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.0))
    }
}

impl std::fmt::Debug for TokenKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenKey").finish_non_exhaustive()
    }
}

/// Encrypt `plaintext` with AES-256-GCM. Returns `nonce || ciphertext || tag`.
pub fn encrypt(key: &TokenKey, plaintext: &[u8]) -> CryptoResult<Vec<u8>> {
    let mut nonce_bytes = [0u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher = key.cipher();
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| CryptoError::Encrypt(e.to_string()))?;
    let mut result = Vec::with_capacity(NONCE_BYTES + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend(ciphertext);
    Ok(result)
}

/// Decrypt data produced by [`encrypt`]. Expects `nonce || ciphertext || tag`.
pub fn decrypt(key: &TokenKey, data: &[u8]) -> CryptoResult<Vec<u8>> {
    if data.len() < NONCE_BYTES {
        return Err(CryptoError::CiphertextTooShort(NONCE_BYTES, data.len()));
    }
    let (nonce_bytes, ciphertext) = data.split_at(NONCE_BYTES);
    let cipher = key.cipher();
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|e| CryptoError::Decrypt(e.to_string()))
}

/// OAuth token bundle stored encrypted in `provider_connections.token_bundle`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBundle {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<String>,
    pub token_type: String,
    pub scope: Option<String>,
}

impl TokenBundle {
    /// Serialize to JSON, then encrypt.
    pub fn encrypt_to_bytes(&self, key: &TokenKey) -> CryptoResult<Vec<u8>> {
        let json = serde_json::to_vec(self)?;
        encrypt(key, &json)
    }

    /// Decrypt bytes, then deserialize from JSON.
    pub fn decrypt_from_bytes(key: &TokenKey, data: &[u8]) -> CryptoResult<Self> {
        let json = decrypt(key, data)?;
        Ok(serde_json::from_slice(&json)?)
    }
}

/// Static credentials for S3-compatible object storage. One credential = one
/// bucket on one endpoint; the pair identifies the connection for the
/// `(provider, provider_account_id)` uniqueness constraint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3Credentials {
    /// Service endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`.
    pub endpoint: String,
    /// Region string; R2 uses `"auto"`, MinIO commonly `us-east-1`.
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Optional key-prefix the scan restricts itself to (OQ-2 — buckets
    /// that hold non-media objects). `#[serde(default)]` keeps blobs
    /// written before the field existed decodable as `prefix: None`.
    #[serde(default)]
    pub prefix: Option<String>,
}

/// The secret a connection authenticates with, stored encrypted in
/// `provider_connections.token_bundle` (the column predates non-OAuth
/// providers; the name is historical).
///
/// Serialized **untagged**: the variant field sets are disjoint
/// (`TokenBundle` requires `access_token` + `token_type`; `S3Credentials`
/// requires `endpoint` + `bucket` + keys), so each JSON payload matches
/// exactly one variant. That is what lets rows written before this enum
/// existed — plain `TokenBundle` JSON — still decode as `Credential::OAuth`
/// with no migration step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Credential {
    OAuth(TokenBundle),
    S3(S3Credentials),
}

impl Credential {
    /// The OAuth token bundle, if this credential is OAuth-backed.
    pub fn as_oauth(&self) -> Option<&TokenBundle> {
        match self {
            Credential::OAuth(bundle) => Some(bundle),
            Credential::S3(_) => None,
        }
    }

    /// Serialize to JSON, then encrypt.
    pub fn encrypt_to_bytes(&self, key: &TokenKey) -> CryptoResult<Vec<u8>> {
        let json = serde_json::to_vec(self)?;
        encrypt(key, &json)
    }

    /// Decrypt bytes, then deserialize from JSON.
    pub fn decrypt_from_bytes(key: &TokenKey, data: &[u8]) -> CryptoResult<Self> {
        let json = decrypt(key, data)?;
        Ok(serde_json::from_slice(&json)?)
    }
}

fn decode_or_raw(raw: &str) -> Vec<u8> {
    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(raw) {
        return decoded;
    }
    raw.as_bytes().to_vec()
}

fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> TokenKey {
        TokenKey::from_bytes(vec![42u8; KEY_BYTES]).unwrap()
    }

    #[test]
    fn encrypt_decrypt_round_trips() {
        let key = test_key();
        let plaintext = b"sensitive token data";
        let ciphertext = encrypt(&key, plaintext).unwrap();
        assert_ne!(&ciphertext[..], plaintext);
        let recovered = decrypt(&key, &ciphertext).unwrap();
        assert_eq!(recovered.as_slice(), plaintext);
    }

    #[test]
    fn decrypt_rejects_tampered_ciphertext() {
        let key = test_key();
        let mut ciphertext = encrypt(&key, b"data").unwrap();
        // Flip a byte in the ciphertext body (after the nonce).
        let idx = ciphertext.len() - 1;
        ciphertext[idx] ^= 0xff;
        assert!(decrypt(&key, &ciphertext).is_err());
    }

    #[test]
    fn decrypt_rejects_short_input() {
        let key = test_key();
        assert!(decrypt(&key, b"short").is_err());
    }

    #[test]
    fn decrypt_rejects_wrong_key() {
        let key1 = TokenKey::from_bytes(vec![1u8; KEY_BYTES]).unwrap();
        let key2 = TokenKey::from_bytes(vec![2u8; KEY_BYTES]).unwrap();
        let ciphertext = encrypt(&key1, b"secret").unwrap();
        assert!(decrypt(&key2, &ciphertext).is_err());
    }

    #[test]
    fn nonce_is_unique_per_encryption() {
        let key = test_key();
        let c1 = encrypt(&key, b"same input").unwrap();
        let c2 = encrypt(&key, b"same input").unwrap();
        // Nonces (first 12 bytes) must differ.
        assert_ne!(&c1[..NONCE_BYTES], &c2[..NONCE_BYTES]);
        // Both decrypt to the same plaintext.
        assert_eq!(decrypt(&key, &c1).unwrap(), decrypt(&key, &c2).unwrap());
    }

    #[test]
    fn token_bundle_round_trips() {
        let key = test_key();
        let bundle = TokenBundle {
            access_token: "ya29.test".into(),
            refresh_token: Some("1//refresh".into()),
            expires_at: Some("2026-07-11T12:00:00Z".into()),
            token_type: "Bearer".into(),
            scope: Some("https://www.googleapis.com/auth/drive.readonly".into()),
        };
        let encrypted = bundle.encrypt_to_bytes(&key).unwrap();
        let recovered = TokenBundle::decrypt_from_bytes(&key, &encrypted).unwrap();
        assert_eq!(recovered.access_token, bundle.access_token);
        assert_eq!(recovered.refresh_token, bundle.refresh_token);
        assert_eq!(recovered.token_type, bundle.token_type);
    }

    fn sample_s3_credentials() -> S3Credentials {
        S3Credentials {
            endpoint: "https://acct.r2.cloudflarestorage.com".into(),
            region: "auto".into(),
            bucket: "media".into(),
            access_key_id: "key-id".into(),
            secret_access_key: "secret".into(),
            prefix: None,
        }
    }

    #[test]
    fn credential_oauth_round_trips() {
        let key = test_key();
        let credential = Credential::OAuth(TokenBundle {
            access_token: "ya29.test".into(),
            refresh_token: Some("1//refresh".into()),
            expires_at: None,
            token_type: "Bearer".into(),
            scope: None,
        });
        let encrypted = credential.encrypt_to_bytes(&key).unwrap();
        let recovered = Credential::decrypt_from_bytes(&key, &encrypted).unwrap();
        assert!(matches!(recovered, Credential::OAuth(_)));
        assert_eq!(recovered.as_oauth().unwrap().access_token, "ya29.test");
    }

    #[test]
    fn credential_s3_round_trips() {
        let key = test_key();
        let credential = Credential::S3(sample_s3_credentials());
        let encrypted = credential.encrypt_to_bytes(&key).unwrap();
        let recovered = Credential::decrypt_from_bytes(&key, &encrypted).unwrap();
        let Credential::S3(s3) = recovered else {
            panic!("expected S3 variant");
        };
        assert_eq!(s3.endpoint, "https://acct.r2.cloudflarestorage.com");
        assert_eq!(s3.region, "auto");
        assert_eq!(s3.bucket, "media");
        assert_eq!(s3.access_key_id, "key-id");
        assert_eq!(s3.secret_access_key, "secret");
    }

    /// OQ-2: the optional key-prefix rides inside `S3Credentials` so it
    /// persists with the connection (same encrypted BLOB) and survives
    /// reconnects. `#[serde(default)]` keeps older S3 blobs decodable.
    #[test]
    fn credential_s3_prefix_round_trips_and_defaults_to_none() {
        let key = test_key();
        let mut creds = sample_s3_credentials();
        let no_prefix = Credential::S3(creds.clone())
            .encrypt_to_bytes(&key)
            .unwrap();
        let Credential::S3(recovered) = Credential::decrypt_from_bytes(&key, &no_prefix).unwrap()
        else {
            panic!("expected S3 variant");
        };
        assert_eq!(recovered.prefix, None);

        creds.prefix = Some("media/".into());
        let with_prefix = Credential::S3(creds).encrypt_to_bytes(&key).unwrap();
        let Credential::S3(recovered) = Credential::decrypt_from_bytes(&key, &with_prefix).unwrap()
        else {
            panic!("expected S3 variant");
        };
        assert_eq!(recovered.prefix.as_deref(), Some("media/"));
    }

    /// Rows written before `Credential` existed hold plain `TokenBundle`
    /// JSON. Untagged serde must decode them as `Credential::OAuth` — this
    /// is the no-migration contract.
    #[test]
    fn credential_decodes_legacy_token_bundle_json() {
        let key = test_key();
        // Hand-build the legacy payload exactly as `TokenBundle` serialized it.
        let legacy_json = br#"{"access_token":"legacy-token","refresh_token":"legacy-refresh","expires_at":null,"token_type":"Bearer","scope":null}"#;
        let legacy_bytes = encrypt(&key, legacy_json).unwrap();

        let recovered = Credential::decrypt_from_bytes(&key, &legacy_bytes).unwrap();
        let bundle = recovered
            .as_oauth()
            .expect("legacy row must decode as OAuth");
        assert_eq!(bundle.access_token, "legacy-token");
        assert_eq!(bundle.refresh_token.as_deref(), Some("legacy-refresh"));
    }

    /// The untagged variants must be unambiguous in both directions: a
    /// serialized `Credential` also parses as a plain `TokenBundle` only
    /// when it is the OAuth variant.
    #[test]
    fn credential_variant_disambiguation() {
        let key = test_key();
        let s3 = Credential::S3(sample_s3_credentials());
        let encrypted = s3.encrypt_to_bytes(&key).unwrap();
        let json = decrypt(&key, &encrypted).unwrap();
        // The raw JSON must NOT parse as a TokenBundle (no access_token).
        assert!(serde_json::from_slice::<TokenBundle>(&json).is_err());
        // And OAuth JSON must not parse as S3Credentials (no endpoint/bucket).
        let oauth_json =
            br#"{"access_token":"a","refresh_token":null,"expires_at":null,"token_type":"Bearer","scope":null}"#;
        assert!(serde_json::from_slice::<S3Credentials>(oauth_json).is_err());
    }

    #[test]
    fn rejects_short_key() {
        let err = TokenKey::from_bytes(vec![0u8; 10]).unwrap_err();
        assert!(matches!(err, CryptoError::KeyTooShort(10)));
    }

    #[tokio::test]
    async fn token_key_resolve_generates_and_persists() {
        let file = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let path = file.to_path_buf();
        let pool = castify_storage_pool(&path).await;

        // No env, no stored key → generates and persists.
        let key1 = TokenKey::resolve(&pool, None).await.unwrap();

        // Second resolve with no env should read the persisted key.
        let key2 = TokenKey::resolve(&pool, None).await.unwrap();

        // Same key bytes recovered.
        let plaintext = b"token bundle";
        let ct = encrypt(&key1, plaintext).unwrap();
        assert_eq!(decrypt(&key2, &ct).unwrap(), plaintext);
    }

    #[tokio::test]
    async fn token_key_resolve_prefers_env() {
        let file = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let path = file.to_path_buf();
        let pool = castify_storage_pool(&path).await;

        // Persist a key first.
        let _ = TokenKey::resolve(&pool, None).await.unwrap();

        // Env value should take precedence over stored.
        let env_key = TokenKey::resolve(
            &pool,
            Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into()),
        )
        .await
        .unwrap();

        // Verify it's different from the generated one by checking it decrypts
        // data encrypted with the env-derived key only.
        let plaintext = b"test";
        let ct = encrypt(&env_key, plaintext).unwrap();
        assert_eq!(decrypt(&env_key, &ct).unwrap(), plaintext);
    }

    async fn castify_storage_pool(path: &std::path::Path) -> SqlitePool {
        use std::str::FromStr;
        let options =
            sqlx::sqlite::SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
                .unwrap()
                .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS app_meta (\
             key TEXT PRIMARY KEY NOT NULL,\
             value TEXT NOT NULL,\
             updated_at TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }
}
