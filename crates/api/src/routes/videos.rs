use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use castify_catalog::{Provider, VideoFilter, VideoSort};

use crate::error::ApiResult;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct VideoQueryParams {
    pub page: Option<i64>,
    pub limit: Option<i64>,
    pub provider: Option<String>,
    pub sort: Option<String>,
}

pub async fn list_videos(
    State(state): State<AppState>,
    Query(params): Query<VideoQueryParams>,
) -> ApiResult<Json<castify_catalog::VideoPage>> {
    let filter = VideoFilter {
        page: params.page.unwrap_or(1).max(1),
        limit: params.limit.unwrap_or(50).clamp(1, 200),
        provider: params
            .provider
            .as_deref()
            .and_then(|s| Provider::parse(s).ok()),
        sort: VideoSort::parse(params.sort.as_deref().unwrap_or("date-desc")),
    };

    let page = state.catalog_repository().fetch_video_page(&filter).await?;
    Ok(Json(page))
}
