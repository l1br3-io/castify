//! Owner-facing shares REST — create, list, revoke, edit items, and
//! organize them into folders (sharing,
//! mutable-share-list, share-folders).
//!
//!   * `POST   /api/shares`     — create a share (see [`create`])
//!   * `GET    /api/shares`     — management list (see [`list`])
//!   * `DELETE /api/shares/{id}` — revoke, or purge with `?purge=true`
//!     (see [`revoke`])
//!   * `POST   /api/shares/{id}/items` — append to the item list (see
//!     [`append_items`])
//!   * `PUT    /api/shares/{id}/items` — replace the item list (see
//!     [`replace_items`])
//!   * `GET    /api/shares/{id}/items` — members for the edit dialog (see
//!     [`list_items`])
//!   * `PATCH  /api/shares/{id}/items/{video_id}` — move one item into a
//!     folder or back to root (see [`move_item`])
//!   * `DELETE /api/shares/{id}/items/{video_id}` — remove one item (see
//!     [`remove_item`])
//!   * `POST   /api/shares/{id}/folders` — create a folder (see
//!     [`create_folder`])
//!   * `PATCH  /api/shares/{id}/folders/{fid}` — rename and/or reparent
//!     (see [`update_folder`])
//!   * `DELETE /api/shares/{id}/folders/{fid}` — delete a folder; its
//!     contents lift to the share root (see [`delete_folder`])
//!
//! All of these are session-gated by the standard middleware (nothing here
//! is pre-auth; the recipient-facing mirrors live elsewhere) and mutations
//! go through the double-submit CSRF check like every other owner write.
//! Folder mutations are organization only — membership (`is_member`) stays
//! the sole authorization gate, so no folder write can ever change what a
//! recipient can play.
//!
//! Security invariants this module is responsible for:
//!   * The raw token is returned by `POST` **exactly once** and is stored
//!     nowhere — only its SHA-256 enters the database. A list response can
//!     never reconstruct a link, so a stolen `GET /api/shares` body is not
//!     a stolen share.
//!   * Passwords are hashed with argon2id before persistence (reuse of
//!     `castify_auth::password`, same as the owner credential) — plaintext
//!     never reaches storage or logs.
//!   * `share_url` is deliberately relative (`/share/<token>`): the SPA
//!     resolves it against the current origin, so it stays correct behind
//!     reverse proxies and when `CASTIFY_APP_BASE_URL` is unset.
//!   * Unknown and foreign ids are indistinguishable 404s on every route
//!     below — share ids across owners, folder ids across shares, and
//!     video ids outside the membership all collapse to plain 404 (no
//!     existence leak).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use axum_extra::extract::CookieJar;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use castify_auth::password::hash_password;
use castify_catalog::VideoSummary;

use crate::auth::resolve_owner_id;
use crate::error::{ApiError, ApiResult};
use crate::routes::validate_password;
use crate::shares::token::{generate_share_token, hash_share_token};
use crate::shares::{
    FolderInvalid, FolderWriteError, NewShare, RemovedItem, ShareError, ShareFolderRow, ShareRow,
};
use crate::state::AppState;

/// Fills the NOT NULL `title` column when the owner didn't name the share.
const DEFAULT_TITLE: &str = "Shared items";
const MAX_TITLE_LEN: usize = 200;

#[derive(Debug, Deserialize)]
pub struct CreateShareRequest {
    /// 1..N existing catalog video ids, in curation order.
    pub video_ids: Vec<String>,
    pub title: Option<String>,
    /// Optional share password (8..=256 chars, same policy as the owner
    /// credential). Hashed with argon2id before storage.
    pub password: Option<String>,
    /// Optional RFC3339 expiry; must be strictly in the future.
    pub expires_at: Option<String>,
}

/// Body of `PUT /api/shares/{id}/items`: the complete replacement list,
/// in curation order. Same shape rules as `CreateShareRequest::video_ids`.
#[derive(Debug, Deserialize)]
pub struct ReplaceItemsRequest {
    pub video_ids: Vec<String>,
}

/// Body of `POST /api/shares/{id}/items`: the ids to append, in the
/// order they should join the list's tail. Same shape as
/// [`ReplaceItemsRequest`] except duplicates are tolerated (see
/// [`append_items`]).
#[derive(Debug, Deserialize)]
pub struct AppendItemsRequest {
    pub video_ids: Vec<String>,
}

/// Body of `POST /api/shares/{id}/folders`: the folder name (trimmed,
/// 1..=200 chars) and an optional parent folder id — omitted or `null`
/// creates at the share root.
#[derive(Debug, Deserialize)]
pub struct CreateFolderRequest {
    pub name: String,
    pub parent_id: Option<String>,
}

/// Body of `PATCH /api/shares/{id}/folders/{fid}`: absent fields leave
/// the stored value alone. `parent_id` is a double-option so JSON
/// `null` (move to root) is distinguishable from the key being absent
/// (don't move): absent → `None`, `null` → `Some(None)`, id →
/// `Some(Some(id))`.
#[derive(Debug, Default, Deserialize)]
pub struct UpdateFolderRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub parent_id: Option<Option<String>>,
}

/// Serde trick for [`UpdateFolderRequest::parent_id`]: wrapping the
/// inner `Option`'s deserializer makes an explicit `null` arrive as
/// `Some(None)` while `#[serde(default)]` keeps an absent key as
/// `None`.
fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

/// Body of `PATCH /api/shares/{id}/items/{video_id}`: the target
/// folder, or `null`/absent for the share root.
#[derive(Debug, Deserialize)]
pub struct MoveItemRequest {
    pub folder_id: Option<String>,
}

/// Folder row over the wire — the same DTO the recipient tree payload
/// carries (one shape, two scopes, per the spec's resolved question 4).
#[derive(Debug, Serialize)]
pub struct FolderDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub position: i64,
}

impl From<ShareFolderRow> for FolderDto {
    fn from(row: ShareFolderRow) -> Self {
        Self {
            id: row.id,
            parent_id: row.parent_id,
            name: row.name,
            position: row.position,
        }
    }
}

/// One member item in the tree payload: the catalog's [`VideoSummary`]
/// shape (flattened, so clients keep their existing field access) plus
/// its folder placement — `null` = share root.
#[derive(Debug, Serialize)]
pub struct ShareItemDto {
    #[serde(flatten)]
    pub video: VideoSummary,
    pub folder_id: Option<String>,
}

/// The one-shot tree payload both items reads serve (recipient token
/// read and this module's owner session read — one DTO, two scopes).
/// `folders` is the flat list ordered `(parent_id, position)`; items
/// follow the documented full order below; descending is client state
/// (`?folder=`), never another request — the recipient request budget
/// stays resolve + unlock + one items fetch (spec criterion 1).
#[derive(Debug, Serialize)]
pub struct ShareItemsResponse {
    pub folders: Vec<FolderDto>,
    pub items: Vec<ShareItemDto>,
}

/// Assemble [`ShareItemsResponse`] from the share's rows. Item order:
/// root items first in position order, then each folder's items in
/// position order, folders visited in `list_folders` order — any
/// deterministic full order that preserves per-scope relative order
/// satisfies the contract; this one keeps flat shares byte-identical to
/// the old bare array. Member videos whose connection has since been
/// disconnected drop out silently (the by-ids read skips them).
pub async fn share_items_payload(
    state: &AppState,
    share_id: &str,
) -> ApiResult<ShareItemsResponse> {
    let repo = state.share_repository();
    let folders = repo.list_folders(share_id).await?;
    let rows = repo.list_items(share_id).await?;

    // Bucket by scope; `list_items` is position-ordered, so each
    // bucket inherits its per-scope curation order.
    let mut by_folder: HashMap<Option<&str>, Vec<&crate::shares::ShareItemRow>> = HashMap::new();
    for row in &rows {
        by_folder
            .entry(row.folder_id.as_deref())
            .or_default()
            .push(row);
    }
    let mut ordered: Vec<&crate::shares::ShareItemRow> =
        by_folder.remove(&None).unwrap_or_default();
    for folder in &folders {
        if let Some(members) = by_folder.remove(&Some(folder.id.as_str())) {
            ordered.extend(members);
        }
    }

    let video_ids: Vec<String> = ordered.iter().map(|r| r.video_id.clone()).collect();
    let summaries = state
        .catalog_repository()
        .fetch_video_summaries_by_ids(&video_ids)
        .await?;
    let items = ordered
        .iter()
        .zip(summaries)
        .map(|(row, video)| ShareItemDto {
            folder_id: row.folder_id.clone(),
            video,
        })
        .collect();

    Ok(ShareItemsResponse {
        folders: folders.into_iter().map(FolderDto::from).collect(),
        items,
    })
}

/// The shared prefix of every owner mutation ladder: scope the share to
/// the session's owner (foreign and unknown both 404 — no existence
/// leak), then refuse terminal states with 409 naming the state (the
/// owner can already see their own revoked/expired row in the
/// management list, so naming it leaks nothing and explains why
/// nothing is editable). [`replace_items`] inlines the same two steps;
/// these handlers share the helper because there are five of them.
async fn require_active_share(state: &AppState, owner_id: &Uuid, id: &str) -> ApiResult<ShareRow> {
    let row = state
        .share_repository()
        .fetch_owned(&owner_id.to_string(), id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let status = derive_status(
        row.revoked_at.as_deref(),
        row.expires_at.as_deref(),
        Utc::now(),
    );
    if status != ShareStatus::Active {
        return Err(ApiError::Conflict(format!("share is {}", status.as_str())));
    }
    Ok(row)
}

/// Map the repository's folder-write rejections onto the HTTP ladder:
/// shape problems (name, depth) are 400 `Validation`; tree-state
/// problems (sibling name, cycle) are 409 `Conflict`; database errors
/// ride the existing [`ShareError`] passthrough. Four distinct
/// messages, four distinct client behaviors (spec criterion 3).
fn folder_write_error(err: FolderWriteError) -> ApiError {
    match err {
        FolderWriteError::Invalid(FolderInvalid::DuplicateName) => {
            ApiError::Conflict(FolderInvalid::DuplicateName.to_string())
        }
        FolderWriteError::Invalid(FolderInvalid::Cycle) => {
            ApiError::Conflict(FolderInvalid::Cycle.to_string())
        }
        FolderWriteError::Invalid(other) => ApiError::Validation {
            detail: other.to_string(),
        },
        FolderWriteError::Database(db) => ApiError::Shares(ShareError::Database(db)),
    }
}

/// Response of `POST /api/shares`. `token` and `share_url` appear here and
/// here only — there is no later endpoint to recover them.
#[derive(Debug, Serialize)]
pub struct CreatedShareResponse {
    pub id: String,
    pub title: String,
    pub token: String,
    pub share_url: String,
}

/// Management list entry. Deliberately excludes every piece of token and
/// password material — `token_hash` and `password_hash` stay server-side.
#[derive(Debug, Serialize)]
pub struct ShareDto {
    pub id: String,
    pub title: String,
    pub item_count: i64,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub status: &'static str,
}

/// Derived, point-in-time share state for the management list.
///
/// Revocation beats expiry (both are terminal, but "revoked" is the action
/// the owner took and the one they can map to a list row). An unparseable
/// `expires_at` fails **closed** to `Expired`: a corrupt row must never
/// present as a live share.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShareStatus {
    Active,
    Expired,
    Revoked,
}

impl ShareStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ShareStatus::Active => "active",
            ShareStatus::Expired => "expired",
            ShareStatus::Revoked => "revoked",
        }
    }
}

fn derive_status(
    revoked_at: Option<&str>,
    expires_at: Option<&str>,
    now: DateTime<Utc>,
) -> ShareStatus {
    if revoked_at.is_some() {
        return ShareStatus::Revoked;
    }
    match expires_at.map(DateTime::parse_from_rfc3339) {
        Some(Ok(expires_at)) => {
            // Valid through the instant of expiry — same boundary as the
            // unlock-cookie check (`shares::token::VerifiedUnlock`).
            if now > expires_at.with_timezone(&Utc) {
                ShareStatus::Expired
            } else {
                ShareStatus::Active
            }
        }
        // Missing expiry = never expires; a present-but-corrupt one is
        // treated as expired (fail closed, see doc comment).
        Some(Err(_)) => ShareStatus::Expired,
        None => ShareStatus::Active,
    }
}

/// Validate a caller-supplied title, returning the effective one. `None`
/// and whitespace-only fall back to [`DEFAULT_TITLE`]; the trim keeps
/// storage and list rendering predictable.
fn validate_title(raw: Option<&str>) -> ApiResult<&str> {
    let trimmed = raw.map(str::trim).unwrap_or_default();
    if trimmed.is_empty() {
        return Ok(DEFAULT_TITLE);
    }
    let len = trimmed.chars().count();
    if len > MAX_TITLE_LEN {
        return Err(ApiError::Validation {
            detail: format!("title must be at most {MAX_TITLE_LEN} characters"),
        });
    }
    Ok(trimmed)
}

/// Parse + validate `expires_at`: RFC3339 (with timezone) and strictly in
/// the future. Returns the normalized storage form (UTC, whole seconds,
/// `Z` suffix) matching the timestamps the rest of the module writes.
/// `now` is injected so the boundary is unit-testable.
fn parse_expiry(raw: &str, now: DateTime<Utc>) -> ApiResult<String> {
    let parsed = DateTime::parse_from_rfc3339(raw).map_err(|_| ApiError::Validation {
        detail: "expires_at must be an RFC3339 timestamp with timezone (e.g. 2027-01-01T00:00:00Z)"
            .to_string(),
    })?;
    let utc = parsed.with_timezone(&Utc);
    if utc <= now {
        return Err(ApiError::Validation {
            detail: "expires_at must be in the future".to_string(),
        });
    }
    Ok(utc.to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// `POST /api/shares` — create a share.
///
/// Validation is fully ordered before any expensive or persisting work:
/// cheap request-shape checks first, then catalog existence checks, and
/// only then the argon2id hash — a request doomed to 400 must not burn
/// CPU or write anything. The raw token is minted last and exists only in
/// this handler's response; the database row is written with its SHA-256.
pub async fn create(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<CreateShareRequest>,
) -> ApiResult<impl IntoResponse> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;

    let title = validate_title(req.title.as_deref())?;

    if req.video_ids.is_empty() {
        return Err(ApiError::Validation {
            detail: "video_ids must contain at least 1 item".to_string(),
        });
    }
    let unique: HashSet<&String> = req.video_ids.iter().collect();
    if unique.len() != req.video_ids.len() {
        return Err(ApiError::Validation {
            detail: "video_ids contains duplicates".to_string(),
        });
    }
    if let Some(password) = req.password.as_deref() {
        validate_password(password)?;
    }
    let expires_at = match req.expires_at.as_deref() {
        Some(raw) => Some(parse_expiry(raw, Utc::now())?),
        None => None,
    };
    for video_id in &req.video_ids {
        if !state.catalog_repository().video_exists(video_id).await? {
            return Err(ApiError::Validation {
                detail: format!("video {video_id} does not exist in the catalog"),
            });
        }
    }

    let password_hash = match req.password.as_deref() {
        // Only reached after validation: hashing a checked password.
        Some(password) => Some(hash_password(password)?),
        None => None,
    };

    let token = generate_share_token();
    let token_hash = hash_share_token(&token);
    let row = state
        .share_repository()
        .create_share(&NewShare {
            owner_id: &owner_id,
            token_hash: &token_hash,
            password_hash: password_hash.as_deref(),
            title,
            expires_at: expires_at.as_deref(),
            video_ids: &req.video_ids,
        })
        .await?;
    tracing::info!(
        share_id = %row.id,
        item_count = req.video_ids.len(),
        "share created"
    );

    Ok((
        StatusCode::CREATED,
        Json(CreatedShareResponse {
            id: row.id,
            title: row.title,
            share_url: format!("/share/{token}"),
            token,
        }),
    ))
}

/// `GET /api/shares` — the owner's management list, newest first.
///
/// Item counts are fetched per share (`list_items().len()`): N+1 reads on
/// a personal-server scale (single owner, dozens of shares) in exchange
/// for zero extra repository surface. Revisit with a JOIN if share counts
/// ever grow.
pub async fn list(State(state): State<AppState>, jar: CookieJar) -> ApiResult<Json<Vec<ShareDto>>> {
    let owner_id = resolve_owner_id(&state, &jar).await?;
    let repo = state.share_repository();
    let rows = repo.list_by_owner(&owner_id.to_string()).await?;

    let now = Utc::now();
    let mut dtos = Vec::with_capacity(rows.len());
    for row in rows {
        let item_count = repo.list_items(&row.id).await?.len() as i64;
        dtos.push(ShareDto {
            status: derive_status(row.revoked_at.as_deref(), row.expires_at.as_deref(), now)
                .as_str(),
            id: row.id,
            title: row.title,
            item_count,
            created_at: row.created_at,
            expires_at: row.expires_at,
            revoked_at: row.revoked_at,
        });
    }
    Ok(Json(dtos))
}

/// Query of `DELETE /api/shares/{id}`: absent or `false` keeps the
/// soft-delete (revoke) semantics; `true` hard-deletes the row instead.
#[derive(Debug, Default, Deserialize)]
pub struct PurgeParams {
    pub purge: Option<bool>,
}

/// `DELETE /api/shares/{id}` — revoke a share (soft delete), or purge it
/// with `?purge=true` (hard delete).
///
/// The default keeps the revoke semantics byte-for-byte: sets
/// `revoked_at`; the row is never deleted, so the action is auditable and
/// reversible only by creating a new share (by design) — the "kill the
/// link, keep the record" case. `?purge=true` is the "remove everything"
/// case: the `shares` row goes away and migration 0012's
/// `ON DELETE CASCADE` takes the `share_items` with it.
///
/// Both variants are idempotent by contract: acting on an already-gone,
/// foreign, or unknown share still returns 204 — the terminal state the
/// caller asked for is the one that holds, and a foreign id stays
/// indistinguishable from an unknown one (no existence leak, same shape
/// as [`ShareRepository::revoke_owned`]). Purge works on revoked and
/// expired rows too, not just active ones. Scoping by `owner_id` keeps
/// the multi-owner seam honest even though this instance has exactly one.
///
/// Recipient-visible effect of a purge: the token-hash row is gone, so
/// `fetch_by_token_hash` finds nothing and the recipient resolve route
/// answers 404 "unknown" — a deleted share is indistinguishable from one
/// that never existed. That is deliberately LESS information than
/// revoke's 410 ("this existed but is dead"): purge is the owner saying
/// the share should leave no trace (spec criterion 8,
/// share-management). The landing page already renders both
/// 404 and 410 as terminal, so recipients see the right card either way.
pub async fn revoke(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
    Query(params): Query<PurgeParams>,
) -> ApiResult<StatusCode> {
    let owner_id = resolve_owner_id(&state, &jar).await?;
    if params.purge.unwrap_or(false) {
        state
            .share_repository()
            .purge_owned(&owner_id.to_string(), &id)
            .await?;
        tracing::info!(share_id = %id, "share purged");
    } else {
        state
            .share_repository()
            .revoke_owned(&owner_id.to_string(), &id)
            .await?;
        tracing::info!(share_id = %id, "share revoked");
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /api/shares/{id}/items` — replace a live share's full item list.
///
/// Validation mirrors [`create`], ordered cheap-first: request shape
/// (non-empty, duplicate-free) → owner/terminal check → catalog existence
/// → one transactional write. Unknown and foreign ids are both plain 404
/// (like [`revoke`], no existence leak across owners), while a known but
/// terminal share is 409: the owner can already see their own revoked or
/// expired row in the management list, so naming the conflict leaks
/// nothing and explains why nothing is editable — there is no audience
/// left to serve a changed list to. Only `share_items` is written; token,
/// password, expiry, and title are untouched by scope (revoke + re-create
/// remains the path for those), so the handed-out link keeps working and
/// serves exactly the new list on the recipient's next request.
pub async fn replace_items(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
    Json(req): Json<ReplaceItemsRequest>,
) -> ApiResult<StatusCode> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;

    if req.video_ids.is_empty() {
        return Err(ApiError::Validation {
            detail: "video_ids must contain at least 1 item".to_string(),
        });
    }
    let unique: HashSet<&String> = req.video_ids.iter().collect();
    if unique.len() != req.video_ids.len() {
        return Err(ApiError::Validation {
            detail: "video_ids contains duplicates".to_string(),
        });
    }

    let row = state
        .share_repository()
        .fetch_owned(&owner_id.to_string(), &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let status = derive_status(
        row.revoked_at.as_deref(),
        row.expires_at.as_deref(),
        Utc::now(),
    );
    if status != ShareStatus::Active {
        return Err(ApiError::Conflict(format!("share is {}", status.as_str())));
    }

    for video_id in &req.video_ids {
        if !state.catalog_repository().video_exists(video_id).await? {
            return Err(ApiError::Validation {
                detail: format!("video {video_id} does not exist in the catalog"),
            });
        }
    }

    state
        .share_repository()
        .replace_items(&owner_id.to_string(), &id, &req.video_ids)
        .await?;
    tracing::info!(
        share_id = %id,
        item_count = req.video_ids.len(),
        "share items replaced"
    );
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/shares/{id}/items` — append catalog videos to a live
/// share's list.
///
/// Validation mirrors [`replace_items`], ordered cheap-first: request
/// shape (non-empty) → owner/terminal check (`fetch_owned` 404,
/// `derive_status` 409) → catalog existence (400) → one transactional
/// write. Appending never rewrites existing membership or positions —
/// new ids join at `MAX(position)+1..` in request order, so the
/// handed-out link keeps working and serves the grown list on the
/// recipient's next request.
///
/// DIVERGENCE from the PUT, on purpose: duplicate ids in the request
/// are **tolerated**, not rejected. An id appearing twice in the request
/// or already in the membership is skipped — an idempotent no-op that
/// still returns 204. (The PUT rejects duplicates with 400 because a
/// replacement list with dupes is ambiguous curation; an append has no
/// such ambiguity — the first occurrence wins, later ones are already
/// there.) Only the empty request is 400.
pub async fn append_items(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
    Json(req): Json<AppendItemsRequest>,
) -> ApiResult<StatusCode> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;

    if req.video_ids.is_empty() {
        return Err(ApiError::Validation {
            detail: "video_ids must contain at least 1 item".to_string(),
        });
    }

    let row = state
        .share_repository()
        .fetch_owned(&owner_id.to_string(), &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let status = derive_status(
        row.revoked_at.as_deref(),
        row.expires_at.as_deref(),
        Utc::now(),
    );
    if status != ShareStatus::Active {
        return Err(ApiError::Conflict(format!("share is {}", status.as_str())));
    }

    for video_id in &req.video_ids {
        if !state.catalog_repository().video_exists(video_id).await? {
            return Err(ApiError::Validation {
                detail: format!("video {video_id} does not exist in the catalog"),
            });
        }
    }

    state
        .share_repository()
        .append_items(&owner_id.to_string(), &id, &req.video_ids)
        .await?;
    tracing::info!(
        share_id = %id,
        requested = req.video_ids.len(),
        "share items appended"
    );
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/shares/{id}/items` — the share's member videos plus its
/// folder tree, for the edit dialog's pre-checks and the manage page's
/// browse.
///
/// The recipient items endpoint is token-scoped and this device may hold
/// no raw token (only the hash exists server-side), so the owner reads
/// members through this session-gated route instead. Same payload as the
/// recipient handler ([`share_items_payload`] — one DTO, two scopes),
/// with owner-neutral summaries: no favorites/ratings/progress
/// enrichment.
///
/// Scoping matches [`replace_items`] (`fetch_owned`): foreign and unknown
/// ids are both plain 404, no existence leak across owners. Status,
/// however, deliberately does **not** match the PUT: this read serves
/// revoked and expired shares too. It feeds history ("what was in this
/// dead share?") rather than a mutation path, and filtering would only
/// add a status branch the dialog doesn't need — recorded here as the
/// permissive choice.
pub async fn list_items(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Json<ShareItemsResponse>> {
    let owner_id = resolve_owner_id(&state, &jar).await?;
    let row = state
        .share_repository()
        .fetch_owned(&owner_id.to_string(), &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(share_items_payload(&state, &row.id).await?))
}

/// `POST /api/shares/{id}/folders` — create a folder in a live share.
///
/// Ladder mirrors [`replace_items`], cheap-first: owner scope
/// ([`require_active_share`] 404/409) → repository validation (name
/// shape 400, depth 400, sibling duplicate 409, see
/// [`folder_write_error`]) → one transactional write. The parent must
/// belong to this share — a foreign or unknown parent folder id is a
/// plain 404, the same no-leak collapse as the share guard (the
/// repository's `Ok(None)`).
pub async fn create_folder(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
    Json(req): Json<CreateFolderRequest>,
) -> ApiResult<impl IntoResponse> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    require_active_share(&state, &owner_id, &id).await?;

    let row = state
        .share_repository()
        .create_folder(
            &owner_id.to_string(),
            &id,
            req.parent_id.as_deref(),
            &req.name,
        )
        .await
        .map_err(folder_write_error)?
        .ok_or(ApiError::NotFound)?;
    tracing::info!(share_id = %id, folder_id = %row.id, "share folder created");
    Ok((StatusCode::CREATED, Json(FolderDto::from(row))))
}

/// `PATCH /api/shares/{id}/folders/{fid}` — rename and/or reparent in
/// one write.
///
/// Absent fields leave the stored value untouched; `parent_id: null`
/// moves the folder to the share root. The rename/reparent pair shares
/// one repository transaction, so a PATCH carrying both lands atomically
/// — the sibling-name check for the move runs against the NEW name in
/// the TARGET scope. Cycle and depth walk as [`create_folder`]; the
/// moved folder appends at the end of its new sibling group and the
/// vacated scope renumbers. Unknown/foreign folder or parent ids are
/// plain 404.
pub async fn update_folder(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((id, folder_id)): Path<(String, String)>,
    Json(req): Json<UpdateFolderRequest>,
) -> ApiResult<Json<FolderDto>> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    require_active_share(&state, &owner_id, &id).await?;

    let row = state
        .share_repository()
        .update_folder(
            &owner_id.to_string(),
            &id,
            &folder_id,
            req.name.as_deref(),
            req.parent_id.as_ref().map(|p| p.as_deref()),
        )
        .await
        .map_err(folder_write_error)?
        .ok_or(ApiError::NotFound)?;
    tracing::info!(share_id = %id, folder_id = %folder_id, "share folder updated");
    Ok(Json(FolderDto::from(row)))
}

/// `DELETE /api/shares/{id}/folders/{fid}` — delete a folder; its
/// contents move to the share root.
///
/// Folder deletion is organization, never membership: no `share_items`
/// row is removed, so no recipient loses access — at worst an item's
/// deep link's neighbors change. The repository's single transaction
/// lifts items (fresh appended positions, subtree order) and flattens
/// subfolders to root, then deletes the row; a success is 204. An
/// unknown or foreign folder id is a plain 404 — the ladder's
/// no-existence-leak rule beats retry-idempotence here, exactly like
/// the item routes treat non-member videos (the folder is gone either
/// way; a re-delete just reports it never knew one).
pub async fn delete_folder(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((id, folder_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    require_active_share(&state, &owner_id, &id).await?;

    state
        .share_repository()
        .delete_folder(&owner_id.to_string(), &id, &folder_id)
        .await
        .map_err(folder_write_error)?
        .ok_or(ApiError::NotFound)?;
    tracing::info!(share_id = %id, folder_id = %folder_id, "share folder deleted");
    Ok(StatusCode::NO_CONTENT)
}

/// `PATCH /api/shares/{id}/items/{video_id}` — move one member item
/// into a folder, or back to the share root with `folder_id: null`.
///
/// Purely presentational: the item keeps its membership (`is_member`
/// is share-scoped), only its scope and tail position change. The
/// target folder must belong to this share and the video must be a
/// member — either failing is a plain 404 (the repository collapses
/// both into `Ok(None)`, same no-leak shape as the folder guards).
pub async fn move_item(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((id, video_id)): Path<(String, String)>,
    Json(req): Json<MoveItemRequest>,
) -> ApiResult<StatusCode> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    require_active_share(&state, &owner_id, &id).await?;

    state
        .share_repository()
        .move_item(
            &owner_id.to_string(),
            &id,
            &video_id,
            req.folder_id.as_deref(),
        )
        .await?
        .ok_or(ApiError::NotFound)?;
    tracing::info!(share_id = %id, video_id = %video_id, "share item moved");
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/shares/{id}/items/{video_id}` — remove one member item
/// (the granular twin of the PUT's full-list rewrite; the manage page
/// migrates here so removals stop resending the list).
///
/// Removing the share's **last** item is refused with 400 — the same
/// "a share must contain at least 1 item" rule the PUT's empty-list
/// rejection enforces, and revoke remains the way to retire a whole
/// share. A non-member video is a plain 404, matching how every other
/// id-scoped route collapses unknown and foreign.
pub async fn remove_item(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((id, video_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    require_active_share(&state, &owner_id, &id).await?;

    match state
        .share_repository()
        .remove_item(&owner_id.to_string(), &id, &video_id)
        .await?
    {
        RemovedItem::Removed => {
            tracing::info!(share_id = %id, video_id = %video_id, "share item removed");
            Ok(StatusCode::NO_CONTENT)
        }
        RemovedItem::Rejected => Err(ApiError::NotFound),
        RemovedItem::LastItem => Err(ApiError::Validation {
            detail: "cannot remove the last item — a share must contain at least 1 item"
                .to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    #[test]
    fn derive_status_prefers_revocation_over_expiry() {
        let n = now();
        let past = "2000-01-01T00:00:00Z";
        assert_eq!(
            derive_status(Some(past), Some(past), n),
            ShareStatus::Revoked,
            "revoked is the terminal word even when also expired"
        );
    }

    #[test]
    fn derive_status_marks_past_expiry_expired_and_future_active() {
        let n = now();
        assert_eq!(
            derive_status(None, Some("2000-01-01T00:00:00Z"), n),
            ShareStatus::Expired
        );
        assert_eq!(
            derive_status(None, Some("2099-01-01T00:00:00Z"), n),
            ShareStatus::Active
        );
        assert_eq!(derive_status(None, None, n), ShareStatus::Active);
    }

    #[test]
    fn derive_status_is_valid_at_the_exact_expiry_instant() {
        // Boundary mirrors VerifiedUnlock::is_current (`now <= expires_at`).
        // Storage timestamps are whole seconds, so pin the instant to one.
        let expiry = DateTime::from_timestamp((now() + Duration::hours(1)).timestamp(), 0)
            .expect("valid whole-second instant");
        let raw = expiry.to_rfc3339_opts(SecondsFormat::Secs, true);
        assert_eq!(derive_status(None, Some(&raw), expiry), ShareStatus::Active);
        assert_eq!(
            derive_status(None, Some(&raw), expiry + Duration::seconds(1)),
            ShareStatus::Expired
        );
    }

    #[test]
    fn derive_status_fails_closed_on_corrupt_expiry() {
        assert_eq!(
            derive_status(None, Some("not-a-timestamp"), now()),
            ShareStatus::Expired,
            "a corrupt row must never present as a live share"
        );
    }

    #[test]
    fn validate_title_defaults_and_bounds() {
        assert_eq!(validate_title(None).unwrap(), DEFAULT_TITLE);
        assert_eq!(validate_title(Some("   ")).unwrap(), DEFAULT_TITLE);
        assert_eq!(validate_title(Some("  Trip  ")).unwrap(), "Trip");
        assert!(validate_title(Some(&"x".repeat(MAX_TITLE_LEN))).is_ok());
        assert!(validate_title(Some(&"x".repeat(MAX_TITLE_LEN + 1))).is_err());
    }

    #[test]
    fn parse_expiry_normalizes_to_utc_z_and_rejects_bad_input() {
        let n = now();
        let normalized = parse_expiry("2030-06-15T12:00:00+08:00", n).unwrap();
        assert_eq!(normalized, "2030-06-15T04:00:00Z");

        assert!(parse_expiry("2000-01-01T00:00:00Z", n).is_err(), "past");
        // Exactly now is not the future.
        let stamp = n.to_rfc3339_opts(SecondsFormat::Secs, true);
        assert!(parse_expiry(&stamp, n).is_err(), "now is not future");
        assert!(
            parse_expiry("2030-06-15T12:00:00", n).is_err(),
            "no timezone"
        );
        assert!(parse_expiry("garbage", n).is_err());
    }
}
