//! Recipient-facing share endpoints (docs/specs/sharing, task 003).
//!
//!   * `GET /api/share/{token}`        — resolve: title, item count,
//!     `locked`, `status` only; no items, no video metadata (see [`resolve`])
//!   * `GET /api/share/{token}/items`  — member metadata in curation
//!     order, only once unlocked (see [`items`])
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
//! success criterion #7).

use axum::extract::{Path, State};
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::Serialize;

use castify_catalog::VideoSummary;

use crate::error::ApiResult;
use crate::shares::status::{lookup_share_state, require_accessible_share, ShareState};
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
