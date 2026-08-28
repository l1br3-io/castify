//! The share status machine — one place that decides, per request, what a
//! recipient may do with a share (docs/specs/sharing, task 003).
//!
//! Every recipient-facing handler (resolve, items, the unlock + mirror
//! routes that follow) funnels through [`lookup_share_state`]: the matrix
//! (unknown → 404, revoked/expired → 410, locked without a valid unlock →
//! 401, else active) lives here and nowhere else. Handlers contain no
//! ad-hoc status logic — they call [`require_accessible_share`] (or, for
//! the per-item media mirrors, [`authorize_share_item`], which layers the
//! membership check on top) and act on the returned row.
//!
//! Security model: the unlock cookie is a *hint*, never authority. State is
//! re-derived on every request from the database row (`revoked_at`,
//! `expires_at`, `password_hash`), and the cookie only downgrades `Locked`
//! → `Active` when its signature verifies, it names this exact share, and
//! it is current. Revocation or expiry after unlock still wins — the
//! terminal checks run before the unlock check.

use axum_extra::extract::CookieJar;
use chrono::{DateTime, Utc};

use crate::cookies::extract_share_unlock;
use crate::error::{ApiError, ApiResult};
use crate::shares::token::VerifiedUnlock;
use crate::shares::ShareRow;
use crate::state::AppState;

/// Point-in-time access verdict for one recipient request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShareState {
    /// Live and (if applicable) unlocked — the handler may proceed.
    Active,
    /// Password-protected and the requester holds no current unlock for
    /// this share → HTTP 401 `share_locked`.
    Locked,
    /// Revoked or expired — terminal, → HTTP 410 `share_unavailable`.
    Unavailable,
}

impl ShareState {
    /// `Err` unless the share is [`ShareState::Active`]. Maps the two
    /// denials to their protocol responses so no handler ever re-derives
    /// status codes itself.
    pub fn ensure_active(self) -> ApiResult<()> {
        match self {
            ShareState::Active => Ok(()),
            ShareState::Locked => Err(ApiError::ShareLocked),
            ShareState::Unavailable => Err(ApiError::ShareUnavailable),
        }
    }

    /// `Err` only on [`ShareState::Unavailable`]. This is resolve's rule:
    /// `Locked` is a valid 200 answer (the password gate still renders),
    /// but terminal stays terminal — no endpoint may soften 410.
    pub fn ensure_not_terminal(self) -> ApiResult<()> {
        match self {
            ShareState::Unavailable => Err(ApiError::ShareUnavailable),
            _ => Ok(()),
        }
    }
}

/// Derive the access verdict for a share row. Pure — `now` and the
/// verified unlock are injected so the whole matrix is unit-testable.
///
/// Order is load-bearing: terminal states (revocation, expiry) are checked
/// **before** the unlock, so a cookie minted before revocation/expiry can
/// never resurrect a dead share. A present-but-corrupt `expires_at` fails
/// closed to `Unavailable` (same policy as the owner list's
/// `derive_status`).
pub fn resolve_share_state(
    row: &ShareRow,
    unlock: Option<&VerifiedUnlock>,
    now: DateTime<Utc>,
) -> ShareState {
    if row.revoked_at.is_some() {
        return ShareState::Unavailable;
    }
    let expires_at = row.expires_at.as_deref().map(DateTime::parse_from_rfc3339);
    match expires_at {
        Some(Ok(expiry)) if now > expiry.with_timezone(&Utc) => {
            return ShareState::Unavailable;
        }
        // Corrupt expiry = dead share; never present a broken row as live.
        Some(Err(_)) => return ShareState::Unavailable,
        _ => {}
    }

    match row.password_hash.as_deref() {
        // Open share: token knowledge is the whole credential.
        None => ShareState::Active,
        // Password share: a cookie for *this* share, still current within
        // its TTL and the share's own expiry window, unlocks it.
        Some(_) => {
            let unlocked = unlock.is_some_and(|u| {
                u.share_id == row.id && u.is_current(now, row.expires_and_parsed())
            });
            if unlocked {
                ShareState::Active
            } else {
                ShareState::Locked
            }
        }
    }
}

impl ShareRow {
    /// `expires_at` parsed once for [`VerifiedUnlock::is_current`], which
    /// takes `Option<DateTime>`. `None` on a corrupt value — `is_current`
    /// then treats the cookie as uncapped, which is moot because
    /// `resolve_share_state` already returned `Unavailable` for corrupt
    /// rows before consulting the cookie.
    fn expires_and_parsed(&self) -> Option<DateTime<Utc>> {
        self.expires_at
            .as_deref()
            .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
            .map(|dt| dt.with_timezone(&Utc))
    }
}

/// The recipient-side lookup: resolve a raw URL token to its share row and
/// per-request state verdict, or the protocol error for why not.
///
/// This is the single entry every `/api/share/{token}` handler calls. It
/// owns the full per-request validation model — token hash lookup (404 for
/// unknown tokens), the status machine, and unlock-cookie verification.
/// The cookie named by [`crate::cookies::SHARE_UNLOCK_COOKIE_NAME`] is
/// verified against the
/// session secret and matched to this share; anything else (missing,
/// tampered, foreign, stale) simply means "locked".
///
/// Split from [`require_accessible_share`] for the one endpoint where
/// `Locked` is an answer, not an error: resolve must render the password
/// gate (200 + `locked: true`) instead of 401.
pub async fn lookup_share_state(
    state: &AppState,
    jar: &CookieJar,
    token: &str,
) -> ApiResult<(ShareRow, ShareState)> {
    let token_hash = crate::shares::token::hash_share_token(token);
    let row = state
        .share_repository()
        .fetch_by_token_hash(&token_hash)
        .await?
        // Unknown token: 404 with no detail — the token space is the
        // secret, so "does not exist" and "wrong guess" must look alike.
        .ok_or(ApiError::NotFound)?;

    let unlock = extract_share_unlock(jar, state.session_secret());
    let verdict = resolve_share_state(&row, unlock.as_ref(), Utc::now());
    Ok((row, verdict))
}

/// Strict guard for every recipient endpoint that serves share *content*:
/// like [`lookup_share_state`], but `Locked` is a 401 `share_locked` — only
/// an accessible share row comes back. The stream/subtitle/transcode
/// mirrors (tasks 005–007) call this one.
pub async fn require_accessible_share(
    state: &AppState,
    jar: &CookieJar,
    token: &str,
) -> ApiResult<ShareRow> {
    let (row, verdict) = lookup_share_state(state, jar, token).await?;
    verdict.ensure_active()?;
    Ok(row)
}

/// The single guard every media mirror calls: share liveness (the full
/// status machine via [`require_accessible_share`]) **plus** item
/// membership. A video outside the share is a 404 — indistinguishable
/// from an unknown video id, so a valid token probes nothing about the
/// catalog it doesn't contain. Returns the live share row for handlers
/// that need it, or the exact protocol error.
pub async fn authorize_share_item(
    state: &AppState,
    jar: &CookieJar,
    token: &str,
    video_id: &str,
) -> ApiResult<ShareRow> {
    let row = require_accessible_share(state, jar, token).await?;
    let member = state
        .share_repository()
        .is_member(&row.id, video_id)
        .await?;
    if !member {
        return Err(ApiError::NotFound);
    }
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shares::token::{generate_share_token, hash_share_token, issue_unlock_value};
    use castify_auth::SessionSecret;
    use chrono::Duration;

    fn secret() -> SessionSecret {
        SessionSecret::from_bytes(vec![7u8; 32]).unwrap()
    }

    /// Minimal live share row; tweak fields per case.
    fn row() -> ShareRow {
        ShareRow {
            id: "share-1".into(),
            owner_id: "owner-1".into(),
            token_hash: hash_share_token(&generate_share_token()),
            password_hash: None,
            title: "t".into(),
            expires_at: None,
            revoked_at: None,
            created_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn unlock_for(secret: &SessionSecret, share_id: &str) -> VerifiedUnlock {
        let value = issue_unlock_value(secret, share_id).unwrap();
        crate::shares::token::verify_unlock_value(secret, &value).unwrap()
    }

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    #[test]
    fn open_share_is_active_regardless_of_cookie() {
        let n = now();
        assert_eq!(resolve_share_state(&row(), None, n), ShareState::Active);
        // Even a *foreign* unlock cookie changes nothing on an open share.
        let foreign = unlock_for(&secret(), "other-share");
        assert_eq!(
            resolve_share_state(&row(), Some(&foreign), n),
            ShareState::Active
        );
    }

    #[test]
    fn revoked_and_expired_are_unavailable_even_with_valid_unlock() {
        let n = now();
        let secret = secret();

        let mut revoked = row();
        revoked.revoked_at = Some("2026-01-01T00:00:00Z".into());
        revoked.password_hash = Some("$argon2id$phc".into());
        let unlock = unlock_for(&secret, &revoked.id);
        assert_eq!(
            resolve_share_state(&revoked, Some(&unlock), n),
            ShareState::Unavailable,
            "revocation is terminal; a pre-revocation cookie cannot resurrect"
        );

        let mut expired = row();
        expired.expires_at = Some("2000-01-01T00:00:00Z".into());
        assert_eq!(
            resolve_share_state(&expired, Some(&unlock), n),
            ShareState::Unavailable
        );

        // Boundary: valid through the instant of expiry (whole-second rows).
        let expiry = DateTime::from_timestamp((n + Duration::hours(1)).timestamp(), 0).unwrap();
        let mut live = row();
        live.expires_at = Some(expiry.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        assert_eq!(resolve_share_state(&live, None, n), ShareState::Active);
    }

    #[test]
    fn corrupt_expiry_fails_closed_to_unavailable() {
        let mut corrupt = row();
        corrupt.expires_at = Some("not-a-timestamp".into());
        assert_eq!(
            resolve_share_state(&corrupt, None, now()),
            ShareState::Unavailable
        );
    }

    #[test]
    fn locked_share_requires_current_unlock_for_this_share() {
        let n = now();
        let secret = secret();
        let mut locked = row();
        locked.password_hash = Some("$argon2id$phc".into());

        assert_eq!(
            resolve_share_state(&locked, None, n),
            ShareState::Locked,
            "no cookie → locked"
        );

        let unlock = unlock_for(&secret, &locked.id);
        assert_eq!(
            resolve_share_state(&locked, Some(&unlock), n),
            ShareState::Active
        );

        // Right secret, wrong share.
        let foreign = unlock_for(&secret, "someone-elses-share");
        assert_eq!(
            resolve_share_state(&locked, Some(&foreign), n),
            ShareState::Locked
        );

        // Right share, stale cookie (beyond 24h rolling TTL).
        let mut stale = unlock.clone();
        stale.issued_at = n - Duration::hours(25);
        assert_eq!(
            resolve_share_state(&locked, Some(&stale), n),
            ShareState::Locked
        );
    }

    #[test]
    fn ensure_active_maps_denials_to_protocol_errors() {
        ShareState::Active.ensure_active().unwrap();
        assert!(matches!(
            ShareState::Locked.ensure_active(),
            Err(ApiError::ShareLocked)
        ));
        assert!(matches!(
            ShareState::Unavailable.ensure_active(),
            Err(ApiError::ShareUnavailable)
        ));
    }

    #[test]
    fn ensure_not_terminal_softens_only_locked() {
        // Resolve's rule: Locked is a 200 answer, Unavailable stays 410.
        ShareState::Active.ensure_not_terminal().unwrap();
        ShareState::Locked.ensure_not_terminal().unwrap();
        assert!(matches!(
            ShareState::Unavailable.ensure_not_terminal(),
            Err(ApiError::ShareUnavailable)
        ));
    }
}
