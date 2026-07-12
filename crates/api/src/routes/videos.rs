use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use castify_catalog::{
    CatalogRepository, FolderCount, Provider, ProviderError, ProviderFactory, ThumbnailData,
    TokenBundle, VideoFilter, VideoPage, VideoSort, VideoThumbnailInfo,
};

use crate::auth::resolve_owner;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct VideoQueryParams {
    pub page: Option<i64>,
    pub limit: Option<i64>,
    pub provider: Option<String>,
    pub sort: Option<String>,
    pub q: Option<String>,
    pub duration_min: Option<i64>,
    pub duration_max: Option<i64>,
    pub min_height: Option<i64>,
    pub favorites_only: Option<bool>,
    pub min_rating: Option<i32>,
    pub folder: Option<String>,
}

/// `GET /api/videos` — paginated, deduplicated video list with search, filters,
/// sort, and owner-scoped favorites/ratings enrichment.
pub async fn list_videos(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(params): Query<VideoQueryParams>,
) -> ApiResult<Json<VideoPage>> {
    let owner = resolve_owner(&state, &jar).await?;
    let filter = VideoFilter {
        page: params.page.unwrap_or(1).max(1),
        limit: params.limit.unwrap_or(50).clamp(1, 200),
        provider: params
            .provider
            .as_deref()
            .and_then(|s| Provider::parse(s).ok()),
        sort: VideoSort::parse(params.sort.as_deref().unwrap_or("date-desc")),
        q: params.q.filter(|s| !s.trim().is_empty()),
        duration_min: params.duration_min,
        duration_max: params.duration_max,
        min_height: params.min_height,
        favorites_only: params.favorites_only.unwrap_or(false),
        min_rating: params.min_rating.filter(|&r| (1..=5).contains(&r)),
        folder: params.folder.filter(|s| !s.is_empty()),
        owner_id: owner.id,
    };

    let page = state.catalog_repository().fetch_video_page(&filter).await?;
    Ok(Json(page))
}

/// `GET /api/videos/folders` — top-level folder enumeration with dedup-aware
/// counts (PRD FR-7).
pub async fn list_folders(State(state): State<AppState>) -> ApiResult<Json<Vec<FolderCount>>> {
    let folders = state.catalog_repository().fetch_folders().await?;
    Ok(Json(folders))
}

// ── Favorites + ratings personalization (T6) ─────────────────────────

/// Response body for the favorite mutation routes. Echoes the new state so
/// the frontend can update local cache without a refetch.
#[derive(Debug, Serialize)]
pub struct FavoriteResponse {
    pub is_favorite: bool,
}

/// `POST /api/videos/{id}/favorite` — mark a video as favorited by the current
/// owner (PRD FR-5.1). Idempotent: 200 even if already favorited. Requires
/// CSRF (mutation) + authenticated session (middleware).
pub async fn set_favorite(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Json<FavoriteResponse>> {
    let owner = resolve_owner(&state, &jar).await?;
    let repo = state.catalog_repository();
    if !repo.video_exists(&id).await? {
        return Err(ApiError::NotFound);
    }
    repo.set_favorite(&owner.id, &id).await?;
    Ok(Json(FavoriteResponse { is_favorite: true }))
}

/// `DELETE /api/videos/{id}/favorite` — remove the owner's favorite for a
/// video (PRD FR-5.2). Idempotent: 200 even if not favorited.
pub async fn delete_favorite(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Json<FavoriteResponse>> {
    let owner = resolve_owner(&state, &jar).await?;
    let repo = state.catalog_repository();
    if !repo.video_exists(&id).await? {
        return Err(ApiError::NotFound);
    }
    repo.delete_favorite(&owner.id, &id).await?;
    Ok(Json(FavoriteResponse { is_favorite: false }))
}

/// Request body for `PUT /api/videos/{id}/rating`. `rating` must be 1–5
/// (PRD FR-6.1, FR-6.4); out-of-range values are rejected with 400 before
/// reaching the DB CHECK constraint.
#[derive(Debug, Deserialize)]
pub struct RatingRequest {
    pub rating: i32,
}

/// Response body for the rating mutation routes. `my_rating` is `Some(n)` after
/// a successful PUT, `None` after a successful DELETE.
#[derive(Debug, Serialize)]
pub struct RatingResponse {
    pub my_rating: Option<i32>,
}

/// `PUT /api/videos/{id}/rating` — set or update the owner's rating for a
/// video (PRD FR-6.1). Creates or updates. Requires CSRF. Returns 400 if
/// `rating` is outside 1–5 (FR-6.4).
pub async fn set_rating(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
    Json(body): Json<RatingRequest>,
) -> ApiResult<Json<RatingResponse>> {
    if !(1..=5).contains(&body.rating) {
        return Err(ApiError::Validation {
            detail: "rating must be an integer between 1 and 5".into(),
        });
    }
    let owner = resolve_owner(&state, &jar).await?;
    let repo = state.catalog_repository();
    if !repo.video_exists(&id).await? {
        return Err(ApiError::NotFound);
    }
    repo.upsert_rating(&owner.id, &id, body.rating).await?;
    Ok(Json(RatingResponse {
        my_rating: Some(body.rating),
    }))
}

/// `DELETE /api/videos/{id}/rating` — clear the owner's rating for a video
/// (PRD FR-6.2). Idempotent: 200 even if no rating existed.
pub async fn delete_rating(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Json<RatingResponse>> {
    let owner = resolve_owner(&state, &jar).await?;
    let repo = state.catalog_repository();
    if !repo.video_exists(&id).await? {
        return Err(ApiError::NotFound);
    }
    repo.delete_rating(&owner.id, &id).await?;
    Ok(Json(RatingResponse { my_rating: None }))
}

// ── Thumbnail proxy (T5) ─────────────────────────────────────────────

/// `GET /api/videos/{id}/thumbnail` — lazy thumbnail proxy with filesystem
/// cache (PRD FR-1). On first request the proxy fetches the thumbnail from
/// the video's cloud provider, caches it to `/data/thumbnails/{id}`, and
/// serves the bytes. Subsequent requests are served from the cache.
///
/// Degrades gracefully: 404 when the provider has no thumbnail
/// (`thumbnail_status = "unsupported"`), 502 on transient provider errors
/// (`thumbnail_status = "failed"`). Token refresh on 401 is attempted once.
pub async fn get_thumbnail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let repo = state.catalog_repository();

    let info = repo
        .fetch_video_thumbnail_info(&id)
        .await?
        .ok_or(ApiError::NotFound)?;

    // Fast paths that skip the provider entirely.
    if info.thumbnail_status == "cached" {
        let path = thumbnail_cache_path(&state, &id);
        match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let mime = detect_image_mime(&bytes);
                return Ok(image_response(bytes, mime));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::warn!(video_id = %id, "thumbnail_status=cached but file missing, re-fetching");
            }
            Err(e) => return Err(ApiError::Internal(e.into())),
        }
    } else if info.thumbnail_status == "unsupported" {
        return Err(ApiError::NotFound);
    }

    // Resolve connection → token → factory.
    let conn = repo
        .fetch_connection(&info.connection_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let bundle = repo
        .fetch_token_bundle(&info.connection_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let factory = state
        .factory_for(conn.provider)
        .ok_or_else(|| ApiError::ServiceUnavailable(format!("{} not configured", conn.provider)))?;

    // Fetch from the provider, refreshing the token once on 401.
    let thumbnail = match fetch_thumbnail_with_refresh(&*factory, repo, &info, &bundle).await {
        Ok(data) => data,
        Err(e) => {
            let is_not_found = matches!(e, ProviderError::NotFound(_));
            let status = if is_not_found {
                "unsupported"
            } else {
                "failed"
            };
            let _ = repo.update_thumbnail_status(&id, status).await;
            return Err(if is_not_found {
                ApiError::NotFound
            } else {
                ApiError::Provider(e)
            });
        }
    };

    // Cache the thumbnail to disk.
    let dir = state.config().data_dir.join("thumbnails");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    let path = dir.join(&id);
    tokio::fs::write(&path, &thumbnail.bytes)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;

    // Update status (best-effort — bytes are already served even if this fails).
    let _ = repo.update_thumbnail_status(&id, "cached").await;

    Ok(image_response(thumbnail.bytes, &thumbnail.mime_type))
}

/// Fetch a thumbnail from the provider, refreshing the token once on 401.
/// Returns the raw [`ProviderError`] so the caller can update
/// `thumbnail_status` and map to the appropriate HTTP status.
async fn fetch_thumbnail_with_refresh(
    factory: &dyn ProviderFactory,
    repo: &CatalogRepository,
    info: &VideoThumbnailInfo,
    bundle: &TokenBundle,
) -> Result<ThumbnailData, ProviderError> {
    let provider = factory.create(bundle).await?;
    match provider.fetch_thumbnail(&info.provider_file_id).await {
        Ok(data) => Ok(data),
        Err(ProviderError::Unauthorized) => {
            tracing::info!(
                connection_id = %info.connection_id,
                "token expired, refreshing for thumbnail"
            );
            let new_bundle = factory.refresh_token(bundle).await?;
            repo.update_token_bundle(&info.connection_id, &new_bundle)
                .await
                .map_err(|e| {
                    ProviderError::Other(format!("failed to store refreshed token: {e}"))
                })?;
            let provider = factory.create(&new_bundle).await?;
            provider.fetch_thumbnail(&info.provider_file_id).await
        }
        Err(e) => Err(e),
    }
}

/// Detect image MIME type from magic bytes. PNG: `\x89PNG`; defaults to JPEG
/// (all three providers serve JPEG by default).
fn detect_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 4 && bytes[..4] == [0x89, 0x50, 0x4E, 0x47] {
        "image/png"
    } else {
        "image/jpeg"
    }
}

/// Build a 200 response with image bytes, Content-Type, and Cache-Control.
fn image_response(bytes: Vec<u8>, mime: &str) -> Response {
    let mut resp = Response::new(Body::from(bytes));
    *resp.status_mut() = StatusCode::OK;
    if let Ok(val) = mime.parse() {
        resp.headers_mut().insert(header::CONTENT_TYPE, val);
    }
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    resp
}

fn thumbnail_cache_path(state: &AppState, video_id: &str) -> PathBuf {
    state.config().data_dir.join("thumbnails").join(video_id)
}
