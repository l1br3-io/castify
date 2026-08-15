//! Folder organizer endpoints (M9): the folder tree + per-folder contents.
//!
//! Both are read-only catalog queries over active connections — no new
//! server writes, per `docs/data-storage-principles.md`. The tree derives
//! from `videos ∪ files` paths at read time (spec FR-4); contents is a
//! mixed, paginated, direct-children listing (spec FR-5).
//!
//! The older `GET /api/videos/folders` (top-level counts for the filter
//! panel) is untouched — different consumer, different shape.

use axum::extract::{Query, State};
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use castify_catalog::{FolderContentsFilter, FolderContentsPage, FolderNode};

use crate::auth::resolve_owner;
use crate::error::ApiResult;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct FolderTreeParams {
    /// Unused today; kept so the hook can invalidate on connection churn
    /// without a shape change.
    #[allow(dead_code)]
    pub refresh: Option<bool>,
}

/// `GET /api/folders/tree` — nested folder tree with cumulative,
/// dedup-aware video counts and raw file counts (M9 FR-4).
pub async fn tree(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(_params): Query<FolderTreeParams>,
) -> ApiResult<Json<Vec<FolderNode>>> {
    let _owner = resolve_owner(&state, &jar).await?;
    let nodes = state.catalog_repository().fetch_folder_tree().await?;
    Ok(Json(nodes))
}

#[derive(Debug, Deserialize)]
pub struct FolderContentsParams {
    /// Folder selector: absent/empty → library root; `"(Unsorted)"` → the
    /// NULL-path bucket; otherwise a folder path like `/Movies`.
    pub path: Option<String>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
    pub provider: Option<String>,
    /// `video` or one of the six file kinds; unknown values are ignored.
    pub kind: Option<String>,
    pub q: Option<String>,
}

/// `GET /api/folders/contents` — mixed, paginated, direct-children listing
/// (M9 FR-5). Default sort: name ascending.
pub async fn contents(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(params): Query<FolderContentsParams>,
) -> ApiResult<Json<FolderContentsPage>> {
    let owner = resolve_owner(&state, &jar).await?;
    let filter = FolderContentsFilter {
        path: params.path.unwrap_or_default(),
        page: params.page.unwrap_or(1),
        limit: params.limit.unwrap_or(50),
        owner_id: owner.id,
        provider: params.provider.filter(|s| !s.is_empty()),
        kind: params.kind.filter(|s| !s.is_empty()),
        q: params.q.filter(|s| !s.is_empty()),
    };
    let page = state
        .catalog_repository()
        .fetch_folder_contents(&filter)
        .await?;
    Ok(Json(page))
}
