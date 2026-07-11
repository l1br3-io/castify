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

use async_trait::async_trait;
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use castify_catalog::provider::{ProviderFactory, ProviderResult};
use castify_catalog::{DiscoveredVideo, ListPage, NewConnection, Provider, TokenBundle};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

// ── Mock provider ───────────────────────────────────────────────────

/// Prefix-hash returned for the "shared" video across all providers.
/// Both Google Drive and Dropbox copies get this same hash so the scanner's
/// tier-2 dedup assigns them the same `dedup_group`.
const SHARED_PREFIX_HASH: &str = "e2e-shared-hash";

struct E2eMockProvider {
    videos: Vec<DiscoveredVideo>,
    prefix_hashes: HashMap<String, String>,
}

#[async_trait]
impl castify_catalog::provider::Provider for E2eMockProvider {
    fn name(&self) -> &'static str {
        "e2e-mock"
    }

    async fn list_videos(&self, _cursor: Option<&str>) -> ProviderResult<ListPage> {
        Ok(ListPage {
            videos: self.videos.clone(),
            next_cursor: None,
        })
    }

    async fn fetch_prefix_hash(&self, file_id: &str, _size: i64) -> ProviderResult<Option<String>> {
        Ok(self.prefix_hashes.get(file_id).cloned())
    }

    async fn revoke(&self, _token_bundle: &TokenBundle) -> ProviderResult<()> {
        Ok(())
    }
}

// ── Mock factory ────────────────────────────────────────────────────

pub struct E2eMockFactory {
    provider: Provider,
}

impl E2eMockFactory {
    pub fn new(provider: Provider) -> Self {
        Self { provider }
    }

    fn videos(&self) -> Vec<DiscoveredVideo> {
        match self.provider {
            Provider::GoogleDrive => vec![
                mock_video(
                    "gd-vacation",
                    "vacation.mp4",
                    5_000_000,
                    Some("hash-gd-vacation"),
                ),
                mock_video(
                    "gd-concert",
                    "concert.mp4",
                    6_000_000,
                    Some("hash-gd-concert"),
                ),
                mock_video("gd-shared", "shared-doc.mp4", 5_000_000, None),
            ],
            Provider::Dropbox => vec![
                mock_video(
                    "db-screenshots",
                    "screenshots.mp4",
                    3_000_000,
                    Some("hash-db-screenshots"),
                ),
                mock_video("db-shared", "shared-doc.mp4", 5_000_000, None),
            ],
            Provider::OneDrive => vec![mock_video(
                "od-clip",
                "onedrive-clip.mp4",
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
}

#[async_trait]
impl ProviderFactory for E2eMockFactory {
    async fn create(
        &self,
        _token: &TokenBundle,
    ) -> ProviderResult<Box<dyn castify_catalog::provider::Provider>> {
        Ok(Box::new(E2eMockProvider {
            videos: self.videos(),
            prefix_hashes: self.prefix_hashes(),
        }))
    }

    async fn refresh_token(&self, token: &TokenBundle) -> ProviderResult<TokenBundle> {
        Ok(token.clone())
    }

    async fn revoke(&self, _token: &TokenBundle) -> ProviderResult<()> {
        Ok(())
    }
}

fn mock_video(id: &str, name: &str, size: i64, native_hash: Option<&str>) -> DiscoveredVideo {
    DiscoveredVideo {
        provider_file_id: id.to_string(),
        name: name.to_string(),
        path: None,
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
