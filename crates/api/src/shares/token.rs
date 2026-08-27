//! Token generation, hashing, and unlock-cookie helpers.
//!
//! Token design (spec § Architecture decisions): 16 CSPRNG bytes (128 bits)
//! encoded as 22-char base64url, carried in the URL path. Only the SHA-256
//! hash is persisted — `generate_share_token()` output goes to the owner
//! once, `hash_share_token()` output goes to the database forever.
//!
//! Unlock cookies reuse `castify_auth::SessionSecret`'s HMAC sign/verify:
//! payload `share:<share_id>:<issued_at>`, 24h rolling TTL capped at the
//! share's own expiry (the cap is checked by the caller against the DB —
//! the cookie alone is never authority).

use base64::Engine;
use castify_auth::SessionSecret;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::shares::{ShareError, ShareResult};

/// 16 bytes → 22 base64url chars: ≥128 bits of entropy per the spec.
const SHARE_TOKEN_BYTES: usize = 16;
/// Unlock cookies roll forward 24h from issue; a share's own expiry caps
/// them regardless (spec § Resolved questions #2).
const UNLOCK_TTL_HOURS: i64 = 24;

/// Generate a fresh share token: 22 chars of base64url (no padding) from
/// 128 bits of OS CSPRNG entropy. URL-path safe by construction.
pub fn generate_share_token() -> String {
    let mut bytes = [0u8; SHARE_TOKEN_BYTES];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// SHA-256 of a raw token — the only form ever persisted or compared.
pub fn hash_share_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// A verified unlock cookie: HMAC checked, payload parsed.
#[derive(Clone, Debug)]
pub struct VerifiedUnlock {
    pub share_id: String,
    pub issued_at: DateTime<Utc>,
}

impl VerifiedUnlock {
    /// 24h rolling TTL, capped at the share's expiry. `now` is passed in
    /// (never read here) so tests can pin the clock.
    pub fn is_current(&self, now: DateTime<Utc>, share_expires_at: Option<DateTime<Utc>>) -> bool {
        if now - self.issued_at > Duration::hours(UNLOCK_TTL_HOURS) {
            return false;
        }
        match share_expires_at {
            Some(expires_at) => now <= expires_at,
            None => true,
        }
    }
}

fn unlock_payload(share_id: &str, issued_at: &DateTime<Utc>) -> String {
    format!(
        "share:{share_id}:{}",
        issued_at.to_rfc3339_opts(SecondsFormat::Secs, true)
    )
}

/// Sign an unlock value for a share. The signed string travels in a
/// share-scoped cookie set by the unlock endpoint (task 004).
pub fn issue_unlock_value(secret: &SessionSecret, share_id: &str) -> ShareResult<String> {
    Ok(secret.sign(&unlock_payload(share_id, &Utc::now()))?)
}

/// Verify an unlock cookie's value, recovering the share it unlocks and
/// when the unlock happened. Signature failures and malformed payloads are
/// both `Err` — callers treat any error as "not unlocked".
pub fn verify_unlock_value(secret: &SessionSecret, value: &str) -> ShareResult<VerifiedUnlock> {
    let payload = secret.verify(value)?;
    // GOTCHA: split on the FIRST ':' after stripping the prefix — the
    // RFC3339 timestamp itself contains ':' (rsplit_once would cut inside
    // it). Share IDs (UUIDs) never contain ':'.
    let rest = payload
        .strip_prefix("share:")
        .ok_or(ShareError::InvalidUnlock)?;
    let (share_id, issued_raw) = rest.split_once(':').ok_or(ShareError::InvalidUnlock)?;
    let issued_at = DateTime::parse_from_rfc3339(issued_raw)
        .map_err(|_| ShareError::InvalidUnlock)?
        .with_timezone(&Utc);
    Ok(VerifiedUnlock {
        share_id: share_id.to_string(),
        issued_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_secret() -> SessionSecret {
        SessionSecret::from_bytes(vec![1u8; 32]).unwrap()
    }

    #[test]
    fn tokens_are_22_chars_of_urlsafe_base64() {
        for _ in 0..100 {
            let token = generate_share_token();
            assert_eq!(token.len(), 22, "got {token}");
            assert!(
                token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
                "non-base64url char in {token}"
            );
        }
    }

    #[test]
    fn tokens_carry_at_least_128_bits_of_entropy() {
        // 22 base64url chars = 128 bits exactly; decoding must yield 16
        // full bytes of distinct-enough material. Uniqueness across draws
        // is the practical CSPRNG wiring check.
        let draws: std::collections::HashSet<_> =
            (0..1000).map(|_| generate_share_token()).collect();
        assert_eq!(draws.len(), 1000, "token collisions across 1000 draws");

        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(generate_share_token())
            .unwrap();
        assert_eq!(decoded.len(), SHARE_TOKEN_BYTES);
    }

    #[test]
    fn hash_is_sha256_and_never_the_raw_token() {
        let token = generate_share_token();
        let hash = hash_share_token(&token);
        assert_eq!(hash.len(), 32, "SHA-256 digest is 32 bytes");
        assert_ne!(
            token.as_bytes(),
            hash.as_slice(),
            "stored bytes must not be the raw token"
        );
        assert!(!hash.starts_with(token.as_bytes()));

        // Deterministic + stable for lookup by hash.
        assert_eq!(hash_share_token(&token), hash);
        assert_ne!(
            hash_share_token(&token),
            hash_share_token(&generate_share_token())
        );
    }

    #[test]
    fn unlock_value_round_trips_share_id_and_issue_time() {
        let secret = test_secret();
        // The payload timestamp is whole-second RFC3339, so bracket the
        // assertion with ±1s of slack for the truncation.
        let before = Utc::now() - Duration::seconds(1);
        let value = issue_unlock_value(&secret, "share-uuid-1").unwrap();
        let verified = verify_unlock_value(&secret, &value).unwrap();
        let after = Utc::now() + Duration::seconds(1);

        assert_eq!(verified.share_id, "share-uuid-1");
        assert!(verified.issued_at >= before && verified.issued_at <= after);
    }

    #[test]
    fn unlock_rejects_tampered_signature_and_foreign_secret() {
        let secret = test_secret();
        let mut value = issue_unlock_value(&secret, "share-uuid-1").unwrap();
        let last = value.pop().unwrap();
        value.push(if last == 'a' { 'b' } else { 'a' });
        assert!(verify_unlock_value(&secret, &value).is_err());

        let other = SessionSecret::from_bytes(vec![9u8; 32]).unwrap();
        let legit = issue_unlock_value(&secret, "share-uuid-1").unwrap();
        assert!(verify_unlock_value(&other, &legit).is_err());
    }

    #[test]
    fn unlock_rejects_non_share_payloads() {
        let secret = test_secret();
        // A signed session id (wrong payload shape) must not verify as an
        // unlock — the signature is valid but the payload is not ours.
        let session_value = secret.sign("some-session-id").unwrap();
        assert!(matches!(
            verify_unlock_value(&secret, &session_value),
            Err(ShareError::InvalidUnlock)
        ));
        // Unsigned garbage likewise.
        assert!(verify_unlock_value(&secret, "garbage").is_err());
    }

    #[test]
    fn unlock_ttl_is_24h_rolling_and_capped_at_share_expiry() {
        let now = Utc::now();
        let unlocked_recently = VerifiedUnlock {
            share_id: "s".into(),
            issued_at: now - Duration::hours(23),
        };
        let unlocked_stale = VerifiedUnlock {
            share_id: "s".into(),
            issued_at: now - Duration::hours(25),
        };

        assert!(unlocked_recently.is_current(now, None));
        assert!(!unlocked_stale.is_current(now, None));

        // Share expiry caps the cookie even inside the 24h window.
        let expiring = Some(now + Duration::hours(1));
        let expired = Some(now - Duration::hours(1));
        assert!(unlocked_recently.is_current(now, expiring));
        assert!(!unlocked_recently.is_current(now, expired));
    }

    /// Raw tokens and passwords must never reach `tracing`. Source-level
    /// lint: no `tracing::` macro call in this module (or the repository)
    /// may mention token material. If you legitimately need a log line
    /// here, log the share *id* or a hash prefix — never the raw token.
    #[test]
    fn no_tracing_macro_references_token_material() {
        for file in [
            include_str!("token.rs"),
            include_str!("repository.rs"),
            include_str!("mod.rs"),
        ] {
            for line in file.lines() {
                let trimmed = line.trim_start();
                if trimmed.starts_with("//") {
                    continue;
                }
                if trimmed.contains("tracing::") {
                    assert!(
                        !trimmed.to_lowercase().contains("token"),
                        "tracing call mentions token material: {trimmed}"
                    );
                }
            }
        }
    }
}
