use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Instant;

use bytes::Bytes;
use castify_cache::{DiskCache, StreamingCacheWriter};
use futures::Stream;
use tracing::Span;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use castify_catalog::{
    BodyStream, CatalogRepository, FolderCount, NewTranscodeEntry, PlaybackProgress, Provider,
    ProviderError, ProviderFactory, StreamResponse, StreamUrl, SubtitleTrack, ThumbnailData,
    TokenBundle, VideoDetail, VideoFilter, VideoPage, VideoSort, VideoStreamInfo,
    VideoThumbnailInfo,
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
    pub in_progress: Option<bool>,
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
        in_progress: params.in_progress.unwrap_or(false),
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

/// `GET /api/videos/{id}` — full video metadata for the player page, enriched
/// with favorites, ratings, playback progress, and subtitle tracks (FR-4.1).
pub async fn get_video_detail(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Json<VideoDetail>> {
    let owner = resolve_owner(&state, &jar).await?;
    let detail = state
        .catalog_repository()
        .fetch_video_detail(&id, &owner.id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(detail))
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

// ── Playback progress (T4) ──────────────────────────────────────────

/// Request body for `POST /api/videos/{id}/progress`. `position_seconds` is
/// required; `duration_seconds` and `completed` are optional (the player
/// sends `duration_seconds` once known, and `completed=true` at 95%+).
#[derive(Debug, Deserialize)]
pub struct ProgressRequest {
    pub position_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub completed: Option<bool>,
}

/// Response body for progress endpoints. Echoes the persisted state.
#[derive(Debug, Serialize)]
pub struct ProgressResponse {
    pub position_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub completed: bool,
    pub updated_at: String,
}

impl From<PlaybackProgress> for ProgressResponse {
    fn from(p: PlaybackProgress) -> Self {
        Self {
            position_seconds: p.position_seconds,
            duration_seconds: p.duration_seconds,
            completed: p.completed,
            updated_at: p.updated_at,
        }
    }
}

/// `POST /api/videos/{id}/progress` — save playback progress for resume
/// (PRD M3 FR-3.1). CSRF required. 404 if video doesn't exist. Idempotent
/// via upsert — repeated saves from periodic progress tracking update in
/// place.
pub async fn set_progress(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
    Json(body): Json<ProgressRequest>,
) -> ApiResult<Json<ProgressResponse>> {
    let owner = resolve_owner(&state, &jar).await?;
    let repo = state.catalog_repository();
    if !repo.video_exists(&id).await? {
        return Err(ApiError::NotFound);
    }
    let completed = body.completed.unwrap_or(false);
    repo.upsert_progress(
        &owner.id,
        &id,
        body.position_seconds,
        body.duration_seconds,
        completed,
    )
    .await?;
    let progress = repo.fetch_progress(&owner.id, &id).await?;
    Ok(Json(progress.map(ProgressResponse::from).unwrap_or(
        ProgressResponse {
            position_seconds: body.position_seconds,
            duration_seconds: body.duration_seconds,
            completed,
            updated_at: String::new(),
        },
    )))
}

/// `GET /api/videos/{id}/progress` — retrieve saved playback position
/// (PRD M3 FR-3.2). Returns 404 if no progress has been recorded.
pub async fn get_progress(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Json<ProgressResponse>> {
    let owner = resolve_owner(&state, &jar).await?;
    let repo = state.catalog_repository();
    let progress = repo
        .fetch_progress(&owner.id, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(ProgressResponse::from(progress)))
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
                map_post_refresh_error(e, &info.connection_id, info.provider)
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

// ── Stream + download proxy (T3) ────────────────────────────────────

/// `GET /api/videos/{id}/stream` — streams video bytes from the connected
/// cloud provider to the browser with Range-header passthrough (PRD FR-1).
/// Resolves video → connection → token → factory → `open_stream(file_id, range)`,
/// forwarding the browser's `Range` header. Token refresh on 401 (before any
/// bytes are sent). Mirrors the thumbnail proxy pattern.
///
/// 404 on missing video. 503 on unconfigured provider. 502 on provider error.
pub async fn get_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let start = Instant::now();
    let stream_info = resolve_stream_info(&state, &id).await?;
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let stream_response = open_stream_with_refresh(&state, &stream_info, range.as_deref()).await?;
    // Tee to disk cache before instrumentation so the cache captures raw
    // provider bytes (instrumentation would see post-tee bytes, which is
    // fine semantically but it's cleaner to separate concerns).
    let teed = maybe_tee_stream_response(
        &state,
        stream_response,
        &id,
        &stream_info.connection_id,
        &stream_info.provider_file_id,
    )
    .await;
    let instrumented = instrument_stream_response(teed, &id, range.as_deref(), start);
    Ok(stream_to_response(instrumented, None))
}

/// `GET /api/videos/{id}/download` — identical to `/stream` but adds
/// `Content-Disposition: attachment` so the browser triggers a file download
/// (PRD FR-1.8). Used by the player's unsupported-format fallback.
pub async fn get_download(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let start = Instant::now();
    let stream_info = resolve_stream_info(&state, &id).await?;
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let stream_response = open_stream_with_refresh(&state, &stream_info, range.as_deref()).await?;
    let disposition = build_content_disposition(&stream_info.name);
    let teed = maybe_tee_stream_response(
        &state,
        stream_response,
        &id,
        &stream_info.connection_id,
        &stream_info.provider_file_id,
    )
    .await;
    let instrumented = instrument_stream_response(teed, &id, range.as_deref(), start);
    Ok(stream_to_response(instrumented, Some(&disposition)))
}

/// Resolve video → connection → token → factory, then call
/// `provider.open_stream(file_id, range)` with a single token-refresh retry
/// on 401. Mirrors `fetch_thumbnail_with_refresh`.
pub(crate) async fn open_stream_with_refresh(
    state: &AppState,
    info: &VideoStreamInfo,
    range: Option<&str>,
) -> ApiResult<StreamResponse> {
    let repo = state.catalog_repository();

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

    let provider = factory.create(&bundle).await.map_err(ApiError::Provider)?;
    match provider.open_stream(&info.provider_file_id, range).await {
        Ok(resp) => Ok(resp),
        Err(ProviderError::Unauthorized) => {
            tracing::info!(
                connection_id = %info.connection_id,
                "token expired, refreshing for stream"
            );
            let new_bundle = factory
                .refresh_token(&bundle)
                .await
                .map_err(|e| map_refresh_error(e, &info.connection_id, conn.provider))?;
            repo.update_token_bundle(&info.connection_id, &new_bundle)
                .await
                .map_err(|e| ApiError::Internal(e.into()))?;
            let provider = factory
                .create(&new_bundle)
                .await
                .map_err(ApiError::Provider)?;
            provider
                .open_stream(&info.provider_file_id, range)
                .await
                .map_err(|e| map_post_refresh_error(e, &info.connection_id, conn.provider))
        }
        Err(e) => Err(map_stream_error(e)),
    }
}

/// Map `ProviderError` to the appropriate `ApiError`. `NotFound` → 404
/// (video exists in our DB but the provider can't find/serve the file);
/// `ReauthRequired` → 401 with `code: "reauth_required"` (the refresh token
/// died mid-flow — unlikely here, but defensive); all others → 502 Bad
/// Gateway via `ApiError::Provider`.
fn map_stream_error(e: ProviderError) -> ApiError {
    if matches!(e, ProviderError::NotFound(_)) {
        ApiError::NotFound
    } else {
        ApiError::Provider(e)
    }
}

/// Map a `refresh_token` failure into an `ApiError`, promoting
/// [`ProviderError::ReauthRequired`] (raised by `classify_token_error` when
/// the provider returns `error: "invalid_grant"`) to a structured
/// [`ApiError::ReauthRequired`]. Other errors fall through as 502
/// `ApiError::Provider`. Called from every refresh-with-retry site so the
/// reconnect signal is consistent across thumbnail / stream / stream-url /
/// subtitle endpoints.
fn map_refresh_error(
    e: ProviderError,
    connection_id: &str,
    provider: castify_catalog::Provider,
) -> ApiError {
    match e {
        ProviderError::ReauthRequired => ApiError::ReauthRequired {
            connection_id: connection_id.to_string(),
            provider,
        },
        other => ApiError::Provider(other),
    }
}

/// Map a provider error observed AFTER a refresh+retry. By this point the
/// access token has been refreshed and the call retried; any residual
/// [`ProviderError::Unauthorized`] means the grant itself can't recover the
/// call — the refresh token is dead but the provider didn't signal it as a
/// clean `invalid_grant`, or scope/permission drift, or clock skew the
/// refresh couldn't paper over. Promote to [`ApiError::ReauthRequired`] so
/// the client routes the user to reconnect — otherwise we leak the raw
/// `{"message":"unauthorized: token may be expired or revoked"}` as a 502,
/// giving the user no actionable path.
///
/// Semantically: [`ProviderError::Unauthorized`] doc says "the caller should
/// refresh once and retry" — we did, and it didn't recover, so we treat the
/// grant as dead and let the existing reconnect UX take over.
fn map_post_refresh_error(
    e: ProviderError,
    connection_id: &str,
    provider: castify_catalog::Provider,
) -> ApiError {
    match e {
        ProviderError::Unauthorized | ProviderError::ReauthRequired => ApiError::ReauthRequired {
            connection_id: connection_id.to_string(),
            provider,
        },
        ProviderError::NotFound(_) => ApiError::NotFound,
        other => ApiError::Provider(other),
    }
}

/// `GET /api/videos/{id}/stream-url` — resolve where the browser should
/// fetch video bytes from. Per-provider strategy picks the smoothest path:
///
/// - **OneDrive + Dropbox**: short-lived preauthenticated CDN URL the browser
///   hits directly (`strategy: "direct"`). Provider-native URLs are smooth in
///   the browser; the backend resolves the URL, the browser fetches.
/// - **Google Drive**: tries `?alt=media` redirect first; if Drive cooperates
///   (302 to pre-signed CDN URL), returns `strategy: "direct"` with that URL.
///   If Drive serves bytes inline (rare: restricted sharing, propagation
///   lag), falls back to `strategy: "proxy"` pointing at the existing
///   `/stream` endpoint. The proxy is fine — self-hosted means server
///   bandwidth is free; we pick whichever path delivers smoothest playback.
///
/// Self-hosted posture: pick the path that delivers the best UX per provider,
/// not the path that minimizes server load. See
/// `docs/prds/m3.5-streaming-posture-refactor.md` and the data-storage
/// principles anti-pattern #2 for the full rationale.
///
/// Token refresh on 401 (before any bytes are sent). 404 on missing video,
/// 503 on unconfigured provider, 502 on provider error.
pub async fn get_stream_url(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<StreamUrlResponse>> {
    let start = Instant::now();
    let stream_info = resolve_stream_info(&state, &id).await?;
    let repo = state.catalog_repository();

    // Check cache first (M4). If we have a valid cache entry (correct
    // provider_file_id + file exists on disk), return Cached strategy.
    if let Some(entry) = repo.fetch_video_cache_entry(&id).await? {
        if entry.provider_file_id == stream_info.provider_file_id {
            // Verify file still exists on disk.
            let cache_hit = if let Some(cache) = state.video_cache() {
                cache.exists(&id).await.unwrap_or(false)
            } else {
                false
            };
            if cache_hit {
                repo.touch_video_cache_entry(&id).await?;
                let response = StreamUrlResponse {
                    url: format!("/api/videos/{id}/cached-stream"),
                    strategy: "cached".into(),
                    expires_at: None,
                };
                tracing::info!(
                    video_id = %id,
                    strategy = %response.strategy,
                    resolve_ms = start.elapsed().as_millis() as u64,
                    "stream-url resolved"
                );
                return Ok(Json(response));
            } else {
                // File missing on disk but manifest says cached — clean up.
                tracing::info!(video_id = %id, "cache file missing; evicting manifest row");
                repo.delete_video_cache_entry(&id).await?;
            }
        } else {
            // Stale cache (provider replaced the file). Evict.
            tracing::info!(video_id = %id, "cache entry stale; evicting");
            repo.delete_video_cache_entry(&id).await?;
            if let Some(cache) = state.video_cache() {
                let _ = cache.delete(&id).await;
            }
        }
    }

    let stream_url = resolve_stream_url_with_refresh(&state, &stream_info).await?;
    let response = StreamUrlResponse::from_stream_url(&stream_url, &stream_info.id);

    // M6: codec-based transcode trigger. If the video's codec is known
    // (via M5 probe) and is browser-incompatible, override to transcode
    // strategy regardless of what the provider returned.
    let response = maybe_override_to_transcode(&state, &id, response).await;

    tracing::info!(
        video_id = %id,
        strategy = %response.strategy,
        resolve_ms = start.elapsed().as_millis() as u64,
        "stream-url resolved"
    );

    // Lazy probe trigger (M5): fire-and-forget if this video hasn't been
    // probed yet. The probe downloads 1 MB via the provider's open_stream,
    // shells out to ffprobe, and updates the codec columns. Failures are
    // logged and don't affect playback.
    spawn_lazy_probe(&state, &stream_info);

    Ok(Json(response))
}

/// Check if the video's codec requires transcoding (M6). If the codec is
/// known and browser-incompatible, override the response to return the
/// transcode master URL instead of the direct/proxy/cached URL.
async fn maybe_override_to_transcode(
    state: &AppState,
    video_id: &str,
    mut response: StreamUrlResponse,
) -> StreamUrlResponse {
    use sqlx::Row;

    // Only override if transcode is enabled in config.
    if !state.config().transcode.enabled {
        return response;
    }

    // Fetch codec info from the videos table.
    let pool = state.pool();
    let row = sqlx::query(
        r#"SELECT video_codec, audio_codec FROM videos WHERE id = ?"#,
    )
    .bind(video_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some(row)) = row else {
        return response; // Video not found or query error — keep existing strategy.
    };

    let video_codec: Option<String> = row.get("video_codec");
    let audio_codec: Option<String> = row.get("audio_codec");

    let (Some(vc), Some(ac)) = (video_codec.as_deref(), audio_codec.as_deref()) else {
        return response; // Not probed yet — let lazy probe handle it.
    };

    use castify_catalog::codec_support;
    if codec_support::codec_strategy(vc, Some(ac))
        == codec_support::TranscodeDecision::MustTranscode
    {
        tracing::info!(
            %video_id,
            video_codec = %vc,
            audio_codec = %ac,
            "codec incompatible; overriding to transcode strategy"
        );
        response = StreamUrlResponse {
            url: format!("/api/videos/{video_id}/transcode/master.m3u8"),
            strategy: "transcode".into(),
            expires_at: None,
        };
    }

    response
}

/// Spawn a background probe task for `stream_info` if it hasn't been
/// probed yet. Fire-and-forget — the caller's response is not delayed.
/// Uses the same connection/token/factory pipeline as `/stream`.
fn spawn_lazy_probe(state: &AppState, info: &VideoStreamInfo) {
    use castify_catalog::probe;

    let state = state.clone();
    let video_id = info.id.clone();
    let connection_id = info.connection_id.clone();
    let provider_file_id = info.provider_file_id.clone();

    tokio::spawn(async move {
        let repo = state.catalog_repository().clone();

        // Check if already probed — skip if so.
        let needs_probe: bool = sqlx::query_scalar(
            "SELECT CASE WHEN probe_status = 'pending' THEN 1 ELSE 0 END FROM videos WHERE id = ?",
        )
        .bind(&video_id)
        .fetch_optional(repo.pool())
        .await
        .ok()
        .flatten()
        .map(|v: i64| v != 0)
        .unwrap_or(false);

        if !needs_probe {
            return;
        }

        // Fetch 1 MB from the provider for probing.
        let probe_bytes = match fetch_probe_bytes(&state, &connection_id, &provider_file_id).await {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::warn!(error = %e, %video_id, "lazy probe: failed to fetch bytes");
                let _ = repo.mark_probe_failed(&video_id, "failed").await;
                return;
            }
        };

        // Probe via ffprobe.
        match probe::probe_video(&probe_bytes).await {
            probe::ProbeResult::Ok(info) => {
                tracing::info!(
                    %video_id,
                    video_codec = ?info.video_codec,
                    audio_codec = ?info.audio_codec,
                    "lazy probe complete"
                );
                if let Err(e) = repo
                    .update_video_probe_info(
                        &video_id,
                        info.video_codec.as_deref(),
                        info.audio_codec.as_deref(),
                        info.bitrate,
                        info.framerate,
                    )
                    .await
                {
                    tracing::warn!(error = %e, %video_id, "lazy probe: failed to update DB");
                }

                // Upsert embedded subtitle tracks.
                let _ = repo.clear_subtitle_tracks(&video_id).await;
                for track in &info.embedded_subtitle_tracks {
                    let track_id = format!("{video_id}-sub-{}", track.embedded_index);
                    let _ = repo
                        .upsert_subtitle_track(
                            &track_id,
                            &video_id,
                            track.embedded_index,
                            &track.codec,
                            &track.format_family.to_string(),
                            track.language.as_deref(),
                            track.title.as_deref(),
                        )
                        .await;
                }

                // M8 Task 006: extract embedded text subtitle tracks to disk
                // and upsert into `video_subtitles`. Best-effort — per-track
                // failures are logged and never mark the probe failed.
                crate::subtitle_extraction::extract_embedded_text_subtitles(
                    &state, &video_id, &info,
                )
                .await;
            }
            probe::ProbeResult::NeedsMoreBytes => {
                tracing::info!(%video_id, "probe needs more bytes; marking");
                let _ = repo.mark_probe_failed(&video_id, "needs_more_bytes").await;
            }
            probe::ProbeResult::UnsupportedContainer(c) => {
                tracing::info!(%video_id, container = %c, "probe: unsupported container");
                let _ = repo.mark_probe_failed(&video_id, "unsupported_container").await;
            }
            probe::ProbeResult::Failed(e) => {
                tracing::warn!(error = %e, %video_id, "probe failed");
                let _ = repo.mark_probe_failed(&video_id, "failed").await;
            }
        }
    });
}

/// Download the first ~1 MB of a video via the provider's open_stream,
/// for probing. Reuses the existing factory/token-refresh pipeline.
async fn fetch_probe_bytes(
    state: &AppState,
    connection_id: &str,
    provider_file_id: &str,
) -> Result<Vec<u8>, anyhow::Error> {
    use bytes::Bytes;
    use futures::StreamExt;

    let repo = state.catalog_repository();
    let conn = repo
        .fetch_connection(connection_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("connection not found: {connection_id}"))?;
    let bundle = repo
        .fetch_token_bundle(connection_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("token bundle not found: {connection_id}"))?;
    let factory = state
        .factory_for(conn.provider)
        .ok_or_else(|| anyhow::anyhow!("provider not configured: {}", conn.provider))?;
    let provider = factory.create(&bundle).await?;

    let range = "bytes=0-1048575"; // 1 MB
    let response = match provider.open_stream(provider_file_id, Some(range)).await {
        Ok(r) => r,
        Err(castify_catalog::ProviderError::Unauthorized) => {
            tracing::info!(%connection_id, "probe: token expired, refreshing");
            let new_bundle = factory.refresh_token(&bundle).await?;
            repo.update_token_bundle(connection_id, &new_bundle).await?;
            let provider = factory.create(&new_bundle).await?;
            provider.open_stream(provider_file_id, Some(range)).await?
        }
        Err(e) => return Err(e.into()),
    };

    // Collect the body into a Vec<u8>. 1 MB is fine to buffer.
    let mut bytes: Vec<u8> = Vec::with_capacity(1024 * 1024);
    let mut body = response.body;
    while let Some(chunk) = body.next().await {
        let chunk: Bytes = chunk?;
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= 1024 * 1024 {
            break; // we have enough
        }
    }
    Ok(bytes)
}

/// API response shape for `/stream-url`. `strategy` tells the frontend which
/// path it's on; `url` is the concrete URL to set as `<video src>`;
/// `expires_at` (ISO-8601 UTC, or null) lets the frontend pre-emptively
/// re-fetch before a Direct CDN URL stops working.
#[derive(Debug, Serialize)]
pub struct StreamUrlResponse {
    pub url: String,
    pub strategy: String,
    pub expires_at: Option<String>,
}

impl StreamUrlResponse {
    fn from_stream_url(stream_url: &StreamUrl, video_id: &str) -> Self {
        match stream_url {
            StreamUrl::Direct { url, expires_at } => Self {
                url: url.clone(),
                strategy: "direct".into(),
                expires_at: expires_at.clone(),
            },
            // For the proxy path, point the browser at the existing /stream
            // endpoint. The proxy handles token refresh and Range internally.
            StreamUrl::Proxied => Self {
                url: format!("/api/videos/{video_id}/stream"),
                strategy: "proxy".into(),
                expires_at: None,
            },
            // Cached path (M4): the video is on local disk. The frontend
            // treats `cached` identically to `direct` for `<video src>` —
            // just a different URL.
            StreamUrl::Cached { url, size_bytes: _ } => Self {
                url: url.clone(),
                strategy: "cached".into(),
                expires_at: None,
            },
            // Transcode path (M6): codec incompatible. Frontend uses hls.js
            // to consume the HLS master playlist.
            StreamUrl::Transcode { master_url } => Self {
                url: master_url.clone(),
                strategy: "transcode".into(),
                expires_at: None,
            },
        }
    }
}

/// Resolve video → connection → token → factory, then call
/// `provider.open_stream_url(file_id)` with a single token-refresh retry
/// on 401. Mirrors `open_stream_with_refresh` — the refresh-then-retry
/// pattern is identical, just on a different trait method.
async fn resolve_stream_url_with_refresh(
    state: &AppState,
    info: &VideoStreamInfo,
) -> ApiResult<StreamUrl> {
    let repo = state.catalog_repository();

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

    let provider = factory.create(&bundle).await.map_err(ApiError::Provider)?;
    match provider.open_stream_url(&info.provider_file_id).await {
        Ok(url) => Ok(url),
        Err(ProviderError::Unauthorized) => {
            tracing::info!(
                connection_id = %info.connection_id,
                "token expired, refreshing for stream-url"
            );
            let new_bundle = factory
                .refresh_token(&bundle)
                .await
                .map_err(|e| map_refresh_error(e, &info.connection_id, conn.provider))?;
            repo.update_token_bundle(&info.connection_id, &new_bundle)
                .await
                .map_err(|e| ApiError::Internal(e.into()))?;
            let provider = factory
                .create(&new_bundle)
                .await
                .map_err(ApiError::Provider)?;
            provider
                .open_stream_url(&info.provider_file_id)
                .await
                .map_err(|e| map_post_refresh_error(e, &info.connection_id, conn.provider))
        }
        Err(e) => Err(map_stream_error(e)),
    }
}

/// Fetch `VideoStreamInfo` from the DB, 404 if not found.
pub(crate) async fn resolve_stream_info(state: &AppState, id: &str) -> ApiResult<VideoStreamInfo> {
    state
        .catalog_repository()
        .fetch_video_stream_info(id)
        .await?
        .ok_or(ApiError::NotFound)
}

// ── Hot video cache tee (M4) ────────────────────────────────────────

/// Wrap a `StreamResponse` body with a tee that concurrently writes bytes
/// to the hot-video disk cache. The wrapper sends each chunk to an
/// unbounded channel; a background task reads from the channel and writes
/// to disk via `StreamingCacheWriter`. On body end (or HTTP response
/// drop), the channel closes and the background task finalizes the cache
/// entry + writes the manifest row.
///
/// If the cache is disabled or the writer fails to start, this is a no-op
/// — the original `StreamResponse` is returned unchanged.
async fn maybe_tee_stream_response(
    state: &AppState,
    stream_response: StreamResponse,
    video_id: &str,
    connection_id: &str,
    provider_file_id: &str,
) -> StreamResponse {
    let Some(cache) = state.video_cache() else {
        return stream_response;
    };

    let writer = match cache.start_streaming_write(video_id).await {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!(error = %e, %video_id, "failed to start cache write");
            return stream_response;
        }
    };

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    let cache_clone = Arc::clone(cache);
    let repo = state.catalog_repository().clone();
    let video_id_owned = video_id.to_string();
    let connection_id_owned = connection_id.to_string();
    let provider_file_id_owned = provider_file_id.to_string();
    let span = tracing::Span::current();

    tokio::spawn(async move {
        cache_write_task(
            rx,
            Some(writer),
            cache_clone,
            repo,
            &video_id_owned,
            &connection_id_owned,
            &provider_file_id_owned,
            span,
        )
        .await;
    });

    let StreamResponse {
        status,
        content_type,
        content_length,
        content_range,
        body,
    } = stream_response;

    StreamResponse {
        status,
        content_type,
        content_length,
        content_range,
        body: Box::pin(ChannelTeeStream {
            inner: body,
            sender: Some(tx),
            span: tracing::Span::current(),
        }),
    }
}

/// Background task: read from the tee channel, write bytes to disk via
/// `StreamingCacheWriter`, finalize on channel close, write manifest row.
/// Failures are logged but don't propagate — the HTTP response has
/// already been served by the time this task runs.
#[allow(clippy::too_many_arguments)]
async fn cache_write_task(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Bytes>,
    mut writer: Option<StreamingCacheWriter>,
    _cache: Arc<DiskCache>,
    repo: CatalogRepository,
    video_id: &str,
    connection_id: &str,
    provider_file_id: &str,
    span: Span,
) {
    while let Some(chunk) = rx.recv().await {
        if let Some(w) = writer.as_mut() {
            if let Err(e) = w.write_chunk(&chunk).await {
                let _g = span.enter();
                tracing::warn!(error = %e, %video_id, "cache disk write failed; aborting");
                if let Some(w) = writer.take() {
                    let _ = w.abort().await;
                }
            }
        }
        // If writer is None (aborted), we just drain the channel to keep
        // the tee non-blocking. The HTTP response continues; we simply stop
        // caching.
    }

    let Some(writer) = writer else {
        return;
    };

    let _g = span.enter();
    match writer.finalize().await {
        Ok(size) => {
            tracing::info!(%video_id, size_bytes = size, "cache write complete");
            if let Err(e) = repo
                .upsert_video_cache_entry(video_id, connection_id, provider_file_id, size)
                .await
            {
                tracing::warn!(error = %e, %video_id, "failed to write cache manifest row");
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, %video_id, "cache finalize failed");
        }
    }
}

/// A stream wrapper that tees each chunk to an unbounded channel. The
/// sender is sync (`unbounded_send`), so this works inside `poll_next`
/// without async I/O. Channel closure (sender dropped by the wrapper's
/// own Drop, or receiver dropped by the background task dying) is
/// treated as "stop teeing" — the stream continues to serve the HTTP
/// response even if the cache path is dead.
struct ChannelTeeStream {
    inner: BodyStream,
    /// `None` after the channel has been closed (body ended or errored).
    sender: Option<tokio::sync::mpsc::UnboundedSender<Bytes>>,
    span: Span,
}

impl Stream for ChannelTeeStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match this.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                // Tee to background task. Errors here mean the receiver is
                // gone (background task died). We stop teeing but keep
                // serving the HTTP response.
                if let Some(sender) = this.sender.as_ref() {
                    if sender.send(chunk.clone()).is_err() {
                        let _g = this.span.enter();
                        tracing::debug!("cache tee channel closed; stopping teeing");
                        this.sender.take();
                    }
                }
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(None) => {
                // Body ended. Drop the sender to signal the background task
                // to finalize.
                this.sender.take();
                Poll::Ready(None)
            }
            Poll::Ready(Some(Err(e))) => {
                let _g = this.span.enter();
                tracing::warn!(error = %e, "stream body error");
                this.sender.take();
                Poll::Ready(Some(Err(e)))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

/// `GET /api/videos/{id}/cached-stream` — serve video bytes from the
/// hot-video disk cache (M4). Mirrors `/stream` response shape (status,
/// Content-Type, Content-Length, Content-Range, Accept-Ranges) but reads
/// from local disk instead of fetching from the provider. Auth required,
/// no CSRF (safe GET).
///
/// Returns 404 if the video or cache entry doesn't exist. Falls through
/// to the regular `/stream` endpoint via a redirect (302) when the cache
/// is enabled but the entry is missing — but the frontend typically
/// calls `/stream-url` first to learn the strategy, so this is a
/// safety net for race conditions.
pub async fn get_cached_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cache = state
        .video_cache()
        .ok_or(ApiError::NotFound)?
        .clone();

    let stream_info = resolve_stream_info(&state, &id).await?;

    // Verify cache entry exists and is current.
    let entry = state
        .catalog_repository()
        .fetch_video_cache_entry(&id)
        .await?
        .ok_or(ApiError::NotFound)?;

    if entry.provider_file_id != stream_info.provider_file_id {
        tracing::info!(%id, "cached-stream: stale entry; falling through to 404");
        return Err(ApiError::NotFound);
    }

    // Open file from disk.
    let file = cache
        .open(&id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?
        .ok_or(ApiError::NotFound)?;

    // Touch on read (cheap).
    let _ = state.catalog_repository().touch_video_cache_entry(&id).await;

    // Get file size from metadata.
    let metadata = file.metadata().await.map_err(|e| {
        ApiError::Internal(anyhow::anyhow!(format!("failed to read file metadata: {e}")))
    })?;
    let total = metadata.len();

    let range_header = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Parse Range header for 206 partial content.
    if let Some(range_str) = range_header.as_deref() {
        if let Some((start, end)) = parse_byte_range(range_str, total) {
            let mut file = file;
            file.seek(std::io::SeekFrom::Start(start))
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

            let bytes_to_read = end - start + 1;
            let reader = file.take(bytes_to_read);
            let body = Body::from_stream(ReaderStream::new(reader));

            let mut resp = Response::new(body);
            *resp.status_mut() = StatusCode::PARTIAL_CONTENT;
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(
                    &stream_info.mime_type.unwrap_or_else(|| "video/mp4".to_string()),
                )
                .unwrap_or_else(|_| HeaderValue::from_static("video/mp4")),
            );
            resp.headers_mut().insert(
                header::CONTENT_LENGTH,
                HeaderValue::from_str(&bytes_to_read.to_string()).unwrap(),
            );
            resp.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")).unwrap(),
            );
            resp.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            return Ok(resp);
        }
    }

    // Full content (no Range or unparseable Range).
    let body = Body::from_stream(ReaderStream::new(file));
    let mut resp = Response::new(body);
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(
            &stream_info.mime_type.unwrap_or_else(|| "video/mp4".to_string()),
        )
        .unwrap_or_else(|_| HeaderValue::from_static("video/mp4")),
    );
    resp.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&total.to_string()).unwrap(),
    );
    resp.headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    Ok(resp)
}

/// Parse a `bytes=start-end` Range header. Returns (start, end) inclusive,
/// clamped to `total`. Supports `bytes=0-1023` and `bytes=0-` (open-ended).
/// Returns None for unparseable values.
fn parse_byte_range(range: &str, total: u64) -> Option<(u64, u64)> {
    let range = range.strip_prefix("bytes=")?;
    let (start_str, end_str) = range.split_once('-')?;
    let start: u64 = start_str.parse().ok()?;
    let end: u64 = if end_str.is_empty() {
        total.saturating_sub(1)
    } else {
        end_str.parse().ok()?
    };
    if start > end || start >= total {
        return None;
    }
    Some((start, end.min(total.saturating_sub(1))))
}

// ── Stream instrumentation (M3.5 audit) ──────────────────────────────

/// Wrap a `StreamResponse` body with timing/byte-count instrumentation.
/// The wrapper logs structured fields on first byte (TTFB) and on stream
/// completion (total bytes, elapsed ms, throughput Mbps). All logs land at
/// `info` level and carry the request span (set by axum's `TraceLayer`),
/// so they correlate with `/stream-url` and token-refresh logs.
///
/// Per-chunk overhead: one u64 add, one Option::is_none check. Negligible.
fn instrument_stream_response(
    stream: StreamResponse,
    video_id: &str,
    range: Option<&str>,
    start: Instant,
) -> StreamResponse {
    StreamResponse {
        status: stream.status,
        content_type: stream.content_type,
        content_length: stream.content_length,
        content_range: stream.content_range,
        body: Box::pin(InstrumentedStream {
            inner: stream.body,
            video_id: video_id.to_string(),
            range: range.map(|s| s.to_string()),
            start,
            first_byte_at: None,
            bytes_sent: 0,
            span: tracing::Span::current(),
        }),
    }
}

/// A `Stream` wrapper that records timing and byte-count metrics for the
/// M3.5 streaming audit. See `instrument_stream_response` for the public API.
struct InstrumentedStream {
    inner: BodyStream,
    video_id: String,
    range: Option<String>,
    start: Instant,
    first_byte_at: Option<Instant>,
    bytes_sent: u64,
    /// Captured at construction so body-level logs (which poll after the
    /// handler has returned) still carry the request span context.
    span: Span,
}

impl Stream for InstrumentedStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        // InstrumentedStream is Unpin (all fields are Unpin: BodyStream is
        // Pin<Box<...>>, others are plain owned types).
        let this = self.get_mut();
        let result = this.inner.as_mut().poll_next(cx);
        match result {
            Poll::Ready(Some(Ok(chunk))) => {
                if this.first_byte_at.is_none() {
                    let now = Instant::now();
                    this.first_byte_at = Some(now);
                    let ttfb_ms = now.duration_since(this.start).as_millis();
                    let _guard = this.span.enter();
                    tracing::info!(
                        video_id = %this.video_id,
                        ttfb_ms = ttfb_ms as u64,
                        range = ?this.range,
                        "stream first byte"
                    );
                }
                this.bytes_sent += chunk.len() as u64;
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(None) => {
                let elapsed = this.start.elapsed();
                let elapsed_ms = elapsed.as_millis();
                let throughput_mbps = if elapsed.as_secs_f64() > 0.0 {
                    (this.bytes_sent as f64 * 8.0) / (elapsed.as_secs_f64() * 1_000_000.0)
                } else {
                    0.0
                };
                let _guard = this.span.enter();
                tracing::info!(
                    video_id = %this.video_id,
                    total_bytes = this.bytes_sent,
                    elapsed_ms = elapsed_ms as u64,
                    throughput_mbps = %format!("{:.2}", throughput_mbps),
                    range = ?this.range,
                    "stream complete"
                );
                Poll::Ready(None)
            }
            Poll::Ready(Some(Err(e))) => {
                let _guard = this.span.enter();
                tracing::warn!(
                    video_id = %this.video_id,
                    error = %e,
                    "stream body error"
                );
                Poll::Ready(Some(Err(e)))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Convert a `StreamResponse` into an axum `Response`, setting status code,
/// `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges: bytes`,
/// and optionally `Content-Disposition` headers. The streaming body is
/// forwarded directly via `Body::from_stream`.
fn stream_to_response(stream: StreamResponse, content_disposition: Option<&str>) -> Response {
    let status = StatusCode::from_u16(stream.status).unwrap_or(StatusCode::OK);
    let mut resp = Response::new(Body::from_stream(stream.body));
    *resp.status_mut() = status;
    if let Ok(val) = stream.content_type.parse() {
        resp.headers_mut().insert(header::CONTENT_TYPE, val);
    }
    if let Some(len) = stream.content_length {
        if let Ok(val) = HeaderValue::from_str(&len.to_string()) {
            resp.headers_mut().insert(header::CONTENT_LENGTH, val);
        }
    }
    if let Some(range) = stream.content_range {
        if let Ok(val) = HeaderValue::from_str(&range) {
            resp.headers_mut().insert(header::CONTENT_RANGE, val);
        }
    }
    resp.headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Some(disposition) = content_disposition {
        if let Ok(val) = HeaderValue::from_str(disposition) {
            resp.headers_mut().insert(header::CONTENT_DISPOSITION, val);
        }
    }
    resp
}

/// Build a `Content-Disposition: attachment` header value with both
/// `filename="..."` (ASCII fallback) and `filename*=UTF-8''...` (RFC 5987
/// percent-encoded) forms, so non-ASCII filenames work across browsers.
fn build_content_disposition(filename: &str) -> String {
    let sanitized = filename.replace('"', "\\\"");
    let encoded = percent_encode(filename);
    format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        sanitized, encoded
    )
}

/// RFC 3986 percent-encoding for the `filename*` parameter. Unreserved
/// characters (A-Z a-z 0-9 - _ . ~) pass through; everything else is
/// `%XX`-encoded.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ── Subtitle list + serving (T6) ──────────────────────────────────────

/// `GET /api/videos/{id}/subtitles` — list detected subtitle tracks for a
/// video (FR-6.1).
pub async fn list_subtitles(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<SubtitleTrack>>> {
    let repo = state.catalog_repository();
    if !repo.video_exists(&id).await? {
        return Err(ApiError::NotFound);
    }
    let tracks = repo.fetch_subtitles(&id).await?;
    Ok(Json(tracks))
}

/// `GET /api/videos/{id}/subtitles/{track_id}` — serve a subtitle track,
/// routing by `format_family` + `format` instead of a single `if format ==
/// "srt"` branch (M8 Task 003).
///
/// **Fetch path** branches on `extracted_path`:
/// - `Some(path)` → extracted-embedded track. Read bytes from disk; no
///   provider round-trip. A missing file (cache cleared out of band) → 404.
/// - `None` → sidecar track. Fetch via the provider pipeline with 401-refresh
///   retry (same as M3).
///
/// **Format rule** (applied identically to both paths — the extraction path
/// is transparent to the conversion):
/// - `srt` → convert to WebVTT, `Content-Type: text/vtt` (FR-6.3).
/// - `vtt` → serve as-is, `Content-Type: text/vtt`.
/// - `ass`/`ssa` → serve raw, `Content-Type: text/plain` (libass.js in Task
///   004 consumes the raw ASS source — the browser must not re-interpret it
///   as WebVTT).
pub async fn get_subtitle_track(
    State(state): State<AppState>,
    Path((id, track_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let repo = state.catalog_repository();
    let (track, connection_id, provider_file_id, extracted_path) = repo
        .fetch_subtitle_track(&id, &track_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    // GOTCHA: extracted tracks have NULL provider_file_id — never call the
    // provider fetch path for them. The branch below is the only thing
    // preventing a NULL-deref into the provider pipeline; extracting it
    // without preserving the `extracted_path` check would 500 every
    // extracted-text request.
    let bytes = if let Some(path) = extracted_path.as_deref() {
        match tokio::fs::read(path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::warn!(track_id = %track.id, %path, "extracted subtitle file missing");
                return Err(ApiError::NotFound);
            }
            Err(e) => return Err(ApiError::Internal(e.into())),
        }
    } else {
        let connection_id = connection_id.as_deref().ok_or(ApiError::NotFound)?;
        let provider_file_id = provider_file_id.as_deref().ok_or(ApiError::NotFound)?;
        fetch_subtitle_content_with_refresh(&state, connection_id, provider_file_id).await?
    };

    let content = render_subtitle(&track.format, &bytes);
    let content_type = subtitle_content_type(&track.format);

    let mut resp = Response::new(Body::from(content));
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    Ok(resp)
}

/// Render subtitle bytes for serving. SRT is converted to WebVTT (FR-6.3);
/// every other format is passed through raw — ASS/SSA styling is consumed
/// client-side by libass.js (Task 004), and VTT needs no conversion.
fn render_subtitle(format: &str, bytes: &[u8]) -> String {
    if format == "srt" {
        srt_to_vtt(&String::from_utf8_lossy(bytes))
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Content-Type for a served subtitle, keyed by `format`. SRT is served as
/// VTT (post-conversion); ASS/SSA is served as `text/plain` so the browser
/// doesn't try to parse it as WebVTT — libass.js reads the raw source.
fn subtitle_content_type(format: &str) -> &'static str {
    match format {
        "ass" | "ssa" => "text/plain",
        _ => "text/vtt",
    }
}

/// Resolve connection → token → factory, then call
/// `provider.fetch_subtitle_content(file_id)` with a single token-refresh
/// retry on 401. Mirrors `open_stream_with_refresh`.
async fn fetch_subtitle_content_with_refresh(
    state: &AppState,
    connection_id: &str,
    provider_file_id: &str,
) -> ApiResult<Vec<u8>> {
    let repo = state.catalog_repository();

    let conn = repo
        .fetch_connection(connection_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let bundle = repo
        .fetch_token_bundle(connection_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let factory = state
        .factory_for(conn.provider)
        .ok_or_else(|| ApiError::ServiceUnavailable(format!("{} not configured", conn.provider)))?;

    let provider = factory.create(&bundle).await.map_err(ApiError::Provider)?;
    match provider.fetch_subtitle_content(provider_file_id).await {
        Ok(bytes) => Ok(bytes),
        Err(ProviderError::Unauthorized) => {
            tracing::info!(
                connection_id = connection_id,
                "token expired, refreshing for subtitle"
            );
            let new_bundle = factory
                .refresh_token(&bundle)
                .await
                .map_err(|e| map_refresh_error(e, connection_id, conn.provider))?;
            repo.update_token_bundle(connection_id, &new_bundle)
                .await
                .map_err(|e| ApiError::Internal(e.into()))?;
            let provider = factory
                .create(&new_bundle)
                .await
                .map_err(ApiError::Provider)?;
            provider
                .fetch_subtitle_content(provider_file_id)
                .await
                .map_err(|e| map_post_refresh_error(e, connection_id, conn.provider))
        }
        Err(e) => Err(map_stream_error(e)),
    }
}

/// Convert SRT subtitle content to WebVTT format. Replaces `,` with `.` in
/// timestamp lines (lines containing `-->`) and prepends the `WEBVTT` header
/// (FR-6.3).
fn srt_to_vtt(srt: &str) -> String {
    let mut result = String::from("WEBVTT\n\n");
    for line in srt.lines() {
        if line.contains("-->") {
            result.push_str(&line.replace(',', "."));
        } else {
            result.push_str(line);
        }
        result.push('\n');
    }
    result
}

// ── Hot video cache management (M4) ─────────────────────────────────

/// Request body for `POST /api/videos/{id}/cache`.
#[derive(Debug, Deserialize)]
pub struct CacheMutationBody {
    pub pinned: Option<bool>,
}

/// Response for cache mutation routes.
#[derive(Debug, Serialize)]
pub struct CacheMutationResponse {
    pub video_id: String,
    pub pinned: bool,
    pub cached: bool,
}

/// `POST /api/videos/{id}/cache` — toggle the pin state of a cached video.
/// Pinned entries survive LRU eviction. Returns 404 if the video isn't
/// currently cached (can't pin what isn't there). Requires CSRF.
pub async fn set_cache_pinned(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CacheMutationBody>,
) -> ApiResult<Json<CacheMutationResponse>> {
    let repo = state.catalog_repository();
    let pinned = body.pinned.unwrap_or(true);
    let updated = repo.set_video_cache_pinned(&id, pinned).await?;
    if !updated {
        return Err(ApiError::NotFound);
    }
    Ok(Json(CacheMutationResponse {
        video_id: id,
        pinned,
        cached: true,
    }))
}

/// `DELETE /api/videos/{id}/cache` — remove a video from the cache
/// immediately. Deletes both the manifest row and the bytes on disk.
/// Pinned entries can be deleted (explicit user action overrides pin).
/// Requires CSRF.
pub async fn delete_cache_entry(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<CacheMutationResponse>> {
    let repo = state.catalog_repository();
    repo.delete_video_cache_entry(&id).await?;
    if let Some(cache) = state.video_cache() {
        let _ = cache.delete(&id).await;
    }
    Ok(Json(CacheMutationResponse {
        video_id: id,
        pinned: false,
        cached: false,
    }))
}

/// `GET /api/admin/cache` — cache stats: total size, entry count, pinned
/// count, configured limit, top entries by size. Auth required, no CSRF.
#[derive(Debug, Serialize)]
pub struct CacheAdminResponse {
    pub enabled: bool,
    pub total_size_bytes: i64,
    pub entry_count: i64,
    pub pinned_count: i64,
    pub max_bytes: u64,
    pub top_entries: Vec<CacheEntryDto>,
}

#[derive(Debug, Serialize)]
pub struct CacheEntryDto {
    pub video_id: String,
    pub size_bytes: i64,
    pub last_accessed_at: String,
    pub pinned: bool,
}pub async fn get_cache_admin(
    State(state): State<AppState>,
) -> ApiResult<Json<CacheAdminResponse>> {
    let repo = state.catalog_repository();
    let Some(_cache) = state.video_cache() else {
        return Ok(Json(CacheAdminResponse {
            enabled: false,
            total_size_bytes: 0,
            entry_count: 0,
            pinned_count: 0,
            max_bytes: state.config().video_cache.max_bytes,
            top_entries: vec![],
        }));
    };

    let total = repo.video_cache_total_size().await?;
    let count = repo.video_cache_entry_count().await?;
    let pinned = repo.video_cache_pinned_count().await?;
    let top = repo
        .video_cache_top_entries(10)
        .await?
        .into_iter()
        .map(|e| CacheEntryDto {
            video_id: e.video_id,
            size_bytes: e.size_bytes,
            last_accessed_at: e.last_accessed_at,
            pinned: e.pinned,
        })
        .collect();

    Ok(Json(CacheAdminResponse {
        enabled: true,
        total_size_bytes: total,
        entry_count: count,
        pinned_count: pinned,
        max_bytes: state.config().video_cache.max_bytes,
        top_entries: top,
    }))
}

/// `GET /api/admin/transcode` — per-rung transcode stats: how many
/// variants cached/in-progress/failed at each rung, plus the dedup
/// registry size. Auth required, no CSRF.
#[derive(Debug, Serialize)]
pub struct TranscodeAdminResponse {
    pub enabled: bool,
    pub variants: Vec<castify_catalog::TranscodeRungStats>,
    pub pool: TranscodePoolStats,
    pub max_bytes: u64,
    pub configured_ladder: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct TranscodePoolStats {
    /// Count of currently-registered in-memory transcode handles
    /// (`OnceLock<Mutex<HashMap>>` size). Each represents a running or
    /// recently-finished ffmpeg process.
    pub active_workers: u64,
}

pub async fn get_transcode_admin(
    State(state): State<AppState>,
) -> ApiResult<Json<TranscodeAdminResponse>> {
    if !state.config().transcode.enabled {
        return Ok(Json(TranscodeAdminResponse {
            enabled: false,
            variants: vec![],
            pool: TranscodePoolStats { active_workers: 0 },
            max_bytes: state.config().transcode.cache_max_bytes,
            configured_ladder: state
                .config()
                .abr
                .ladder
                .iter()
                .map(|r| r.name.to_string())
                .collect(),
        }));
    }
    let variants = state.catalog_repository().transcode_stats_per_rung().await?;
    let active = transcode_registry().lock().await.len() as u64;
    Ok(Json(TranscodeAdminResponse {
        enabled: true,
        variants,
        pool: TranscodePoolStats {
            active_workers: active,
        },
        max_bytes: state.config().transcode.cache_max_bytes,
        configured_ladder: state
            .config()
            .abr
            .ladder
            .iter()
            .map(|r| r.name.to_string())
            .collect(),
    }))
}

/// Evict unpinned entries until under `target_bytes`. Called after each
/// cache write (via `cache_write_task`) and from a periodic background
/// sweep. Returns the count of entries evicted.
#[allow(dead_code)]
pub async fn evict_to_target(
    state: &AppState,
    target_bytes: i64,
) -> Result<u64, anyhow::Error> {
    let repo = state.catalog_repository();
    let Some(cache) = state.video_cache() else {
        return Ok(0);
    };

    let current = repo.video_cache_total_size().await?;
    if current <= target_bytes {
        return Ok(0);
    }
    let to_evict = current - target_bytes;
    let candidates = repo.video_cache_eviction_candidates(to_evict).await?;

    let mut evicted = 0u64;
    for (video_id, _size) in candidates {
        repo.delete_video_cache_entry(&video_id).await?;
        let _ = cache.delete(&video_id).await;
        evicted += 1;
    }
    if evicted > 0 {
        tracing::info!(evicted, target_bytes, "LRU eviction complete");
    }
    Ok(evicted)
}

/// Evict completed transcode variants until the total approximated cache
/// size is at or below `target_bytes`. Walks
/// `fetch_transcode_eviction_candidates()` (already ordered oldest-first
/// by `last_accessed_at`) and deletes each manifest row + its on-disk
/// `output_dir`. Skips `pending`/`in_progress` entries (the SQL filter
/// guarantees this). Returns the count of variants evicted.
///
/// **M7 T9.** Called by the periodic background sweep spawned in
/// `main.rs`. Also available to admin tooling via `POST /api/admin/...`
/// (T8 surfaced stats; a dedicated trigger endpoint can be added later).
pub async fn evict_transcode_to_target(
    state: &AppState,
    target_bytes: u64,
) -> Result<u64, anyhow::Error> {
    let repo = state.catalog_repository().clone();
    let candidates = repo.fetch_transcode_eviction_candidates().await?;

    // Approximate current total: sum of bytes for all completed entries.
    let mut current: u64 = candidates.iter().map(|(_, bytes)| *bytes as u64).sum();
    if current <= target_bytes {
        return Ok(0);
    }

    let mut evicted = 0u64;
    for (entry, approx_bytes) in candidates {
        if current <= target_bytes {
            break;
        }
        // Delete the manifest row, then the on-disk segments.
        if let Err(e) = repo
            .delete_transcode_entry(&entry.video_id, &entry.variant, &entry.profile)
            .await
        {
            tracing::warn!(
                error = %e,
                video_id = %entry.video_id,
                variant = %entry.variant,
                "transcode eviction: manifest delete failed"
            );
            continue;
        }
        let dir = std::path::PathBuf::from(&entry.output_dir);
        if let Err(e) = tokio::fs::remove_dir_all(&dir).await {
            // Don't fail the sweep on a missing/unreadable dir — the row is
            // already gone, which is the durable state we care about.
            tracing::debug!(
                error = %e,
                dir = %dir.display(),
                "transcode eviction: output_dir removal failed (already gone?)"
            );
        }
        current = current.saturating_sub(approx_bytes as u64);
        evicted += 1;
    }
    if evicted > 0 {
        tracing::info!(evicted, target_bytes, remaining_bytes = current, "transcode LRU sweep complete");
    }
    Ok(evicted)
}

/// Background sweep loop. Runs forever, sleeping `interval` between
/// passes. Designed to be spawned via `tokio::spawn` from `main.rs`.
pub async fn transcode_sweep_loop(state: AppState, interval: std::time::Duration) {
    tracing::info!(?interval, "transcode LRU sweep task started");
    loop {
        tokio::time::sleep(interval).await;
        let target = state.config().transcode.cache_max_bytes;
        match evict_transcode_to_target(&state, target).await {
            Ok(n) if n > 0 => {
                tracing::info!(evicted = n, target_bytes = target, "transcode sweep evicted variants");
            }
            Ok(_) => {} // No work; avoid log spam.
            Err(e) => {
                tracing::warn!(error = %e, "transcode sweep iteration failed");
            }
        }
    }
}

// ── HLS transcode endpoints (M6) ────────────────────────────────────

/// `GET /api/videos/{id}/transcode/master.m3u8` — HLS master playlist.
/// If no transcode exists yet, kicks off a default-variant transcode and
/// returns the master playlist once the first segment is ready.
///
/// **M7:** the playlist is regenerated per request from
/// `transcode_cache_entries` rows — it grows as on-demand variants land.
/// The pre-compute variant is selected from the video's source height per
/// PRD FR-1.4 / `select_precompute_variant`.
///
/// **M8 Task 009:** `?burn_subtitles=<track_id>` selects the burned
/// variant. The track must exist (else 404) and be `format_family = "image"`
/// (text-family → 400; text subtitles are served to the browser, not
/// burned). The handler ensures a burned transcode variant is started
/// (Task 007 keying + Task 008 ffmpeg) and the returned master lists the
/// burned variant. Without the param, the master is unchanged from M7
/// (unburned variants only). Burned and unburned variants coexist in the
/// cache as independent rows; the master filters by profile so hls.js
/// never crosses streams mid-playback (FR-3.1, FR-3.2, FR-3.6, FR-7.3).
///
/// Auth required, no CSRF (safe GET).
pub async fn get_transcode_master(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(burn): Query<BurnSubtitlesQuery>,
) -> ApiResult<Response> {
    if !state.config().transcode.enabled {
        return Err(ApiError::NotFound);
    }

    let stream_info = resolve_stream_info(&state, &id).await?;

    // M8 Task 009: resolve the burn dimension. When `?burn_subtitles=<id>`
    // is present, validate the track exists and is image-family — only
    // image subtitles (PGS/VobSub) burn; text subtitles (SRT/VTT/ASS) are
    // served to the browser (FR-3.1). A nonexistent track id → 404; a
    // text-family track id → 400.
    let subtitle_track_id = burn.track_id();
    if let Some(track_id) = subtitle_track_id {
        let track = state
            .catalog_repository()
            .fetch_embedded_subtitle_track(&id, track_id)
            .await?
            .ok_or(ApiError::NotFound)?;
        if track.format_family != "image" {
            return Err(ApiError::Validation {
                detail: format!(
                    "subtitle track {track_id} has format_family `{}`; \
                     only image-family tracks can be burned",
                    track.format_family
                ),
            });
        }
    }

    // Pick the pre-compute variant: best rung ≤ min(source_height, cap).
    let source_height = fetch_video_height(&state, &id).await;
    let precompute = castify_core::select_precompute_variant(
        source_height,
        &state.config().abr.ladder,
        &state.config().abr.precompute_cap,
    );

    // Ensure a transcode worker is running for the pre-compute variant.
    // The burn dimension is threaded through so the burned profile
    // (`DEFAULT_PROFILE+subs-{id}`) routes to its own worker + output dir.
    ensure_transcode_started(&state, &id, &stream_info, precompute.name, subtitle_track_id).await?;

    // Derive the profile for the current path. Burned and unburned variants
    // coexist in `transcode_cache_entries` (FR-7.3); filtering by profile
    // ensures the master lists only the variants matching the current burn
    // dimension — hls.js must not ABR-switch between burned and unburned
    // segments (subtitles would flicker on/off at the switch boundary).
    let profile =
        crate::transcode::burn_profile(crate::transcode::DEFAULT_PROFILE, subtitle_track_id);

    // Build master playlist from the current cache state, filtered to the
    // current profile.
    let entries = state
        .catalog_repository()
        .fetch_transcodes_for_video(&id)
        .await?;
    let entries: Vec<_> = entries
        .into_iter()
        .filter(|e| e.profile == profile)
        .collect();

    let master = if entries.is_empty() {
        // Manifest insert failed inside ensure_transcode_started but the
        // transcode itself started. Fall back to a single-variant playlist
        // pointing at the pre-compute variant so the client can still try.
        tracing::warn!(video_id = %id, "no manifest rows; falling back to default-variant master");
        let fallback_rung = castify_core::lookup_rung(precompute.name);
        crate::transcode::build_master_playlist(&[castify_catalog::TranscodeCacheEntry {
            video_id: id.clone(),
            variant: precompute.name.into(),
            profile,
            output_dir: String::new(),
            total_segments: None,
            completed_segments: 0,
            segment_duration_secs: state.config().transcode.segment_duration_secs as i64,
            bitrate: fallback_rung.map(|r| (r.target_bitrate_kbps as i64) * 1000),
            width: fallback_rung.map(|r| (r.target_height as i64) * 16 / 9),
            height: fallback_rung.map(|r| r.target_height as i64),
            status: "pending".into(),
            last_error: None,
            created_at: String::new(),
            last_accessed_at: String::new(),
        }])
    } else {
        crate::transcode::build_master_playlist(&entries)
    };

    let mut resp = Response::new(Body::from(master));
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.apple.mpegurl"),
    );
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
    Ok(resp)
}

/// Fetch the source video height (from scan-time metadata, not the M5
/// probe). Returns `None` if the video is missing or the column is NULL.
/// Used by `get_transcode_master` to pick the pre-compute variant.
async fn fetch_video_height(state: &AppState, video_id: &str) -> Option<u32> {
    use sqlx::Row;
    let row = sqlx::query(r#"SELECT height FROM videos WHERE id = ?"#)
        .bind(video_id)
        .fetch_optional(state.pool())
        .await
        .ok()??;
    let height: Option<i64> = row.get("height");
    height
        .filter(|h| *h > 0)
        .map(|h| h as u32)
}

/// Optional `?burn_subtitles=<track_id>` query parameter accepted by the
/// transcode playlist + segment endpoints. When present, the handler
/// derives a burned profile (`DEFAULT_PROFILE+subs-{id}`) so the request
/// resolves to the burned cache row + output directory. When absent or
/// empty, behavior is unchanged from M7 (unburned).
///
/// Task 009 wires the same parameter at the master-playlist level with
/// format-family validation; this struct carries the dimension through
/// the variant/segment handlers without policy (the track's existence and
/// `format_family` are validated upstream by Task 009's master handler).
#[derive(Debug, Default, Deserialize)]
pub struct BurnSubtitlesQuery {
    pub burn_subtitles: Option<String>,
}

impl BurnSubtitlesQuery {
    /// Return the burn dimension as a non-empty `&str`, or `None`. Treats
    /// an empty string (`?burn_subtitles=`) as "no burn" so a malformed
    /// URL doesn't synthesize a `+subs-` profile suffix.
    fn track_id(&self) -> Option<&str> {
        self.burn_subtitles.as_deref().filter(|s| !s.is_empty())
    }
}

/// `GET /api/videos/{id}/transcode/{variant}/playlist.m3u8` — variant HLS
/// playlist. Lists segments that are ready.
///
/// **M7 on-demand semantics:**
/// - If the variant has a manifest row in `failed` state: return 503 with
///   the last error message.
/// - If the variant has a manifest row in `pending`/`in_progress`/`completed`:
///   try to read the playlist file. Return 200 if present, otherwise 404 +
///   `Retry-After: 3` (segments still generating).
/// - If no manifest row: kick off an on-demand transcode via
///   `ensure_transcode_started`, then return 404 + `Retry-After: 3`. hls.js
///   retries per its ABR logic; the next request finds the playlist once the
///   first segment lands.
///
/// **M8 Task 007:** `?burn_subtitles=<track_id>` selects the burned variant
/// — the derived profile (`DEFAULT_PROFILE+subs-{id}`) routes to a distinct
/// cache row and output directory. Without the param, the unburned M7 path
/// is unchanged.
pub async fn get_transcode_playlist(
    State(state): State<AppState>,
    Path((id, variant)): Path<(String, String)>,
    Query(burn): Query<BurnSubtitlesQuery>,
) -> ApiResult<Response> {
    if !state.config().transcode.enabled {
        return Err(ApiError::NotFound);
    }

    let subtitle_track_id = burn.track_id();
    let profile = crate::transcode::burn_profile(crate::transcode::DEFAULT_PROFILE, subtitle_track_id);

    let repo = state.catalog_repository();
    let entry = repo.fetch_transcode_entry(&id, &variant, &profile).await?;

    // Failed variant → 503 with the last error.
    if let Some(e) = entry.as_ref() {
        if e.status == castify_catalog::TRANSCODE_STATUS_FAILED {
            let msg = e
                .last_error
                .clone()
                .unwrap_or_else(|| "transcode failed".to_string());
            return Err(ApiError::ServiceUnavailable(msg));
        }
    }

    // For variants with a row (pending/in_progress/completed) or after
    // kicking off an on-demand transcode, try to read the playlist file.
    if entry.is_none() {
        // No manifest row → on-demand generation. Kick off the transcode
        // (no-op if already running) and fall through to the playlist read.
        // If the playlist file isn't there yet, we'll return 404 below.
        let stream_info = resolve_stream_info(&state, &id).await?;
        ensure_transcode_started(&state, &id, &stream_info, &variant, subtitle_track_id).await?;
    }

    let dir = transcode_output_dir(&state, &id, &variant, &profile);
    if let Some(playlist_content) = crate::transcode::read_playlist(&dir).await {
        let mut resp = Response::new(Body::from(playlist_content));
        *resp.status_mut() = StatusCode::OK;
        resp.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/vnd.apple.mpegurl"),
        );
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-store, must-revalidate"),
        );
        Ok(resp)
    } else {
        // Playlist not ready yet. hls.js retries per its ABR logic.
        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = StatusCode::NOT_FOUND;
        resp.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("3"));
        Ok(resp)
    }
}

/// `GET /api/videos/{id}/transcode/{variant}/{segment}` — serve a .ts
/// segment file from disk. Returns 404 if segment not ready yet (client
/// retries per hls.js logic).
///
/// **M8 Task 007:** `?burn_subtitles=<track_id>` selects the burned
/// variant's segments — the derived profile routes to the burned output
/// directory and touches the burned manifest row.
pub async fn get_transcode_segment(
    State(state): State<AppState>,
    Path((id, variant, segment)): Path<(String, String, String)>,
    Query(burn): Query<BurnSubtitlesQuery>,
) -> ApiResult<Response> {
    if !state.config().transcode.enabled {
        return Err(ApiError::NotFound);
    }

    // Validate segment filename (prevent path traversal).
    if segment.contains('/') || segment.contains('\\') || !segment.ends_with(".ts") {
        return Err(ApiError::NotFound);
    }

    let subtitle_track_id = burn.track_id();
    let profile = crate::transcode::burn_profile(crate::transcode::DEFAULT_PROFILE, subtitle_track_id);

    let dir = transcode_output_dir(&state, &id, &variant, &profile);
    let segment_path = dir.join(&segment);

    match tokio::fs::read(&segment_path).await {
        Ok(bytes) => {
            // Best-effort manifest touch — bump `last_accessed_at` for LRU.
            // Don't fail the request if the DB write fails; the segment is
            // already in hand.
            let _ = state
                .catalog_repository()
                .touch_transcode(&id, &variant, &profile)
                .await;

            let mut resp = Response::new(Body::from(bytes));
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("video/mp2t"),
            );
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=86400"),
            );
            Ok(resp)
        }
        Err(_) => Err(ApiError::NotFound),
    }
}

/// Build the output directory path for a (video_id, variant, profile)
/// transcode. The profile is the third path component so burned and
/// unburned transcodes of the same variant land in separate directories
/// (the profile suffix `+subs-{track_id}` is what disambiguates them —
/// see [`crate::transcode::burn_profile`]).
fn transcode_output_dir(
    state: &AppState,
    video_id: &str,
    variant: &str,
    profile: &str,
) -> std::path::PathBuf {
    state
        .config()
        .transcode
        .dir
        .join(video_id)
        .join(variant)
        .join(profile)
}

/// Process-level registry of active transcodes. Keyed by
/// `{video_id}:{variant}`. Each entry holds the `TranscodeHandle` so
/// concurrent requests share one ffmpeg process. Shared between
/// `ensure_transcode_started` (insert) and `cancel_transcode` (remove + kill).
static TRANSCODE_REGISTRY: std::sync::OnceLock<
    tokio::sync::Mutex<std::collections::HashMap<String, Arc<crate::transcode::TranscodeHandle>>>,
> = std::sync::OnceLock::new();

fn transcode_registry(
) -> &'static tokio::sync::Mutex<std::collections::HashMap<String, Arc<crate::transcode::TranscodeHandle>>>
{
    TRANSCODE_REGISTRY.get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Ensure a transcode worker is running for the given video + variant.
/// If a worker is already running or completed, this is a no-op.
/// Uses [`TRANSCODE_REGISTRY`] to deduplicate concurrent requests.
///
/// **M7 manifest wiring:** on start, writes a `pending` row to
/// `transcode_cache_entries`; a spawned watcher task updates the row to
/// `in_progress` → `completed`/`failed` as ffmpeg runs. On resume (segments
/// exist but no in-memory handle), seeds a `completed` row if missing.
///
/// **M8 Task 007 burn keying:** `subtitle_track_id` carries the burn
/// dimension. When `Some`, the profile becomes `DEFAULT_PROFILE+subs-{id}`
/// via [`crate::transcode::burn_profile`], the registry key gains the
/// derived profile as a third component, and all repo calls
/// (`fetch_transcode_entry`, `insert_pending_transcode`, `touch_transcode`,
/// …) use the derived profile.
///
/// **M8 Task 008 burn invocation:** when `subtitle_track_id` is `Some`,
/// the track is looked up (`fetch_embedded_subtitle_track`) to resolve the
/// ffmpeg stream index, a seekable local source is resolved
/// (`resolve_local_source`), and [`crate::transcode::start_transcode`] is
/// called with a [`crate::transcode::BurnSpec`] — ffmpeg reads from the
/// local file (not stdin) and applies a `subtitles=` filter. The
/// local-source guard is moved into the manifest-watcher task so the
/// tempfile survives for ffmpeg's lifetime. When `subtitle_track_id` is
/// `None`, the stdin pipeline runs unchanged.
async fn ensure_transcode_started(
    state: &AppState,
    video_id: &str,
    stream_info: &VideoStreamInfo,
    variant: &str,
    subtitle_track_id: Option<&str>,
) -> ApiResult<()> {
    let registry = transcode_registry();

    let key = crate::transcode::transcode_registry_key(video_id, variant, subtitle_track_id);
    let profile = crate::transcode::burn_profile(crate::transcode::DEFAULT_PROFILE, subtitle_track_id);
    let repo = state.catalog_repository().clone();

    let mut guard = registry.lock().await;

    // Check if already running or completed.
    if let Some(handle) = guard.get(&key) {
        if !handle.state.is_done() {
            return Ok(()); // Worker still running — nothing to do.
        }
        if handle.state.completed.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(()); // Completed successfully — segments on disk.
        }
        // Failed — fall through to retry.
        tracing::info!(%key, "previous transcode failed; retrying");
    }

    // Check if segments already exist on disk (completed transcode from
    // a previous server session, or M6→M7 migration where the manifest
    // wasn't wired yet).
    let output_dir = transcode_output_dir(state, video_id, variant, &profile);
    let existing_segments =
        crate::transcode::count_segments(&output_dir).await;
    if existing_segments > 0 {
        if let Some(handle) = guard.get(&key) {
            if handle.state.completed.load(std::sync::atomic::Ordering::Relaxed) {
                return Ok(());
            }
        }
        // Segments exist but no completed handle. Seed a completed manifest
        // row if missing — the resume case. Bitrate/width/height unknown
        // for M6-era segments; left NULL (admin/eviction treat NULL as 0).
        tracing::info!(%key, segments = existing_segments, "found existing transcode segments");
        let entry = NewTranscodeEntry {
            video_id,
            variant,
            profile: &profile,
            output_dir: &output_dir.to_string_lossy(),
            segment_duration_secs: state.config().transcode.segment_duration_secs,
            bitrate: None,
            width: None,
            height: None,
        };
        if let Err(e) = repo
            .seed_completed_transcode_if_missing(&entry, existing_segments)
            .await
        {
            tracing::warn!(error = %e, %key, "failed to seed completed manifest row");
        }
        return Ok(());
    }

    // Start a new transcode.
    tracing::info!(%key, "starting transcode");

    // Write the pending manifest row before ffmpeg starts so admin/eviction
    // can see the in-flight job even before the first segment lands.
    let entry = NewTranscodeEntry {
        video_id,
        variant,
        profile: &profile,
        output_dir: &output_dir.to_string_lossy(),
        segment_duration_secs: state.config().transcode.segment_duration_secs,
        bitrate: crate::transcode::variant_target_bitrate(variant),
        width: crate::transcode::variant_target_width(variant),
        height: crate::transcode::variant_target_height(variant),
    };
    if let Err(e) = repo.insert_pending_transcode(&entry).await {
        tracing::warn!(error = %e, %key, "failed to insert pending manifest row");
    }

    let segment_duration_secs = state.config().transcode.segment_duration_secs;

    // Branch: burn-in reads from a seekable local file (so ffmpeg's
    // `subtitles=` filter can demux the subtitle stream); the unburned path
    // pipes the provider stream to ffmpeg stdin as before.
    //
    // The local-source guard (for a Tempfile source) is held for the
    // transcode's lifetime by moving it into the manifest-watcher task —
    // when ffmpeg exits and the watcher ends, the guard drops and the
    // tempfile is cleaned up. A Cached source is left untouched (M4 owns it).
    let (handle, local_source_guard): (
        Arc<crate::transcode::TranscodeHandle>,
        Option<crate::local_source::LocalSource>,
    ) = if let Some(track_id) = subtitle_track_id {
        // ── Burn-in path (M8 Task 008) ──
        let track = repo
            .fetch_embedded_subtitle_track(video_id, track_id)
            .await?
            .ok_or_else(|| {
                ApiError::Internal(anyhow::anyhow!(
                    "burn-in: subtitle track {track_id} not found for video {video_id}"
                ))
            })?;

        tracing::info!(
            %key,
            track_id,
            embedded_index = track.embedded_index,
            codec = %track.codec,
            "burn-in: resolved subtitle track",
        );

        let local_source = crate::local_source::resolve_local_source(state, video_id).await?;
        let spec = crate::transcode::BurnSpec {
            subtitle_track_id: track_id.to_string(),
            embedded_index: track.embedded_index,
            source_path: local_source.path.clone(),
        };

        let h = crate::transcode::start_transcode(
            None,
            output_dir.clone(),
            variant,
            segment_duration_secs,
            Some(spec),
        )
        .await
        .map_err(|e| {
            ApiError::Internal(anyhow::anyhow!("failed to start burn-in transcode: {e}"))
        })?;
        (Arc::new(h), Some(local_source))
    } else {
        // ── Unburned path (M6/M7 stdin pipeline, unchanged) ──
        let stream_response = open_stream_with_refresh(state, stream_info, None).await?;
        let h = crate::transcode::start_transcode(
            Some(stream_response.body),
            output_dir.clone(),
            variant,
            segment_duration_secs,
            None,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("failed to start transcode: {e}")))?;
        (Arc::new(h), None)
    };

    // Spawn a watcher that updates the manifest row as ffmpeg progresses.
    // Best-effort: log failures but don't propagate (the transcode itself
    // is already running; the manifest is secondary). The local-source
    // guard (burn path only) moves into the watcher so it survives until
    // ffmpeg exits — the guard's Drop cleans up a Tempfile source then.
    spawn_transcode_manifest_watcher(
        repo.clone(),
        Arc::clone(&handle),
        video_id.to_string(),
        variant.to_string(),
        profile.clone(),
        output_dir.clone(),
        local_source_guard,
    );

    guard.insert(key, handle);
    Ok(())
}

/// Background task that mirrors a running transcode's progress into the
/// `transcode_cache_entries` manifest. Polls the output directory every
/// second for new segments; on ffmpeg exit, writes the final status.
///
/// Best-effort: all repo writes are logged-and-discarded on failure. The
/// transcode itself doesn't depend on the manifest — only admin/eviction
/// and the master playlist do.
///
/// **M8 Task 008:** `_local_source_guard` holds the burn-in local-source
/// RAII guard for the transcode's lifetime. When ffmpeg exits and this
/// task ends, the guard drops — for a Tempfile source, the source file is
/// deleted (and its `transcode-work/<video_id>/` dir if empty). For a
/// Cached source or `None` (unburned), nothing happens on drop.
fn spawn_transcode_manifest_watcher(
    repo: CatalogRepository,
    handle: Arc<crate::transcode::TranscodeHandle>,
    video_id: String,
    variant: String,
    profile: String,
    output_dir: PathBuf,
    _local_source_guard: Option<crate::local_source::LocalSource>,
) {
    tokio::spawn(async move {
        // Mark in_progress immediately so admin sees the running state.
        let _ = repo
            .mark_transcode_in_progress(&video_id, &variant, &profile)
            .await
            .inspect_err(|e| {
                tracing::warn!(error = %e, %video_id, %variant, "manifest mark_in_progress failed");
            });

        let poll_interval = std::time::Duration::from_secs(1);
        loop {
            let done = handle.state.is_done();
            let segments = crate::transcode::count_segments(&output_dir).await;
            let _ = repo
                .update_transcode_progress(&video_id, &variant, &profile, segments)
                .await
                .inspect_err(|e| {
                    tracing::warn!(error = %e, %video_id, %variant, "manifest update_progress failed");
                });
            if done {
                break;
            }
            tokio::time::sleep(poll_interval).await;
        }

        // Final status from ffmpeg's exit flags.
        let final_segments = crate::transcode::count_segments(&output_dir).await;
        if handle
            .state
            .completed
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            let _ = repo
                .mark_transcode_completed(&video_id, &variant, &profile, final_segments)
                .await
                .inspect_err(|e| {
                    tracing::warn!(error = %e, %video_id, %variant, "manifest mark_completed failed");
                });
        } else {
            let _ = repo
                .mark_transcode_failed(&video_id, &variant, &profile, "ffmpeg exited non-zero")
                .await
                .inspect_err(|e| {
                    tracing::warn!(error = %e, %video_id, %variant, "manifest mark_failed failed");
                });
        }
    });
}

// (M7 T6 removed `wait_for_playlist` — the on-demand playlist endpoint now
// returns 404 + Retry-After immediately when segments aren't ready, letting
// hls.js do the polling per its ABR logic.)

/// `DELETE /api/videos/{id}/transcode` — cancel all active transcodes for
/// a video. Kills the ffmpeg child processes, drops the registry entries,
/// marks the manifest rows `failed` with `last_error = 'cancelled'`.
/// Returns 204 even if nothing was running (idempotent), so the client can
/// retry safely. Auth + CSRF required.
///
/// **M8 Task 007:** the registry key is now `{video_id}:{variant}:{profile}`
/// (the profile component carries the burn dimension). Cancelling all
/// transcodes for a video iterates every matching key and extracts both
/// variant and profile so the correct manifest row is marked failed —
/// burned and unburned variants are cancelled together.
pub async fn cancel_transcode(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if !state.config().transcode.enabled {
        return Err(ApiError::NotFound);
    }

    let registry = transcode_registry();
    let repo = state.catalog_repository().clone();

    // Snapshot of keys to cancel (all variants — burned and unburned — for
    // this video).
    let prefix = format!("{id}:");
    let mut guard = registry.lock().await;
    let keys_to_cancel: Vec<String> = guard
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();

    for key in &keys_to_cancel {
        if let Some(handle) = guard.remove(key) {
            // Try to kill ffmpeg before the watcher claims it.
            let mut child_guard = handle.child.lock().await;
            if let Some(child) = child_guard.as_mut() {
                let _ = child.kill().await;
            }
            drop(child_guard);
        }
        // Mark the manifest row failed for every variant we cancelled.
        // `key` is `{video_id}:{variant}:{profile}` — split into exactly 3
        // parts so variant and profile are extracted correctly (the profile
        // component is what disambiguates burned from unburned rows).
        let mut parts = key.splitn(3, ':');
        let (Some(variant), Some(profile)) = (parts.nth(1), parts.next()) else {
            tracing::warn!(%key, "cancel_transcode: malformed registry key, skipping manifest mark");
            continue;
        };
        if let Err(e) = repo
            .mark_transcode_failed(&id, variant, profile, "cancelled by user")
            .await
        {
            tracing::warn!(error = %e, %key, "failed to mark cancelled manifest row");
        }
    }

    if keys_to_cancel.is_empty() {
        tracing::info!(video_id = %id, "cancel_transcode: no active transcodes");
    } else {
        tracing::info!(
            video_id = %id,
            cancelled = keys_to_cancel.len(),
            "cancel_transcode: stopped transcodes"
        );
    }

    Ok(StatusCode::NO_CONTENT)
}

// ── Probe admin endpoints (M5) ──────────────────────────────────────

/// `GET /api/admin/probe` — probe statistics: how many videos are probed,
/// pending, failed, etc. Auth required, no CSRF (safe GET).
pub async fn get_probe_admin(
    State(state): State<AppState>,
) -> ApiResult<Json<castify_catalog::ProbeStats>> {
    let stats = state.catalog_repository().probe_stats().await?;
    Ok(Json(stats))
}

/// `POST /api/admin/reprobe/{video_id}` — reset a single video's probe
/// status to 'pending' and spawn a new probe. Returns 202 Accepted.
/// Requires CSRF.
pub async fn reprobe_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let repo = state.catalog_repository();
    // Verify video exists.
    if !repo.video_exists(&id).await? {
        return Err(ApiError::NotFound);
    }
    repo.reset_probe_status(&id).await?;
    // Spawn a probe for this video.
    let info = state
        .catalog_repository()
        .fetch_video_stream_info(&id)
        .await?
        .ok_or(ApiError::NotFound)?;
    spawn_lazy_probe(&state, &info);
    Ok(StatusCode::ACCEPTED)
}

/// `POST /api/admin/reprobe-all` — reset all non-probed videos to
/// 'pending' and return 202. The eager post-scan worker picks them up.
/// Requires CSRF.
pub async fn reprobe_all(State(state): State<AppState>) -> ApiResult<Json<serde_json::Value>> {
    let pool = state.pool().clone();
    let result = sqlx::query(
        r#"UPDATE videos SET probe_status = 'pending', probed_at = NULL
           WHERE probe_status NOT IN ('probed', 'pending')"#,
    )
    .execute(&pool)
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;
    Ok(Json(serde_json::json!({
        "reset_count": result.rows_affected(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    /// After a refresh+retry, a residual `ProviderError::Unauthorized` must
    /// promote to `ApiError::ReauthRequired` — surfacing a 502 with the raw
    /// `unauthorized: token may be expired or revoked` message gives the user
    /// no actionable recovery path. The structured 401 lets the frontend's
    /// reconnect UX take over.
    #[test]
    fn map_post_refresh_error_promotes_unauthorized_to_reauth_required() {
        let err = map_post_refresh_error(
            ProviderError::Unauthorized,
            "conn-abc",
            Provider::GoogleDrive,
        );
        match err {
            ApiError::ReauthRequired {
                connection_id,
                provider,
            } => {
                assert_eq!(connection_id, "conn-abc");
                assert_eq!(provider, Provider::GoogleDrive);
            }
            other => panic!("expected ReauthRequired, got {other:?}"),
        }
    }

    /// `ProviderError::ReauthRequired` reaching this mapper (defensive — the
    /// refresh-token call already promotes it via `map_refresh_error`) must
    /// still surface as the structured `ApiError::ReauthRequired` rather than
    /// the generic 502 fallback.
    #[test]
    fn map_post_refresh_error_promotes_explicit_reauth_required() {
        let err = map_post_refresh_error(
            ProviderError::ReauthRequired,
            "conn-xyz",
            Provider::OneDrive,
        );
        assert!(matches!(
            err,
            ApiError::ReauthRequired { connection_id, provider }
            if connection_id == "conn-xyz" && provider == Provider::OneDrive
        ));
    }

    /// `NotFound` after refresh still maps to 404 (the file was deleted
    /// between calls — distinct from auth failure).
    #[test]
    fn map_post_refresh_error_preserves_not_found() {
        let err = map_post_refresh_error(
            ProviderError::NotFound("file-gone".into()),
            "conn-1",
            Provider::Dropbox,
        );
        assert!(matches!(err, ApiError::NotFound));
    }

    /// Other provider errors (network, rate limit, API errors) still surface
    /// as `ApiError::Provider` → 502. Only `Unauthorized` and `ReauthRequired`
    /// get the reauth promotion — everything else is genuinely a provider
    /// problem the user can't fix by reconnecting.
    #[test]
    fn map_post_refresh_error_passes_through_other_provider_errors() {
        let err = map_post_refresh_error(
            ProviderError::Network("conn reset".into()),
            "conn-1",
            Provider::Dropbox,
        );
        match err {
            ApiError::Provider(ProviderError::Network(msg)) => {
                assert_eq!(msg, "conn reset");
            }
            other => panic!("expected Provider(Network), got {other:?}"),
        }
    }

    /// Sanity-check the full status-code mapping the route layer ultimately
    /// serializes — `ReauthRequired` must produce 401 (not 502), so the
    /// frontend's `useStreamUrl` hook detects `code: "reauth_required"` and
    /// renders the reconnect card instead of the generic stream-error card.
    #[tokio::test]
    async fn reauth_required_from_post_refresh_maps_to_401() {
        let err = map_post_refresh_error(
            ProviderError::Unauthorized,
            "conn-abc",
            Provider::GoogleDrive,
        );
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
