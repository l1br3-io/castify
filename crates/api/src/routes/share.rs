//! Recipient-facing share endpoints (docs/specs/sharing, tasks 003+004).
//!
//!   * `GET /api/share/{token}`        — resolve: title, item count,
//!     `locked`, `status` only; no items, no video metadata (see [`resolve`])
//!   * `GET /api/share/{token}/items`  — member metadata in curation
//!     order, only once unlocked (see [`items`])
//!   * `POST /api/share/{token}/unlock` — password gate: rate-limited
//!     argon2id verification, then the signed unlock cookie (see [`unlock`])
//!
//! Pre-auth by the `/api/share/` prefix rule in [`crate::middleware`]:
//! recipients hold no session. Validation is per-request against the
//! database — every handler funnels through
//! [`crate::shares::status::require_accessible_share`], which resolves the
//! token hash (404), runs the status machine (revoked/expired → 410
//! `share_unavailable`, locked without a current unlock → 401
//! `share_locked`), and hands back the row. The unlock cookie is a hint,
//! never authority: revocation and expiry are re-checked on every request.
//!
//! Reads only — recipient traffic performs zero server writes (spec
//! success criterion #7). The unlock POST is the sanctioned exception:
//! its only write is the response cookie.

use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use castify_auth::password::verify_password;
use castify_catalog::VideoSummary;

use crate::cookies::build_share_unlock_cookie;
use crate::error::{ApiError, ApiResult};
use crate::shares::ratelimit::RateVerdict;
use crate::shares::status::{lookup_share_state, require_accessible_share, ShareState};
use crate::shares::token::issue_unlock_value;
use crate::state::AppState;

/// `GET /api/share/{token}` response. Deliberately minimal: it is the
/// pre-unlock probe the landing page renders from, so it may expose the
/// share's identity (title, size) but nothing about its contents.
#[derive(Debug, Serialize)]
pub struct ShareResolveResponse {
    pub title: String,
    pub item_count: i64,
    /// True when the requester still needs to pass the password gate —
    /// i.e. the share is password-protected AND no current unlock cookie
    /// was presented. Open shares and already-unlocked requesters see
    /// `false`, so this single field drives the landing page's gate.
    pub locked: bool,
    /// Always `"active"` on a 200 — revoked/expired never reach this body
    /// (they are terminal 410s). Kept as a field so the response is
    /// forward-compatible with softer states.
    pub status: &'static str,
}

/// `GET /api/share/{token}` — resolve a share link.
///
/// The one recipient endpoint that answers *while locked*: the password
/// gate needs the title to render. Revoked/expired/unknown still fail
/// through the shared matrix; a live share answers 200 with `locked`
/// telling the requester whether they still owe a password.
pub async fn resolve(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(token): Path<String>,
) -> ApiResult<Json<ShareResolveResponse>> {
    let (row, verdict) = lookup_share_state(&state, &jar, &token).await?;
    verdict.ensure_not_terminal()?;
    let item_count = state
        .share_repository()
        .list_items(&row.id)
        .await?
        .len() as i64;

    Ok(Json(ShareResolveResponse {
        title: row.title,
        item_count,
        locked: matches!(verdict, ShareState::Locked),
        status: "active",
    }))
}

/// `GET /api/share/{token}/items` — member videos in the owner's curation
/// order (`share_items.position`).
///
/// Reuses the owner list's [`VideoSummary`] shape so the SPA renders
/// recipients' rows with the same components, but with neutral
/// personalization: the catalog's by-ids read has no owner context, so the
/// owner's favorites/ratings/progress cannot leak. Member videos whose
/// connection has since been disconnected drop out of the list rather than
/// erroring.
pub async fn items(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(token): Path<String>,
) -> ApiResult<Json<Vec<VideoSummary>>> {
    let row = require_accessible_share(&state, &jar, &token).await?;
    let share_items = state.share_repository().list_items(&row.id).await?;
    let video_ids: Vec<String> = share_items.iter().map(|i| i.video_id.clone()).collect();
    let summaries = state
        .catalog_repository()
        .fetch_video_summaries_by_ids(&video_ids)
        .await?;
    Ok(Json(summaries))
}

/// `POST /api/share/{token}/unlock` request body.
#[derive(Debug, Deserialize)]
pub struct UnlockRequest {
    pub password: String,
}

/// `POST /api/share/{token}/unlock` — pass the password gate.
///
/// Order is load-bearing:
///   1. Status machine first (unknown → 404, revoked/expired → 410) — a
///      dead share must never mint a fresh cookie, and cheap rejections
///      never touch the failure counter.
///   2. Passwordless share → 404: unlock is only a meaningful action on a
///      locked share, and indistinguishable-from-unknown keeps the token
///      space opaque.
///   3. Rate-limit check *before* argon2 — a locked-out token cannot
///      spend hashing CPU even with the right password (429).
///   4. argon2id verify; a wrong password counts toward the cool-off and
///      answers the same 401 `share_locked` the locked read would.
///   5. Success resets the counter (fresh slate for a legit recipient)
///      and mints the signed, share-scoped cookie. 204, no body.
///
/// Nothing here writes to the database or logs token/password material —
/// the only trace is the `Set-Cookie` header.
pub async fn unlock(
    State(state): State<AppState>,
    _jar: CookieJar,
    Path(token): Path<String>,
    Json(body): Json<UnlockRequest>,
) -> ApiResult<axum::response::Response> {
    let (row, verdict) = lookup_share_state(&state, &_jar, &token).await?;
    verdict.ensure_not_terminal()?;

    let password_hash = row.password_hash.clone().ok_or(ApiError::NotFound)?;

    if state.unlock_rate_limiter().check(&row.id, Instant::now()) == RateVerdict::LockedOut {
        return Err(ApiError::RateLimited);
    }

    let verified = verify_password(&body.password, &password_hash).is_ok();
    if !verified {
        if state.unlock_rate_limiter().record_failure(&row.id, Instant::now()) {
            tracing::warn!(share_id = %row.id, "share unlock lockout engaged");
        }
        return Err(ApiError::ShareLocked);
    }

    state.unlock_rate_limiter().reset(&row.id);
    let value = issue_unlock_value(state.session_secret(), &row.id)?;
    let cookie = build_share_unlock_cookie(&value, row.expires_at.as_deref(), state.config());

    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    Ok(response)
}
