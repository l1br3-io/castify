//! Test-only mock provider factory and seed endpoint for e2e tests.
//!
//! Compiled only when the `e2e` cargo feature is enabled. This module provides:
//!
//!   * [`E2eMockFactory`] — a [`ProviderFactory`] implementation that returns
//!     canned video listings per provider, enabling the real scanner code path
//!     (listing → upsert → dedup) to run without hitting external APIs.
//!   * [`seed_connection`] — an axum handler that creates a provider connection
//!     with a mock token bundle, bypassing the OAuth dance.
//!
//! The mock factory returns different videos per provider, including a "shared"
//! video (same name, same size, no native_hash) that appears in both Google
//! Drive and Dropbox. The scanner's tier-2 dedup pass (prefix hash) assigns
//! both copies the same `dedup_group`, so the unified video list shows a dedup
//! badge — exercising the full dedup pipeline end-to-end.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use castify_catalog::provider::{
    ProviderError, ProviderFactory, ProviderResult, StreamResponse, StreamUrl, ThumbnailData,
};
use castify_catalog::{
    DiscoveredSubtitle, DiscoveredVideo, ListPage, NewConnection, Provider, TokenBundle,
};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

// ── Mock provider ───────────────────────────────────────────────────

/// Prefix-hash returned for the "shared" video across all providers.
/// Both Google Drive and Dropbox copies get this same hash so the scanner's
/// tier-2 dedup assigns them the same `dedup_group`.
const SHARED_PREFIX_HASH: &str = "e2e-shared-hash";

/// Minimal test image (PNG signature + filler) returned by the e2e mock's
/// `fetch_thumbnail`. Only the magic bytes matter — the proxy's MIME
/// detection checks the PNG signature, and tests compare raw bytes.
const TEST_THUMBNAIL_PNG: &[u8] = b"\x89PNG\r\n\x1a\n test thumbnail";

/// Minimal MP4 ftyp box (24 bytes) returned by the e2e mock's `open_stream`.
/// Enough for the browser to identify the file as MP4 and for the stream
/// proxy to return `Content-Type: video/mp4`. The e2e test checks the
/// network request and response status, not full video playback.
const MOCK_MP4: &[u8] = &[
    0x00, 0x00, 0x00, 0x18, // ftyp box size = 24
    b'f', b't', b'y', b'p', // "ftyp"
    b'i', b's', b'o', b'm', // major brand = "isom"
    0x00, 0x00, 0x00, 0x00, // minor version = 0
    b'i', b's', b'o', b'm', // compatible brand = "isom"
    b'm', b'p', b'4', b'2', // compatible brand = "mp42"
];

/// Canned VTT content returned by the e2e mock's `fetch_subtitle_content`.
const MOCK_VTT: &[u8] = b"WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nTest subtitle\n";

struct E2eMockProvider {
    /// Used by `open_stream_url` to pick Direct vs Proxied. Production Drive
    /// follows the `?alt=media` 302 and returns Direct; the e2e mock
    /// deliberately returns Proxied for Drive so the proxy code path
    /// (`/api/videos/{id}/stream`) gets exercised in the browser suite.
    /// OneDrive + Dropbox mirror production (Direct → mock CDN route).
    provider: Provider,
    videos: Vec<DiscoveredVideo>,
    subtitles: Vec<DiscoveredSubtitle>,
    prefix_hashes: HashMap<String, String>,
    /// Shared with the factory so both provider instances created within a
    /// single request's refresh-and-retry path see the same counters.
    /// File IDs starting with `refresh-once-` return `Unauthorized` on the
    /// first `open_stream` call and succeed on retry, simulating an expired
    /// access token mid-stream.
    refresh_state: Arc<Mutex<HashMap<String, u32>>>,
}

#[async_trait]
impl castify_catalog::provider::Provider for E2eMockProvider {
    fn name(&self) -> &'static str {
        "e2e-mock"
    }

    async fn list_videos(&self, _cursor: Option<&str>) -> ProviderResult<ListPage> {
        Ok(ListPage {
            videos: self.videos.clone(),
            subtitles: self.subtitles.clone(),
            next_cursor: None,
        })
    }

    async fn fetch_prefix_hash(&self, file_id: &str, _size: i64) -> ProviderResult<Option<String>> {
        Ok(self.prefix_hashes.get(file_id).cloned())
    }

    async fn fetch_thumbnail(&self, file_id: &str) -> ProviderResult<ThumbnailData> {
        if file_id.starts_with("no-thumb-") {
            return Err(ProviderError::NotFound(file_id.into()));
        }
        Ok(ThumbnailData {
            bytes: TEST_THUMBNAIL_PNG.to_vec(),
            mime_type: "image/png".into(),
        })
    }

    async fn open_stream(
        &self,
        file_id: &str,
        range: Option<&str>,
    ) -> ProviderResult<StreamResponse> {
        if file_id.starts_with("no-stream-") {
            return Err(ProviderError::NotFound(file_id.into()));
        }

        // Token-refresh simulation: file IDs starting with `refresh-once-`
        // return Unauthorized on the first call, then succeed on retry. This
        // exercises the API layer's refresh-and-retry path within a single
        // request. State is shared across provider instances via the factory.
        if file_id.starts_with("refresh-once-") {
            let mut state = self.refresh_state.lock().await;
            let count = state.entry(file_id.to_string()).or_insert(0);
            *count += 1;
            if *count == 1 {
                return Err(ProviderError::Unauthorized);
            }
        }

        use bytes::Bytes;
        use futures::stream;

        let total = MOCK_MP4.len() as u64;

        // Parse "bytes=start-end" Range header for 206 partial content.
        if let Some(range_str) = range {
            if let Some((start, end)) = parse_simple_range(range_str, total) {
                let start_us = start as usize;
                let end_us = end as usize;
                let bytes = Bytes::copy_from_slice(&MOCK_MP4[start_us..=end_us]);
                let content_length = bytes.len() as u64;
                let body = stream::once(async move { Ok::<_, std::io::Error>(bytes) });
                return Ok(StreamResponse {
                    status: 206,
                    content_type: "video/mp4".into(),
                    content_length: Some(content_length),
                    content_range: Some(format!("bytes {start}-{end}/{total}")),
                    body: Box::pin(body),
                });
            }
        }

        let body =
            stream::once(async move { Ok::<_, std::io::Error>(Bytes::from_static(MOCK_MP4)) });
        Ok(StreamResponse {
            status: 200,
            content_type: "video/mp4".into(),
            content_length: Some(total),
            content_range: None,
            body: Box::pin(body),
        })
    }

    async fn revoke(&self, _token_bundle: &TokenBundle) -> ProviderResult<()> {
        Ok(())
    }

    async fn fetch_subtitle_content(&self, file_id: &str) -> ProviderResult<Vec<u8>> {
        if file_id.starts_with("no-subs-") {
            return Err(ProviderError::NotFound(file_id.into()));
        }
        Ok(MOCK_VTT.to_vec())
    }

    /// Mocks `open_stream_url`. Production returns Direct for all three
    /// providers (OneDrive + Dropbox issue a preauthenticated CDN URL;
    /// Drive follows the `?alt=media` 302 to a pre-signed download URL).
    /// This mock splits strategies deliberately: OneDrive + Dropbox return
    /// Direct pointing at a mock CDN route (`/api/__e2e/mock-cdn/{file_id}`)
    /// so the browser suite exercises the direct path, while Google Drive
    /// returns Proxied so the suite also exercises the `/stream` proxy path
    /// — Drive's real redirect flow can't run in CI without real OAuth.
    /// The mock CDN route serves the same `MOCK_MP4` bytes `open_stream`
    /// would have produced, so the e2e browser can actually load the
    /// `<video src>` in either strategy.
    async fn open_stream_url(&self, file_id: &str) -> ProviderResult<StreamUrl> {
        if file_id.starts_with("no-stream-") {
            return Err(ProviderError::NotFound(file_id.into()));
        }
        match self.provider {
            Provider::GoogleDrive => Ok(StreamUrl::Proxied),
            Provider::Dropbox | Provider::OneDrive => Ok(StreamUrl::Direct {
                url: format!("/api/__e2e/mock-cdn/{file_id}"),
                expires_at: None,
            }),
        }
    }
}

// ── Mock factory ────────────────────────────────────────────────────

pub struct E2eMockFactory {
    provider: Provider,
    /// Shared across all provider instances created by this factory within
    /// a single request's lifetime. See `E2eMockProvider::refresh_state`.
    refresh_state: Arc<Mutex<HashMap<String, u32>>>,
}

impl E2eMockFactory {
    pub fn new(provider: Provider) -> Self {
        Self {
            provider,
            refresh_state: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn videos(&self) -> Vec<DiscoveredVideo> {
        match self.provider {
            Provider::GoogleDrive => vec![
                mock_video(
                    "gd-vacation",
                    "vacation.mp4",
                    "/Movies/vacation.mp4",
                    5_000_000,
                    Some("hash-gd-vacation"),
                ),
                mock_video(
                    "gd-concert",
                    "concert.mp4",
                    "/Movies/concert.mp4",
                    6_000_000,
                    Some("hash-gd-concert"),
                ),
                mock_video(
                    "gd-shared",
                    "shared-doc.mp4",
                    "/Movies/shared-doc.mp4",
                    5_000_000,
                    None,
                ),
            ],
            Provider::Dropbox => vec![
                mock_video(
                    "db-screenshots",
                    "screenshots.mp4",
                    "/Photos/screenshots.mp4",
                    3_000_000,
                    Some("hash-db-screenshots"),
                ),
                mock_video(
                    "db-shared",
                    "shared-doc.mp4",
                    "/Movies/shared-doc.mp4",
                    5_000_000,
                    None,
                ),
            ],
            Provider::OneDrive => vec![mock_video(
                "od-clip",
                "onedrive-clip.mp4",
                "/Clips/onedrive-clip.mp4",
                7_000_000,
                Some("hash-od-clip"),
            )],
        }
    }

    fn prefix_hashes(&self) -> HashMap<String, String> {
        let mut hashes = HashMap::new();
        for v in self.videos() {
            if v.native_hash.is_none() {
                hashes.insert(v.provider_file_id.clone(), SHARED_PREFIX_HASH.to_string());
            }
        }
        hashes
    }

    fn subtitles(&self) -> Vec<DiscoveredSubtitle> {
        match self.provider {
            Provider::GoogleDrive => vec![DiscoveredSubtitle {
                provider_file_id: "gd-vacation-srt".into(),
                name: "vacation.en.srt".into(),
                path: Some("/Movies/vacation.en.srt".into()),
                language: Some("en".into()),
            }],
            _ => vec![],
        }
    }
}

#[async_trait]
impl ProviderFactory for E2eMockFactory {
    async fn create(
        &self,
        _token: &TokenBundle,
    ) -> ProviderResult<Box<dyn castify_catalog::provider::Provider>> {
        Ok(Box::new(E2eMockProvider {
            provider: self.provider,
            videos: self.videos(),
            subtitles: self.subtitles(),
            prefix_hashes: self.prefix_hashes(),
            refresh_state: self.refresh_state.clone(),
        }))
    }

    async fn refresh_token(&self, token: &TokenBundle) -> ProviderResult<TokenBundle> {
        Ok(token.clone())
    }

    async fn revoke(&self, _token: &TokenBundle) -> ProviderResult<()> {
        Ok(())
    }

    fn authorization_url(&self, _: &str, _: &str, _: &str) -> String {
        String::new()
    }

    async fn exchange_code(&self, _: &str, _: &str, _: &str) -> ProviderResult<TokenBundle> {
        Err(ProviderError::Other("e2e mock: no OAuth flow".into()))
    }

    async fn fetch_user_info(
        &self,
        _: &TokenBundle,
    ) -> ProviderResult<(Option<String>, Option<String>)> {
        Ok((Some("e2e-account".into()), Some("e2e@example.com".into())))
    }
}

fn mock_video(
    id: &str,
    name: &str,
    path: &str,
    size: i64,
    native_hash: Option<&str>,
) -> DiscoveredVideo {
    DiscoveredVideo {
        provider_file_id: id.to_string(),
        name: name.to_string(),
        path: Some(path.to_string()),
        size_bytes: size,
        mime_type: Some("video/mp4".to_string()),
        duration_ms: Some(120_000),
        width: Some(1920),
        height: Some(1080),
        native_hash: native_hash.map(|s| s.to_string()),
        native_hash_algo: native_hash.map(|_| "sha256".to_string()),
        provider_modified_at: None,
    }
}

/// Parse a simple `bytes=start-end` Range header for the e2e mock's
/// `open_stream`. Returns `(start, end)` inclusive, clamped to `total`.
/// Supports `bytes=0-1023` and `bytes=0-` (open-ended). Returns `None`
/// for unparseable values (falls back to full-content 200).
fn parse_simple_range(range: &str, total: u64) -> Option<(u64, u64)> {
    let range = range.strip_prefix("bytes=")?;
    let (start_str, end_str) = range.split_once('-')?;
    let start: u64 = start_str.parse().ok()?;
    let end: u64 = if end_str.is_empty() {
        total - 1
    } else {
        end_str.parse().ok()?
    };
    if start > end || start >= total {
        return None;
    }
    Some((start, end.min(total - 1)))
}

// ── Seed endpoint ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SeedConnectionBody {
    pub provider: String,
    pub account_email: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SeedConnectionResponse {
    pub id: String,
    pub provider: String,
}

/// `POST /api/__e2e/seed-connection` — create a mock provider connection.
///
/// Bypasses the OAuth flow by inserting a connection row with a fake token
/// bundle. The connection is immediately scannable via `POST /api/connections/{id}/scan`
/// because `spawn_scan` uses [`E2eMockFactory`] when the `e2e` feature is on.
pub async fn seed_connection(
    State(state): State<AppState>,
    Json(body): Json<SeedConnectionBody>,
) -> ApiResult<Json<SeedConnectionResponse>> {
    let provider =
        Provider::parse(&body.provider).map_err(|e| ApiError::Validation { detail: e })?;

    let token_bundle = TokenBundle {
        access_token: "e2e-mock-access-token".into(),
        refresh_token: Some("e2e-mock-refresh-token".into()),
        expires_at: None,
        token_type: "Bearer".into(),
        scope: None,
    };

    let conn = state
        .catalog_repository()
        .create_connection(&NewConnection {
            provider,
            token_bundle,
            provider_account_id: Some(format!("e2e-mock-{provider}")),
            provider_account_email: body.account_email,
        })
        .await?;

    Ok(Json(SeedConnectionResponse {
        id: conn.id,
        provider: provider.to_string(),
    }))
}

// ── Mock CDN endpoint ──────────────────────────────────────────────

/// `GET /api/__e2e/mock-cdn/{file_id}` — serves the same canned MP4 bytes
/// as `E2eMockProvider::open_stream`, but from a same-origin URL that the
/// browser can hit directly when `open_stream_url` returns
/// `StreamUrl::Direct { url: "/api/__e2e/mock-cdn/{file_id}" }`. Honors
/// `Range` (206 partial content) so `<video>` seeking works in e2e.
///
/// The e2e test asserts the `<video src>` points here for OneDrive/Dropbox
/// (Direct strategy) — proving the browser fetches from the CDN URL rather
/// than our `/stream` proxy.
pub async fn mock_cdn(Path(file_id): Path<String>, headers: HeaderMap) -> Response {
    if file_id.starts_with("no-stream-") {
        let mut resp = Response::new(Body::from("not found"));
        *resp.status_mut() = StatusCode::NOT_FOUND;
        return resp;
    }

    let total = MOCK_MP4.len() as u64;
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| parse_simple_range(s, total));

    match range {
        Some((start, end)) => {
            let start_us = start as usize;
            let end_us = end as usize;
            let bytes = MOCK_MP4[start_us..=end_us].to_vec();
            let content_length = bytes.len() as u64;
            let mut resp = Response::new(Body::from(bytes));
            *resp.status_mut() = StatusCode::PARTIAL_CONTENT;
            resp.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
            if let Ok(val) = HeaderValue::from_str(&content_length.to_string()) {
                resp.headers_mut().insert(header::CONTENT_LENGTH, val);
            }
            if let Ok(val) = HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")) {
                resp.headers_mut().insert(header::CONTENT_RANGE, val);
            }
            resp.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            resp
        }
        None => {
            let mut resp = Response::new(Body::from(MOCK_MP4.to_vec()));
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
            if let Ok(val) = HeaderValue::from_str(&total.to_string()) {
                resp.headers_mut().insert(header::CONTENT_LENGTH, val);
            }
            resp.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            resp
        }
    }
}
