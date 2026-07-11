use axum::extract::{Query, State};
use axum_extra::extract::CookieJar;
use axum::Json;
use serde::Deserialize;

use castify_catalog::{FolderCount, Provider, VideoFilter, VideoPage, VideoSort};

use crate::auth::resolve_owner;
use crate::error::ApiResult;
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
