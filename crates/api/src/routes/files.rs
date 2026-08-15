//! Non-media file endpoints (M9): download proxy.
//!
//! `GET /api/files/{id}/download` mirrors `videos::get_download` — resolve
//! row → connection → token → factory → `open_stream`, forward with
//! `Content-Disposition: attachment`. No Range passthrough: a download is a
//! whole-file transfer, and resumable downloads are a browser/platform
//! concern, not a catalog concern.

use axum::extract::{Path, State};
use axum::response::Response;
use axum_extra::extract::CookieJar;

use crate::auth::resolve_owner;
use crate::error::{ApiError, ApiResult};
use crate::routes::videos::{
    build_content_disposition, open_stream_with_refresh, stream_to_response,
};
use crate::state::AppState;

/// `GET /api/files/{id}/download` — stream a non-media file from its
/// provider as an attachment (M9 FR-6). 404 unknown/inactive; 502 provider
/// failure (via the shared stream helpers).
pub async fn download(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let _owner = resolve_owner(&state, &jar).await?;

    let info = state
        .catalog_repository()
        .fetch_file_stream_info(&id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let stream_response = open_stream_with_refresh(&state, &info, None).await?;
    let disposition = build_content_disposition(&info.name);
    Ok(stream_to_response(stream_response, Some(&disposition)))
}
