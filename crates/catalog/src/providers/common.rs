//! Shared helpers used by all three provider implementations.
//!
//! These were previously triplicated across `google_drive.rs`, `dropbox.rs`,
//! and `onedrive.rs`. Centralizing them here keeps per-provider modules focused
//! on their API-specific logic.

use serde::Deserialize;

use crate::crypto::TokenBundle;
use crate::model::FileKind;
use crate::provider::{ProviderError, ProviderResult, StreamResponse};

/// Seconds subtracted from a token's advertised `expires_in` so refresh happens
/// before the wire expiry rather than at it.
pub(crate) const TOKEN_BUFFER_SECS: i64 = 60;

/// Known video file extensions. Used by providers without a server-side MIME
/// filter (Dropbox, OneDrive) to classify videos client-side, and by the
/// playback helpers (`video_base_name`, `infer_mime_type`) for files already
/// gated into `videos`.
///
/// `.ts` sits in this list for MPEG-TS playback support, but it collides with
/// TypeScript source files — so the video *gate* ([`has_video_extension`])
/// excludes it. A `.ts` is only cataloged as a video when the provider
/// corroborates it with server-side analysis (Drive `videoMediaMetadata` or
/// `video/mp2t` MIME, OneDrive populated `video` facet or `video/mp2t` MIME,
/// Dropbox `media_info` video tag); see [`is_mpeg_ts_name`].
pub(crate) const VIDEO_EXTENSIONS: &[&str] = &[
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts", ".wmv", ".flv",
];

/// Known sidecar subtitle extensions. Used by all three providers to capture
/// `.srt`/`.vtt` files during the same listing pass as videos.
pub(crate) const SUBTITLE_EXTENSIONS: &[&str] = &[".srt", ".vtt"];

// --- Non-video classification tables (M9) ---
//
// These drive `classify_kind` only — organizational metadata for the folder
// tree. They deliberately do NOT gate any playback path, so they can be
// wider than their playback counterparts (e.g. subtitle classification
// includes ASS/SSA/PGS from M8, while sidecar capture above stays
// `.srt`/`.vtt`).

const AUDIO_EXTENSIONS: &[&str] = &[".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".opus"];

const IMAGE_EXTENSIONS: &[&str] = &[
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".tiff", ".bmp", ".svg",
];

const SUBTITLE_KIND_EXTENSIONS: &[&str] = &[".srt", ".vtt", ".ass", ".ssa", ".pgs"];

const DOCUMENT_EXTENSIONS: &[&str] = &[
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".txt", ".md",
    ".rtf",
];

const ARCHIVE_EXTENSIONS: &[&str] = &[".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"];

/// Classify a non-video file by extension (primary) or provider MIME type
/// (fallback). Unknown files degrade to [`FileKind::Other`] — a file is never
/// dropped from the catalog because its type is unrecognized (M9 FR-2.1).
/// Only called for entries that already failed the video gate.
pub(crate) fn classify_kind(name: &str, mime_type: Option<&str>) -> FileKind {
    let lower = name.to_lowercase();
    let by_extension = |exts: &[&str]| exts.iter().any(|ext| lower.ends_with(ext));
    if by_extension(AUDIO_EXTENSIONS) {
        FileKind::Audio
    } else if by_extension(IMAGE_EXTENSIONS) {
        FileKind::Image
    } else if by_extension(SUBTITLE_KIND_EXTENSIONS) {
        FileKind::Subtitle
    } else if by_extension(DOCUMENT_EXTENSIONS) {
        FileKind::Document
    } else if by_extension(ARCHIVE_EXTENSIONS) {
        FileKind::Archive
    } else if let Some(mime) = mime_type {
        classify_by_mime(mime)
    } else {
        FileKind::Other
    }
}

/// MIME fallback when the extension is unrecognized. Coarse prefixes only —
/// this is organizational metadata, not playback routing.
fn classify_by_mime(mime: &str) -> FileKind {
    let lower = mime.to_lowercase();
    if lower.starts_with("audio/") {
        FileKind::Audio
    } else if lower.starts_with("image/") {
        FileKind::Image
    } else if lower.starts_with("text/") || lower == "application/pdf" {
        FileKind::Document
    } else if lower == "application/zip" || lower == "application/x-rar-compressed" {
        FileKind::Archive
    } else {
        FileKind::Other
    }
}

/// Build a [`DiscoveredFile`] with an explicit kind. Providers call this for
/// the subtitle dual-representation (sidecar row + file row) where the kind
/// is known without classification; everything else goes through
/// [`classify_kind`] at the call site.
#[allow(clippy::too_many_arguments)]
pub(crate) fn discovered_file_of_kind(
    kind: FileKind,
    provider_file_id: String,
    name: String,
    path: Option<String>,
    size_bytes: i64,
    mime_type: Option<String>,
    provider_modified_at: Option<String>,
) -> crate::model::DiscoveredFile {
    crate::model::DiscoveredFile {
        provider_file_id,
        name,
        path,
        size_bytes,
        mime_type,
        kind,
        provider_modified_at,
    }
}

/// Lowercase hex encoding of a byte slice.
pub(crate) fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}

/// Classify a non-success token-endpoint response into the appropriate
/// provider error. Shared by all providers' token exchange + refresh paths.
///
/// Per [RFC 6749 §5.2](https://datatracker.ietf.org/doc/html/rfc6749#section-5.2),
/// an `"invalid_grant"` error from the token endpoint means the refresh
/// grant itself is dead (expired, revoked, or malformed) — this is distinct
/// from a 401 on a resource call (access-token expiry, recoverable via
/// refresh). We surface it as [`ProviderError::ReauthRequired`] so the API
/// layer can return a structured `code: "reauth_required"` response and the
/// frontend can route the user to reconnect.
pub(crate) fn classify_token_error(status: u16, body: &str) -> ProviderError {
    if is_invalid_grant(body) {
        return ProviderError::ReauthRequired;
    }
    if status == 401 {
        ProviderError::Unauthorized
    } else if status == 429 || status == 503 {
        ProviderError::RateLimited {
            retry_after_secs: None,
        }
    } else {
        ProviderError::Api {
            status,
            body: body.to_string(),
        }
    }
}

/// Detect the OAuth2 `invalid_grant` error in a token-endpoint response body.
/// Tolerant of whitespace and key ordering; the canonical body is
/// `{"error":"invalid_grant","error_description":"Token has been expired or revoked."}`.
/// Used by [`classify_token_error`] across all three providers.
fn is_invalid_grant(body: &str) -> bool {
    // Cheap pre-filter before touching serde. Providers always JSON-encode the
    // key/val pair, but quoting/spacing varies across accounts/SDKs; keep this
    // loose on purpose.
    if !body.contains("invalid_grant") {
        return false;
    }
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => v
            .get("error")
            .and_then(|e| e.as_str())
            .map(|s| s == "invalid_grant")
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Returns true if the filename ends with a known video extension
/// (case-insensitive) — EXCEPT `.ts`, which is ambiguous (MPEG-TS video vs
/// TypeScript source) and must be corroborated by the provider before being
/// cataloged as a video ([`is_mpeg_ts_name`]).
pub(crate) fn has_video_extension(name: &str) -> bool {
    let lower = name.to_lowercase();
    if is_mpeg_ts_name(&lower) {
        return false;
    }
    VIDEO_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// True when the name's extension is `.ts` (case-insensitive) — the
/// MPEG-TS/TypeScript collision. Callers combine this with a
/// provider-specific corroboration signal (provider media analysis or
/// `video/mp2t` MIME) before cataloging the file as a video.
pub(crate) fn is_mpeg_ts_name(name: &str) -> bool {
    name.to_lowercase().ends_with(".ts")
}

/// Returns true if the filename ends with a known subtitle extension
/// (case-insensitive).
pub(crate) fn has_subtitle_extension(name: &str) -> bool {
    let lower = name.to_lowercase();
    SUBTITLE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Infer the subtitle format from the filename extension: `"srt"` or `"vtt"`.
/// Returns `None` for non-subtitle files.
pub(crate) fn infer_subtitle_format(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if lower.ends_with(".srt") {
        Some("srt")
    } else if lower.ends_with(".vtt") {
        Some("vtt")
    } else {
        None
    }
}

/// Guess a language code from a subtitle filename. Looks for a 2-letter
/// ISO 639-1 code (optionally followed by a region suffix like `-US`) in the
/// segment immediately before the subtitle extension.
///
/// Examples: `movie.en.srt` → `Some("en")`, `movie.pt-BR.srt` →
/// `Some("pt-BR")`, `movie.srt` → `None`, `movie.english.srt` → `None`.
pub(crate) fn guess_language(filename: &str) -> Option<String> {
    let stripped = filename
        .rsplit_once('.')
        .filter(|(_, ext)| {
            let lower = ext.to_lowercase();
            lower == "srt" || lower == "vtt"
        })?
        .0;
    // Use the last dot-separated segment (not `-`/`_`, so "pt-BR" stays intact).
    let last_segment = stripped.rsplit('.').next()?;
    if is_language_code(last_segment) {
        Some(last_segment.to_string())
    } else {
        None
    }
}

/// Check if a string looks like an ISO 639-1 language code: exactly 2 lowercase
/// ASCII letters, optionally followed by `-`/`_` and 2 uppercase ASCII letters
/// (region suffix like `pt-BR`).
fn is_language_code(s: &str) -> bool {
    let bytes = s.as_bytes();
    match bytes.len() {
        2 => bytes.iter().all(|b| b.is_ascii_lowercase()),
        5 => {
            bytes[..2].iter().all(|b| b.is_ascii_lowercase())
                && (bytes[2] == b'-' || bytes[2] == b'_')
                && bytes[3..].iter().all(|b| b.is_ascii_uppercase())
        }
        _ => false,
    }
}

/// Compute the base name of a subtitle file for matching to videos: strips the
/// subtitle extension and any language suffix. Returns `None` if the file
/// isn't a subtitle.
///
/// Examples: `movie.en.srt` → `Some("movie")`, `movie.srt` → `Some("movie")`,
/// `movie.pt-BR.vtt` → `Some("movie")`, `photo.jpg` → `None`.
pub(crate) fn subtitle_base_name(filename: &str) -> Option<String> {
    let format = infer_subtitle_format(filename)?;
    let without_ext = &filename[..filename.len() - format.len() - 1];
    let language = guess_language(filename);
    match &language {
        Some(lang) => Some(without_ext[..without_ext.len() - lang.len() - 1].to_string()),
        None => Some(without_ext.to_string()),
    }
}

/// Compute the base name of a video file for matching to subtitles: strips the
/// known video extension.
///
/// Examples: `movie.mp4` → `Some("movie")`, `movie.trailer.mkv` →
/// `Some("movie.trailer")`, `photo.jpg` → `None`.
pub(crate) fn video_base_name(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    for ext in VIDEO_EXTENSIONS {
        if let Some(stripped) = lower.strip_suffix(ext) {
            return Some(name[..stripped.len()].to_string());
        }
    }
    None
}

/// Infer an image MIME type from an HTTP `Content-Type` header value.
/// Defaults to `"image/jpeg"` when the header is missing or unrecognized —
/// all three providers serve thumbnails as JPEG by default (Drive
/// `thumbnailLink`, Dropbox `get_thumbnail_v2` with `format: jpeg`, OneDrive
/// thumbnail content).
pub(crate) fn infer_image_mime(content_type: &str) -> &'static str {
    let lower = content_type.to_lowercase();
    if lower.contains("image/png") {
        "image/png"
    } else {
        "image/jpeg"
    }
}

/// Infer a video MIME type from the file extension. Used by providers that
/// don't return a MIME type in their listing (Dropbox). Returns `None` for
/// unknown or non-video extensions.
pub(crate) fn infer_mime_type(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let mime = match lower.rsplit_once('.')? {
        (_, "mp4") => "video/mp4",
        (_, "mkv") => "video/x-matroska",
        (_, "webm") => "video/webm",
        (_, "mov") => "video/quicktime",
        (_, "avi") => "video/x-msvideo",
        (_, "m4v") => "video/x-m4v",
        (_, "ts") => "video/mp2t",
        (_, "wmv") => "video/x-ms-wmv",
        (_, "flv") => "video/x-flv",
        _ => return None,
    };
    Some(mime.to_string())
}

/// Convert a reqwest response into a [`StreamResponse`], handling the common
/// error/status mapping shared by all three providers' `open_stream` methods.
///
/// Maps 401 → [`ProviderError::Unauthorized`], 429/503 →
/// [`ProviderError::RateLimited`], and non-success non-206 →
/// [`ProviderError::Api`]. Extracts `Content-Type`, `Content-Length`, and
/// `Content-Range` headers. The body is converted to a streaming
/// [`BodyStream`](crate::provider::BodyStream) via `bytes_stream()`.
pub(crate) async fn response_to_stream(resp: reqwest::Response) -> ProviderResult<StreamResponse> {
    let status = resp.status();
    if status.as_u16() == 401 {
        return Err(ProviderError::Unauthorized);
    }
    if status.as_u16() == 429 || status.as_u16() == 503 {
        return Err(ProviderError::RateLimited {
            retry_after_secs: None,
        });
    }
    if !status.is_success() && status.as_u16() != 206 {
        let body = resp.text().await.unwrap_or_default();
        return Err(ProviderError::Api {
            status: status.as_u16(),
            body,
        });
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let content_length = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());
    let content_range = resp
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    use futures::StreamExt;
    let body = resp
        .bytes_stream()
        .map(|result| result.map_err(std::io::Error::other));

    Ok(StreamResponse {
        status: status.as_u16(),
        content_type,
        content_length,
        content_range,
        body: Box::pin(body),
    })
}

/// Raw token response shared across providers.
///
/// `refresh_token`, `expires_in`, and `scope` use `#[serde(default)]` so a
/// single type handles both the auth-code exchange (Google always returns
/// `refresh_token`; Dropbox/OneDrive always return `expires_in`) and the
/// refresh response (Dropbox/OneDrive omit `refresh_token`; scopes may be
/// absent). The factory's refresh path carries the old `refresh_token` and
/// `scope` forward when the response omits them — see each factory's
/// `refresh_token` impl.
#[derive(Debug, Deserialize)]
pub(crate) struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    token_type: String,
    #[serde(default)]
    scope: Option<String>,
}

impl TokenResponse {
    /// Convert the raw response into a [`TokenBundle`], computing an absolute
    /// `expires_at` timestamp (now + `expires_in` - [`TOKEN_BUFFER_SECS`]).
    pub(crate) fn into_bundle(self) -> TokenBundle {
        let expires_at = self.expires_in.map(|secs| {
            let now = chrono::Utc::now();
            let expiry = now + chrono::Duration::seconds(secs - TOKEN_BUFFER_SECS);
            expiry.format("%Y-%m-%dT%H:%M:%SZ").to_string()
        });
        TokenBundle {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            expires_at,
            token_type: self.token_type,
            scope: self.scope,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_hex_produces_lowercase_hex() {
        assert_eq!(to_hex(&[0x01, 0x23, 0xab, 0xff]), "0123abff");
        assert_eq!(to_hex(&[]), "");
    }

    #[test]
    fn classify_kind_extension_matrix() {
        // Extension match is primary and case-insensitive.
        assert_eq!(classify_kind("song.mp3", None), FileKind::Audio);
        assert_eq!(classify_kind("track.FLAC", None), FileKind::Audio);
        assert_eq!(classify_kind("cover.JPG", None), FileKind::Image);
        assert_eq!(classify_kind("photo.heic", None), FileKind::Image);
        assert_eq!(classify_kind("thesis.pdf", None), FileKind::Document);
        assert_eq!(classify_kind("notes.txt", None), FileKind::Document);
        assert_eq!(classify_kind("backup.tar.gz", None), FileKind::Archive);
        assert_eq!(classify_kind("riven.7z", None), FileKind::Archive);
        // Subtitle classification covers M8's wider format set — this table
        // is organizational only (folder tree), unlike SUBTITLE_EXTENSIONS
        // which gates playback sidecar capture at .srt/.vtt.
        assert_eq!(classify_kind("movie.en.srt", None), FileKind::Subtitle);
        assert_eq!(classify_kind("movie.ass", None), FileKind::Subtitle);
        assert_eq!(classify_kind("movie.pgs", None), FileKind::Subtitle);
        // Multi-dot names match the final extension.
        assert_eq!(classify_kind("a.b.c.flac", None), FileKind::Audio);
    }

    #[test]
    fn classify_kind_mime_fallback_when_extension_unknown() {
        assert_eq!(
            classify_kind("untitled", Some("audio/mpeg")),
            FileKind::Audio
        );
        assert_eq!(
            classify_kind("untitled", Some("image/png")),
            FileKind::Image
        );
        assert_eq!(
            classify_kind("untitled", Some("application/pdf")),
            FileKind::Document
        );
        assert_eq!(
            classify_kind("untitled", Some("application/zip")),
            FileKind::Archive
        );
        assert_eq!(
            classify_kind("untitled", Some("text/plain")),
            FileKind::Document
        );
        // Extension wins over a disagreeing MIME type.
        assert_eq!(
            classify_kind("song.mp3", Some("application/octet-stream")),
            FileKind::Audio
        );
    }

    #[test]
    fn classify_kind_unknown_degrades_to_other() {
        assert_eq!(classify_kind("weird.dat", None), FileKind::Other);
        assert_eq!(classify_kind("noext", None), FileKind::Other);
        assert_eq!(
            classify_kind("noext", Some("application/octet-stream")),
            FileKind::Other
        );
        assert_eq!(classify_kind("", None), FileKind::Other);
    }

    #[test]
    fn has_video_extension_matches_case_insensitive() {
        assert!(has_video_extension("video.MP4"));
        assert!(has_video_extension("clip.WEBM"));
        assert!(has_video_extension("a.b.c.mkv"));
        assert!(!has_video_extension("photo.jpg"));
        assert!(!has_video_extension("noext"));
    }

    #[test]
    fn has_video_extension_rejects_ambiguous_ts() {
        // `.ts` collides with TypeScript source — extension alone must not
        // gate a file into `videos`. Providers corroborate `.ts` against
        // server-side analysis before classifying it as a video.
        assert!(!has_video_extension("main.ts"));
        assert!(!has_video_extension("component.TS"));
        assert!(!has_video_extension("app.module.ts"));
        // Look-alikes are not `.ts`.
        assert!(!has_video_extension("view.tsx"));
    }

    #[test]
    fn is_mpeg_ts_name_detects_ts_extension_only() {
        assert!(is_mpeg_ts_name("recording.ts"));
        assert!(is_mpeg_ts_name("REC.TS"));
        assert!(!is_mpeg_ts_name("view.tsx"));
        assert!(!is_mpeg_ts_name("clip.mp4"));
        assert!(!is_mpeg_ts_name("notes.txt"));
    }

    #[test]
    fn infer_mime_type_known_extensions() {
        assert_eq!(infer_mime_type("movie.mp4").as_deref(), Some("video/mp4"));
        assert_eq!(
            infer_mime_type("clip.MKV").as_deref(),
            Some("video/x-matroska")
        );
        assert_eq!(infer_mime_type("a.b.c.webm").as_deref(), Some("video/webm"));
        assert_eq!(
            infer_mime_type("trailer.mov").as_deref(),
            Some("video/quicktime")
        );
        assert_eq!(
            infer_mime_type("old.avi").as_deref(),
            Some("video/x-msvideo")
        );
    }

    #[test]
    fn infer_mime_type_unknown_returns_none() {
        assert_eq!(infer_mime_type("photo.jpg"), None);
        assert_eq!(infer_mime_type("noext"), None);
        assert_eq!(infer_mime_type("archive.zip"), None);
    }

    #[test]
    fn token_response_expires_at_has_buffer() {
        let resp = TokenResponse {
            access_token: "at".into(),
            refresh_token: Some("rt".into()),
            expires_in: Some(3600),
            token_type: "Bearer".into(),
            scope: None,
        };
        let bundle = resp.into_bundle();
        assert!(bundle.expires_at.is_some());
        assert!(bundle.refresh_token.is_some());
    }

    #[test]
    fn token_response_without_refresh_token() {
        let resp = TokenResponse {
            access_token: "at".into(),
            refresh_token: None,
            expires_in: None,
            token_type: "Bearer".into(),
            scope: None,
        };
        let bundle = resp.into_bundle();
        assert!(bundle.refresh_token.is_none());
        assert!(bundle.expires_at.is_none());
    }

    #[test]
    fn infer_image_mime_recognizes_png_and_defaults_jpeg() {
        assert_eq!(infer_image_mime("image/png"), "image/png");
        assert_eq!(infer_image_mime("IMAGE/PNG"), "image/png");
        assert_eq!(infer_image_mime("image/jpeg"), "image/jpeg");
        assert_eq!(infer_image_mime("image/jpg"), "image/jpeg");
        assert_eq!(infer_image_mime("application/octet-stream"), "image/jpeg");
        assert_eq!(infer_image_mime(""), "image/jpeg");
    }

    #[test]
    fn classify_token_error_maps_status_codes() {
        assert!(matches!(
            classify_token_error(401, "bad"),
            ProviderError::Unauthorized
        ));
        assert!(matches!(
            classify_token_error(429, "slow"),
            ProviderError::RateLimited { .. }
        ));
        assert!(matches!(
            classify_token_error(503, "down"),
            ProviderError::RateLimited { .. }
        ));
        assert!(matches!(
            classify_token_error(400, "nope"),
            ProviderError::Api { status: 400, .. }
        ));
    }

    #[test]
    fn classify_token_error_detects_invalid_grant_regardless_of_status() {
        // The canonical Google/OneDrive/Dropbox signal — usually 400, but the
        // RFC does not mandate a specific status; classification keys on the
        // body's `error` field, not the HTTP status.
        let cases: &[(&str, u16, &str)] = &[
            (
                r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#,
                400,
                "canonical Google form",
            ),
            (r#"{"error":"invalid_grant"}"#, 401, "minimal 401 form"),
            // Whitespace/key-order tolerance.
            (
                r#"{  "error_description" : "Bad request" , "error" : "invalid_grant" }"#,
                400,
                "key-reordered with spaces",
            ),
        ];
        for (body, status, label) in cases {
            assert!(
                matches!(
                    classify_token_error(*status, body),
                    ProviderError::ReauthRequired
                ),
                "{label}: expected ReauthRequired for body={body}"
            );
        }
    }

    #[test]
    fn classify_token_error_does_not_false_positive_invalid_grant() {
        // Body mentions the substring but `error` is something else — must
        // fall through to the status-based mapping, not ReauthRequired.
        let body = r#"{"error":"invalid_request","error_description":"invalid_grant is not the error here"}"#;
        assert!(matches!(
            classify_token_error(400, body),
            ProviderError::Api { status: 400, .. }
        ));
        // Malformed JSON mentioning invalid_grant — never classify as
        // ReauthRequired (we can't actually confirm the structured `error`).
        assert!(matches!(
            classify_token_error(400, "oops invalid_grant not json"),
            ProviderError::Api { status: 400, .. }
        ));
    }

    #[test]
    fn has_subtitle_extension_matches_case_insensitive() {
        assert!(has_subtitle_extension("movie.SRT"));
        assert!(has_subtitle_extension("clip.vtt"));
        assert!(!has_subtitle_extension("movie.mp4"));
        assert!(!has_subtitle_extension("noext"));
    }

    #[test]
    fn infer_subtitle_format_detects_srt_and_vtt() {
        assert_eq!(infer_subtitle_format("movie.srt"), Some("srt"));
        assert_eq!(infer_subtitle_format("movie.VTT"), Some("vtt"));
        assert_eq!(infer_subtitle_format("movie.mp4"), None);
    }

    #[test]
    fn guess_language_extracts_code() {
        assert_eq!(guess_language("movie.en.srt").as_deref(), Some("en"));
        assert_eq!(guess_language("movie.es.vtt").as_deref(), Some("es"));
        assert_eq!(guess_language("movie.pt-BR.srt").as_deref(), Some("pt-BR"));
        assert_eq!(guess_language("movie.srt"), None);
        assert_eq!(guess_language("movie.english.srt"), None);
    }

    #[test]
    fn subtitle_base_name_strips_extension_and_language() {
        assert_eq!(subtitle_base_name("movie.en.srt").as_deref(), Some("movie"));
        assert_eq!(subtitle_base_name("movie.srt").as_deref(), Some("movie"));
        assert_eq!(
            subtitle_base_name("movie.pt-BR.vtt").as_deref(),
            Some("movie")
        );
        assert_eq!(
            subtitle_base_name("trailer.part1.en.srt").as_deref(),
            Some("trailer.part1")
        );
        assert_eq!(subtitle_base_name("photo.jpg"), None);
    }

    #[test]
    fn video_base_name_strips_video_extension() {
        assert_eq!(video_base_name("movie.mp4").as_deref(), Some("movie"));
        assert_eq!(
            video_base_name("trailer.part1.mkv").as_deref(),
            Some("trailer.part1")
        );
        assert_eq!(video_base_name("photo.jpg"), None);
    }

    #[test]
    fn subtitle_matches_video_by_base_name() {
        assert_eq!(
            subtitle_base_name("vacation.en.srt").as_deref(),
            video_base_name("vacation.mp4").as_deref()
        );
        assert_eq!(
            subtitle_base_name("concert.srt").as_deref(),
            video_base_name("concert.mkv").as_deref()
        );
        assert_ne!(
            subtitle_base_name("different.en.srt").as_deref(),
            video_base_name("vacation.mp4").as_deref()
        );
    }
}
