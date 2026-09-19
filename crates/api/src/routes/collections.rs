//! Collections CRUD + membership endpoints (spec F3).
//!
//! `GET /api/collections` — the user's collections, newest first, each
//! with a member count and a small preview for rail cards.
//! `?video_id=` scopes a `contains_video` flag onto each row for the
//! add-to-collection picker.
//!
//! `POST /api/collections` — manual creation (kind forced to `manual`).
//! `GET/PATCH/DELETE /api/collections/{id}` — detail with the full
//! ordered member list, rename, delete (membership cascades).
//!
//! `POST/DELETE /api/collections/{id}/items/{video_id}` — append /
//! remove one video. `PUT /api/collections/{id}/items` — replace the
//! member list with an explicit order.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use castify_catalog::{Collection, CollectionKind, VideoSummary};

use crate::auth::resolve_owner;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Member summaries embedded in collection list cards.
const COLLECTION_PREVIEW_MEMBERS: usize = 4;

// ---------------------------------------------------------------------------
// Collections CRUD + membership (spec F3)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateCollectionRequest {
    pub name: String,
    /// Optional; only `"manual"` is accepted — show/movie/time kinds
    /// exist only on pre-existing rows and cannot be created via the API.
    pub kind: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RenameCollectionRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct ReplaceItemsRequest {
    pub video_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CollectionListDto {
    pub id: String,
    pub name: String,
    pub kind: CollectionKind,
    pub created_at: String,
    pub member_count: i64,
    /// First few members as video summaries (rail cards).
    pub preview: Vec<VideoSummary>,
    /// Only present when the list was scoped with `?video_id=` — the
    /// picker's checkmark state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contains_video: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct CollectionDetailDto {
    pub id: String,
    pub name: String,
    pub kind: CollectionKind,
    pub created_at: String,
    /// All members in curation order.
    pub members: Vec<VideoSummary>,
}

#[derive(Debug, Deserialize)]
pub struct ListCollectionsParams {
    /// When set, each row carries `contains_video` — the picker's
    /// checkmark for this video (spec F5, task 010).
    pub video_id: Option<String>,
}

/// `GET /api/collections` — the user's collections for the browse rail
/// (spec F5), newest first, each with a member-count and a small
/// preview for thumbnails. `?video_id=` scopes membership flags for the
/// add-to-collection picker.
pub async fn list_collections(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(params): Query<ListCollectionsParams>,
) -> ApiResult<Json<Vec<CollectionListDto>>> {
    let _owner = resolve_owner(&state, &jar).await?;
    let repo = state.catalog_repository();

    let mut out = Vec::new();
    for row in repo
        .list_collections_with_counts(params.video_id.as_deref())
        .await?
    {
        let preview_ids: Vec<String> = repo
            .fetch_collection_member_ids(&row.id)
            .await?
            .into_iter()
            .take(COLLECTION_PREVIEW_MEMBERS)
            .collect();
        let preview = repo.fetch_video_summaries_by_ids(&preview_ids).await?;
        out.push(CollectionListDto {
            id: row.id,
            name: row.name,
            kind: row.kind,
            created_at: row.created_at,
            member_count: row.member_count,
            contains_video: row.contains_video,
            preview,
        });
    }
    Ok(Json(out))
}

/// `POST /api/collections` — manual creation (spec F3, user story 2).
pub async fn create_collection(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<CreateCollectionRequest>,
) -> ApiResult<Json<CollectionListDto>> {
    let _owner = resolve_owner(&state, &jar).await?;

    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::Validation {
            detail: "name must not be blank".to_string(),
        });
    }
    match req.kind.as_deref() {
        None | Some("manual") => {}
        Some(other) => {
            return Err(ApiError::Validation {
                detail: format!("kind '{other}' is not creatable here; only 'manual'"),
            });
        }
    }

    let collection = state
        .catalog_repository()
        .create_collection(&name, CollectionKind::Manual)
        .await?;
    tracing::info!(collection_id = %collection.id, "manual collection created");
    Ok(Json(CollectionListDto {
        id: collection.id,
        name: collection.name,
        kind: collection.kind,
        created_at: collection.created_at,
        member_count: 0,
        preview: Vec::new(),
        contains_video: None,
    }))
}

/// `GET /api/collections/{id}` — collection with its full ordered
/// member list.
pub async fn get_collection(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Json<CollectionDetailDto>> {
    let _owner = resolve_owner(&state, &jar).await?;
    let repo = state.catalog_repository();

    let collection: Collection = repo
        .fetch_collection(&id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let member_ids = repo.fetch_collection_member_ids(&id).await?;
    let members = repo.fetch_video_summaries_by_ids(&member_ids).await?;
    Ok(Json(CollectionDetailDto {
        id: collection.id,
        name: collection.name,
        kind: collection.kind,
        created_at: collection.created_at,
        members,
    }))
}

/// `PATCH /api/collections/{id}` — rename (time groups are auto-titled
/// but editable, spec open question 4).
pub async fn rename_collection(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
    Json(req): Json<RenameCollectionRequest>,
) -> ApiResult<Json<Collection>> {
    let _owner = resolve_owner(&state, &jar).await?;

    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::Validation {
            detail: "name must not be blank".to_string(),
        });
    }
    state
        .catalog_repository()
        .rename_collection(&id, &name)
        .await?
        .map(Json)
        .ok_or(ApiError::NotFound)
}

/// `DELETE /api/collections/{id}` — remove the collection; membership
/// cascades (migration 0015).
pub async fn delete_collection(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let _owner = resolve_owner(&state, &jar).await?;

    if state.catalog_repository().delete_collection(&id).await? {
        tracing::info!(collection_id = %id, "collection deleted");
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

/// `POST /api/collections/{id}/items/{video_id}` — add one video at
/// the end of the collection.
///
/// Video-only enforcement (spec F5) is structural: the target id must
/// exist as a row in `videos`. There is no endpoint or repository path
/// that joins a `files` row — a non-video id is simply an unknown
/// `videos` id and fails with 422 before any write.
pub async fn add_collection_item(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((id, video_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let _owner = resolve_owner(&state, &jar).await?;
    let repo = state.catalog_repository();

    if !repo.collection_exists(&id).await? {
        return Err(ApiError::NotFound);
    }
    if !repo.video_exists(&video_id).await? {
        return Err(ApiError::Validation {
            detail: format!("video {video_id} does not exist in the catalog"),
        });
    }

    match repo.add_collection_item(&id, &video_id).await? {
        Some(()) => Ok(StatusCode::NO_CONTENT),
        None => Err(ApiError::Conflict("video already in collection".into())),
    }
}

/// `DELETE /api/collections/{id}/items/{video_id}` — remove one video.
pub async fn remove_collection_item(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((id, video_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let _owner = resolve_owner(&state, &jar).await?;

    if state
        .catalog_repository()
        .remove_collection_item(&id, &video_id)
        .await?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

/// `PUT /api/collections/{id}/items` — replace the member list with an
/// explicit order (reorder, spec F3). All ids must be existing videos;
/// validation runs before the transactional write.
pub async fn replace_collection_items(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
    Json(req): Json<ReplaceItemsRequest>,
) -> ApiResult<StatusCode> {
    let _owner = resolve_owner(&state, &jar).await?;
    let repo = state.catalog_repository();

    if !repo.collection_exists(&id).await? {
        return Err(ApiError::NotFound);
    }
    for video_id in &req.video_ids {
        if !repo.video_exists(video_id).await? {
            return Err(ApiError::Validation {
                detail: format!("video {video_id} does not exist in the catalog"),
            });
        }
    }

    repo.replace_collection_items(&id, &req.video_ids).await?;
    Ok(StatusCode::NO_CONTENT)
}
