use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::model::Provider;

const STATE_TTL: Duration = Duration::from_secs(600);
const VERIFIER_BYTES: usize = 32;

/// PKCE challenge pair. The verifier is sent to the token endpoint; the
/// challenge is sent in the authorization URL.
#[derive(Debug, Clone)]
pub struct PkceChallenge {
    pub verifier: String,
    pub challenge: String,
}

impl PkceChallenge {
    /// Generate a random PKCE verifier and its S256 challenge.
    pub fn generate() -> Self {
        let mut bytes = [0u8; VERIFIER_BYTES];
        OsRng.fill_bytes(&mut bytes);
        let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let challenge = {
            let mut hasher = Sha256::new();
            hasher.update(verifier.as_bytes());
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize())
        };
        Self {
            verifier,
            challenge,
        }
    }
}

/// Generate a random OAuth state parameter (nonce).
pub fn generate_state() -> String {
    let mut bytes = [0u8; VERIFIER_BYTES];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Ephemeral state tied to an in-progress OAuth flow. Stored in-memory until
/// the callback resolves or the entry expires.
#[derive(Debug)]
pub struct OAuthStateEntry {
    pub provider: Provider,
    pub owner_id: String,
    pub pkce_verifier: String,
    pub created_at: Instant,
    /// Path the callback should redirect to after a successful reconnect,
    /// instead of the default `/connections?connected={provider}`. Used by
    /// the watch page's "Try again" button so users land back on the video
    /// they were trying to play. `None` for the standard Connections-page
    /// flow. Validated to a relative path (starts with `/`) at `start`
    /// time to prevent open-redirect abuse.
    pub return_to: Option<String>,
}

/// In-memory store for OAuth state during the authorization-code flow.
/// Entries expire after [`STATE_TTL`] (10 minutes). Cloning shares the
/// underlying map via `Arc`, so all clones see the same data.
#[derive(Clone, Default)]
pub struct OAuthStateStore {
    inner: Arc<Mutex<HashMap<String, OAuthStateEntry>>>,
}

impl OAuthStateStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, state: String, entry: OAuthStateEntry) {
        let mut map = self.inner.lock().unwrap();
        Self::gc(&mut map);
        map.insert(state, entry);
    }

    /// Remove and return the entry for `state`, if it exists and hasn't
    /// expired. Single-use: the entry is removed regardless of expiry.
    pub fn take(&self, state: &str) -> Option<OAuthStateEntry> {
        let mut map = self.inner.lock().unwrap();
        let entry = map.remove(state)?;
        if entry.created_at.elapsed() > STATE_TTL {
            return None;
        }
        Some(entry)
    }

    fn gc(map: &mut HashMap<String, OAuthStateEntry>) {
        map.retain(|_, e| e.created_at.elapsed() < STATE_TTL);
    }
}

/// Build the redirect URI for a given provider.
pub fn redirect_uri(base_url: &str, provider: &Provider) -> String {
    format!(
        "{}/api/connections/{}/callback",
        base_url.trim_end_matches('/'),
        provider.as_str()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_verifier_and_challenge_are_url_safe_base64() {
        let pkce = PkceChallenge::generate();
        assert!(pkce.verifier.len() >= 43);
        assert!(pkce.challenge.len() >= 43);
        // Challenge is the SHA-256 of the verifier.
        let mut hasher = Sha256::new();
        hasher.update(pkce.verifier.as_bytes());
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());
        assert_eq!(pkce.challenge, expected);
    }

    #[test]
    fn pkce_is_unique() {
        let a = PkceChallenge::generate();
        let b = PkceChallenge::generate();
        assert_ne!(a.verifier, b.verifier);
    }

    #[test]
    fn state_store_insert_and_take() {
        let store = OAuthStateStore::new();
        store.insert(
            "state-1".into(),
            OAuthStateEntry {
                provider: Provider::GoogleDrive,
                owner_id: "owner-1".into(),
                pkce_verifier: "verifier".into(),
                created_at: Instant::now(),
                return_to: None,
            },
        );
        let entry = store.take("state-1").unwrap();
        assert_eq!(entry.provider, Provider::GoogleDrive);
        // Second take returns None (single-use).
        assert!(store.take("state-1").is_none());
    }

    #[test]
    fn redirect_uri_strips_trailing_slash() {
        let uri = redirect_uri("https://example.com/", &Provider::GoogleDrive);
        assert_eq!(
            uri,
            "https://example.com/api/connections/google_drive/callback"
        );
    }
}
