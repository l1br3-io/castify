//! Library-collections suggestion endpoints (spec F2).
//!
//! `GET /api/collections/suggestions` — staged groups from the latest
//! completed scans, ordered by member count descending. Default cap is
//! 20 groups (avoid overwhelming first-run users with a 500-group
//! backlog; plan decision #5) with an explicit `limit` to widen. Each
//! group carries a member preview of [`VideoSummary`] entries — default
//! 4, `preview` to widen — so the review UI never needs a second
//! round-trip to render cards.
//!
//! `POST …/suggestions/{id}/accept` — creates the collection +
//! membership in one transaction (repository) and consumes the staged
//! group. Exactly-once: a second accept 404s.
//!
//! `POST …/suggestions/{id}/dismiss` — drops the staged group and
//! persists the suppression by canonical signature; re-scans filter
//! against it (spec F2 — a dismissed group never resurrects).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use castify_catalog::{CollectionKind, CollectionSuggestion, VideoSummary};

use crate::auth::resolve_owner;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Hard ceiling for `limit` — the staging set is regenerated per scan,
/// so paging beyond a few hundred groups has no consumer.
const MAX_LIST_LIMIT: i64 = 100;
/// Hard ceiling for `preview` — previews exist to render cards, not to
/// smuggle the whole member list.
const MAX_PREVIEW_LIMIT: i64 = 50;

#[derive(Debug, Deserialize)]
pub struct SuggestionsParams {
    /// Max groups returned (default 20).
    pub limit: Option<i64>,
    /// Max member summaries per group (default 4).
    pub preview: Option<i64>,
}

/// Wire shape for one staged suggestion group.
#[derive(Debug, Serialize)]
pub struct SuggestionDto {
    pub id: String,
    pub kind: CollectionKind,
    pub title: String,
    pub signature: String,
    pub member_count: i64,
    /// First N members as video summaries, in curation order.
    pub members: Vec<VideoSummary>,
}

#[derive(Debug, Serialize)]
pub struct AcceptedCollectionDto {
    pub id: String,
    pub name: String,
    pub kind: CollectionKind,
    pub created_at: String,
    pub member_count: i64,
}

/// `GET /api/collections/suggestions` — review-queue listing (spec F2).
pub async fn list_suggestions(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(params): Query<SuggestionsParams>,
) -> ApiResult<Json<Vec<SuggestionDto>>> {
    let _owner = resolve_owner(&state, &jar).await?;
    let limit = params
        .limit
        .unwrap_or(20)
        .clamp(1, MAX_LIST_LIMIT);
    let preview = params
        .preview
        .unwrap_or(4)
        .clamp(1, MAX_PREVIEW_LIMIT) as usize;

    let groups = state
        .catalog_repository()
        .fetch_all_collection_suggestions(limit)
        .await?;

    let dtos = hydrate_suggestions(&state, groups, preview).await?;
    Ok(Json(dtos))
}

/// Hydrate member previews. One by-ids read per group: staging is
/// capped (≤ [`MAX_LIST_LIMIT`] groups), so this stays a bounded
/// handful of indexed queries per request.
async fn hydrate_suggestions(
    state: &AppState,
    groups: Vec<CollectionSuggestion>,
    preview: usize,
) -> ApiResult<Vec<SuggestionDto>> {
    let repo = state.catalog_repository();
    let mut dtos = Vec::with_capacity(groups.len());
    for group in groups {
        let member_ids = repo
            .fetch_collection_suggestion_video_ids(&group.id)
            .await?;
        let preview_ids: Vec<String> = member_ids.iter().take(preview).cloned().collect();
        let members = repo.fetch_video_summaries_by_ids(&preview_ids).await?;
        dtos.push(SuggestionDto {
            id: group.id,
            kind: group.kind,
            title: group.title,
            signature: group.signature,
            member_count: group.member_count,
            members,
        });
    }
    Ok(dtos)
}

/// `POST /api/collections/suggestions/{id}/accept` — suggestion becomes
/// a real collection (one transaction, staged group consumed).
pub async fn accept_suggestion(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Json<AcceptedCollectionDto>> {
    let _owner = resolve_owner(&state, &jar).await?;

    let repo = state.catalog_repository();
    let collection = repo
        .accept_collection_suggestion(&id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let member_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collection_items WHERE collection_id = ?",
    )
    .bind(&collection.id)
    .fetch_one(repo.pool())
    .await
    .unwrap_or(0);

    tracing::info!(
        collection_id = %collection.id,
        name = %collection.name,
        member_count,
        "collection suggestion accepted"
    );
    Ok(Json(AcceptedCollectionDto {
        id: collection.id,
        name: collection.name,
        kind: collection.kind,
        created_at: collection.created_at,
        member_count,
    }))
}

/// `POST /api/collections/suggestions/{id}/dismiss` — suppress this
/// signature for the connection, consume the staged group.
pub async fn dismiss_suggestion(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let _owner = resolve_owner(&state, &jar).await?;

    let repo = state.catalog_repository();
    let Some((connection_id, signature)) = repo.take_collection_suggestion(&id).await? else {
        return Err(ApiError::NotFound);
    };
    repo.dismiss_collection_suggestion(&connection_id, &signature)
        .await?;

    tracing::info!(
        connection_id = %connection_id,
        signature = %signature,
        "collection suggestion dismissed"
    );
    Ok(StatusCode::NO_CONTENT)
}
