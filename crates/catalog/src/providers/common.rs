//! Shared helpers used by all three provider implementations.
//!
//! These were previously triplicated across `google_drive.rs`, `dropbox.rs`,
//! and `onedrive.rs`. Centralizing them here keeps per-provider modules focused
//! on their API-specific logic.

use serde::Deserialize;

use crate::crypto::TokenBundle;
use crate::provider::ProviderError;

/// Seconds subtracted from a token's advertised `expires_in` so refresh happens
/// before the wire expiry rather than at it.
pub(crate) const TOKEN_BUFFER_SECS: i64 = 60;

/// Known video file extensions. Used by providers without a server-side MIME
/// filter (Dropbox, OneDrive) to classify videos client-side.
pub(crate) const VIDEO_EXTENSIONS: &[&str] = &[
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts", ".wmv", ".flv",
];

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
pub(crate) fn classify_token_error(status: u16, body: &str) -> ProviderError {
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

/// Returns true if the filename ends with a known video extension
/// (case-insensitive).
pub(crate) fn has_video_extension(name: &str) -> bool {
    let lower = name.to_lowercase();
    VIDEO_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
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
    fn has_video_extension_matches_case_insensitive() {
        assert!(has_video_extension("video.MP4"));
        assert!(has_video_extension("clip.WEBM"));
        assert!(has_video_extension("a.b.c.mkv"));
        assert!(!has_video_extension("photo.jpg"));
        assert!(!has_video_extension("noext"));
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
}
