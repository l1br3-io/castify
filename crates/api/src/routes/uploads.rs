//! `POST /api/uploads` — the streaming upload pass-through
//! (drag-and-drop task 011).
//!
//! Data-storage justification (`docs/data-storage-principles.md`): the
//! bytes are **in flight only** — the route adapts the axum request
//! body straight into the provider's upload stream and never buffers a
//! whole file in memory or writes one to disk (rules 1/3: no at-rest
//! copy, no write amplification). There is no upload-history table:
//! progress and cancel are client state (the XHR queue), and the
//! catalog learns about the file through the connection's existing
//! incremental scan — zero scanner changes.
//!
//! Owner-session-gated with CSRF like every mutation. `Content-Length`
//! is required (browser file uploads always know it; the providers use
//! it for their streaming contracts). On success the connection's scan
//! is kicked in-process, fire-and-forget: the bytes have already
//! landed, so a scan that can't start must not fail the response.

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use axum_extra::extract::CookieJar;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::resolve_owner_id;
use crate::error::{ApiError, ApiResult};
use crate::routes::connections::spawn_scan;
use crate::state::AppState;

/// Query params: where the file lands. `dir` is the provider-folder
/// path as the folder tree shows it (e.g. `/Movies/Sci-fi` — the S3 key
/// prefix or the OAuth path-root), `filename` the leaf name.
#[derive(Debug, Deserialize)]
pub struct UploadParams {
    pub connection_id: String,
    pub dir: Option<String>,
    pub filename: String,
}

/// 201 body — the landed file's provider id (the catalog's next scan
/// resolves it into a row).
#[derive(Debug, Serialize)]
pub struct UploadResponse {
    pub file_id: String,
}

/// `POST /api/uploads?connection_id=&dir=&filename=` — stream one file
/// through to the provider.
///
/// The ladder: no `Content-Length` → 411; a malformed filename or dir →
/// 400; an unknown connection → 404; a provider without upload support →
/// 501; provider failures map through the existing `ApiError::Provider`
/// conventions. Client disconnects abort the provider stream (the body
/// ends, the upload errors, no partial success) — the task 008–010
/// abort paths.
pub async fn upload(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(params): Query<UploadParams>,
    body: Body,
) -> ApiResult<impl IntoResponse> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;

    // Length first — nothing downstream can stream without it.
    let size_bytes = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| {
            ApiError::LengthRequired(
                "Content-Length is required — uploads stream with a known total".into(),
            )
        })?;

    let filename = validate_filename(&params.filename)?;
    let dir = validate_dir(params.dir.as_deref())?;

    let repo = state.catalog_repository();
    let conn = repo
        .fetch_connection(&params.connection_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let credential = repo
        .fetch_credential(&params.connection_id)
        .await?
        .ok_or_else(|| {
            ApiError::ServiceUnavailable(
                "the connection has no stored credential to upload with".into(),
            )
        })?;
    let factory = state
        .factory_for(conn.provider)
        .ok_or_else(|| ApiError::ServiceUnavailable(format!("{} not configured", conn.provider)))?;
    let provider = factory.create(&credential).await?;

    // The seam: axum's request body → the catalog's stream type. Bytes
    // move chunk-by-chunk; a client abort ends the stream and the
    // provider's upload errors out (never a partial success).
    let stream: castify_catalog::BodyStream = Box::pin(
        body.into_data_stream()
            .map(|chunk| chunk.map_err(std::io::Error::other)),
    );
    let result = map_upload_error(provider.upload(&dir, &filename, size_bytes, stream).await)?;

    tracing::info!(
        owner_id = %owner_id,
        connection_id = %params.connection_id,
        file_id = %result.provider_file_id,
        size_bytes,
        "file uploaded to provider"
    );

    // Fire-and-forget scan kick: the response is already committed by
    // the bytes having landed, so a scan that can't start (already
    // scanning) is logged, never surfaced.
    let scan = repo.fetch_scan_state(&params.connection_id).await?;
    let scanning = scan.is_some_and(|s| s.status == castify_catalog::ScanStatus::Scanning);
    if scanning {
        tracing::info!(
            connection_id = %params.connection_id,
            "scan already running; the uploaded file appears on the next scan"
        );
    } else {
        spawn_scan(&state, &params.connection_id, conn.provider);
    }

    Ok((
        StatusCode::CREATED,
        Json(UploadResponse {
            file_id: result.provider_file_id,
        }),
    ))
}

/// The refusal the trait's default upload returns — mapped to a clear
/// 501 instead of a generic provider failure.
fn map_upload_error(
    result: Result<castify_catalog::UploadResult, castify_catalog::ProviderError>,
) -> ApiResult<castify_catalog::UploadResult> {
    match result {
        Err(castify_catalog::ProviderError::Other(message))
            if message.contains("does not support uploads") =>
        {
            Err(ApiError::NotImplemented(
                "this provider does not support uploads".into(),
            ))
        }
        other => other.map_err(ApiError::from),
    }
}

/// Upload filename rules: trimmed, 1..=255 chars, no path separators,
/// no traversal names, no control characters. The leaf name is the
/// provider object's name — it must never smuggle a path.
fn validate_filename(raw: &str) -> ApiResult<String> {
    let name = raw.trim();
    let bad = name.is_empty()
        || name.chars().count() > 255
        || name.contains('/')
        || name.contains('\\')
        || name == "."
        || name == ".."
        || name.chars().any(|c| c.is_control());
    if bad {
        return Err(ApiError::Validation {
            detail: "filename must be 1-255 characters with no path separators".into(),
        });
    }
    Ok(name.to_string())
}

/// Upload dir rules: a `/`-separated provider-folder path. Empty (or
/// absent) uploads to the root. Traversal segments and control
/// characters are rejected; empty segments normalize away.
fn validate_dir(raw: Option<&str>) -> ApiResult<String> {
    let dir = raw.unwrap_or("").trim().trim_matches('/');
    for segment in dir.split('/') {
        if segment == "." || segment == ".." {
            return Err(ApiError::Validation {
                detail: "dir must not contain traversal segments".into(),
            });
        }
        if segment.chars().any(|c| c.is_control()) {
            return Err(ApiError::Validation {
                detail: "dir must not contain control characters".into(),
            });
        }
    }
    Ok(dir.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_rules() {
        assert_eq!(validate_filename("  clip.mp4 ").unwrap(), "clip.mp4");
        assert!(validate_filename("").is_err());
        assert!(validate_filename("a/b.mp4").is_err());
        assert!(validate_filename("a\\b.mp4").is_err());
        assert!(validate_filename("..").is_err());
        assert!(validate_filename("a\u{0}b").is_err());
        assert!(validate_filename(&"x".repeat(256)).is_err());
        assert!(validate_filename(&"x".repeat(255)).is_ok());
    }

    #[test]
    fn dir_rules() {
        assert_eq!(validate_dir(None).unwrap(), "");
        assert_eq!(
            validate_dir(Some("/Movies///Sci-fi/")).unwrap(),
            "Movies///Sci-fi"
        );
        assert!(validate_dir(Some("/a/../b")).is_err());
        assert!(validate_dir(Some("/a\u{1}b")).is_err());
    }

    #[test]
    fn upload_refusal_maps_to_not_implemented() {
        match map_upload_error(Err(castify_catalog::ProviderError::Other(
            "this provider does not support uploads".into(),
        ))) {
            Err(ApiError::NotImplemented(_)) => {}
            other => panic!("expected NotImplemented, got {other:?}"),
        }
        // Every other error keeps its provider mapping.
        assert!(matches!(
            map_upload_error(Err(castify_catalog::ProviderError::Unauthorized)),
            Err(ApiError::Provider(_))
        ));
    }
}
