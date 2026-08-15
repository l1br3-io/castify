//! Non-media file endpoints (M9): download proxy.
//!
//! `GET /api/files/{id}/download` mirrors `videos::get_download` — resolve
//! row → connection → token → factory → `open_stream` (Range forwarded, so
//! resumed downloads get 206s instead of silently restarting against the
//! advertised `Accept-Ranges: bytes`), forwarded with
//! `Content-Disposition: attachment` and a forced
//! `application/octet-stream` Content-Type: provider bytes are untrusted,
//! and an attachment must never render same-origin with a provider-chosen
//! MIME type.

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap};
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
    headers: HeaderMap,
) -> ApiResult<Response> {
    let _owner = resolve_owner(&state, &jar).await?;

    let info = state
        .catalog_repository()
        .fetch_file_stream_info(&id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let mut stream_response = open_stream_with_refresh(&state, &info, range.as_deref()).await?;
    // Override, don't forward: the provider MIME describes cloud metadata,
    // not what we serve. An attachment with a provider-chosen `text/html`
    // Content-Type is a same-origin scripting vector.
    stream_response.content_type = "application/octet-stream".to_string();
    let disposition = build_content_disposition(&info.name);
    Ok(stream_to_response(stream_response, Some(&disposition)))
}
