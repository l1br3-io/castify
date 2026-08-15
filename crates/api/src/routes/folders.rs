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

use castify_catalog::FolderNode;

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
