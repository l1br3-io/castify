use std::sync::Arc;
use std::time::Instant;

use castify_auth::{AuthRepository, SessionSecret};
use castify_cache::DiskCache;
use castify_catalog::providers::dropbox::DropboxConfig;
use castify_catalog::providers::google_drive::GoogleDriveConfig;
use castify_catalog::providers::onedrive::OneDriveConfig;
use castify_catalog::{
    CatalogRepository, OAuthStateStore, Provider, ProviderFactory, ProviderRegistry, TokenKey,
};
use castify_core::Config;
use sqlx::SqlitePool;

use crate::shares::ShareRepository;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    config: Config,
    started_at: Instant,
    pool: SqlitePool,
    repository: AuthRepository,
    catalog_repository: CatalogRepository,
    share_repository: ShareRepository,
    oauth_store: OAuthStateStore,
    session_secret: SessionSecret,
    provider_registry: ProviderRegistry,
    /// Per-video coordination map for local source resolution (M8 Task 005).
    /// Dedupes concurrent downloads to `transcode-work/` for embedded-text
    /// extraction and burn-in transcoding. One entry per video ever resolved.
    local_source_registry: crate::local_source::LocalSourceRegistry,
    /// Hot-video disk cache (M4). `None` when `CASTIFY_VIDEO_CACHE_ENABLED=false`.
    /// When `Some`, the `/stream` handler tee's response bytes to disk and
    /// `get_stream_url` returns `Cached` strategy for cache hits.
    video_cache: Option<Arc<DiskCache>>,
    /// In-memory per-share failure counters for the unlock endpoint
    /// (docs/specs/sharing, task 004). Deliberately never persisted — a
    /// restart clears all lockouts.
    unlock_rate_limiter: crate::shares::ratelimit::UnlockRateLimiter,
    /// Runtime-editable transcode toggle (Settings page). Initialized from
    /// the `settings` table — falling back to the env-config default when
    /// the owner hasn't set it — and updated in place by
    /// `PUT /api/settings/transcode`. Held briefly; std RwLock is fine.
    transcode_enabled: std::sync::RwLock<bool>,
}

impl AppState {
    pub async fn new(
        config: Config,
        pool: SqlitePool,
        session_secret: SessionSecret,
        token_key: TokenKey,
    ) -> Self {
        let repository = AuthRepository::new(pool.clone());
        let catalog_repository = CatalogRepository::new(pool.clone(), token_key);
        let share_repository = ShareRepository::new(pool.clone());
        let oauth_store = OAuthStateStore::new();
        let provider_registry = ProviderRegistry::new(
            config.google_oauth.as_ref().map(|o| GoogleDriveConfig {
                client_id: o.client_id.clone(),
                client_secret: o.client_secret.clone(),
            }),
            config.dropbox_oauth.as_ref().map(|o| DropboxConfig {
                client_id: o.client_id.clone(),
                client_secret: o.client_secret.clone(),
            }),
            config.microsoft_oauth.as_ref().map(|o| OneDriveConfig {
                client_id: o.client_id.clone(),
                client_secret: o.client_secret.clone(),
            }),
        );
        let video_cache_enabled = config.video_cache.enabled;
        let video_cache_dir = config.video_cache.dir.clone();
        let video_cache_max_bytes = config.video_cache.max_bytes;
        let transcode_enabled = resolve_transcode_enabled(&pool, config.transcode.enabled).await;
        Self {
            inner: Arc::new(AppStateInner {
                config,
                started_at: Instant::now(),
                pool,
                repository,
                catalog_repository,
                share_repository,
                oauth_store,
                session_secret,
                provider_registry,
                local_source_registry: crate::local_source::LocalSourceRegistry::new(),
                video_cache: if video_cache_enabled {
                    match DiskCache::new(&video_cache_dir).await {
                        Ok(cache) => {
                            tracing::info!(
                                dir = %video_cache_dir.display(),
                                max_bytes = video_cache_max_bytes,
                                "video cache enabled"
                            );
                            Some(Arc::new(cache))
                        }
                        Err(e) => {
                            tracing::error!(
                                error = %e,
                                dir = %video_cache_dir.display(),
                                "failed to initialize video cache; feature disabled"
                            );
                            None
                        }
                    }
                } else {
                    None
                },
                unlock_rate_limiter: crate::shares::ratelimit::UnlockRateLimiter::new(),
                transcode_enabled: std::sync::RwLock::new(transcode_enabled),
            }),
        }
    }

    /// Whether server-side transcoding is currently active. The single
    /// decision point for every transcode gate — env config only provides
    /// the default; the Settings page owns the runtime value.
    pub fn transcode_enabled(&self) -> bool {
        *self
            .inner
            .transcode_enabled
            .read()
            .expect("transcode_enabled lock poisoned")
    }

    /// Update the runtime transcode toggle. Callers persist the value to
    /// the `settings` table first; this flips the in-memory flag.
    pub fn set_transcode_enabled(&self, enabled: bool) {
        *self
            .inner
            .transcode_enabled
            .write()
            .expect("transcode_enabled lock poisoned") = enabled;
    }

    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    pub fn started_at(&self) -> Instant {
        self.inner.started_at
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.inner.pool
    }

    pub fn repository(&self) -> &AuthRepository {
        &self.inner.repository
    }

    pub fn catalog_repository(&self) -> &CatalogRepository {
        &self.inner.catalog_repository
    }

    /// Shares persistence + membership checks (docs/specs/sharing).
    pub fn share_repository(&self) -> &ShareRepository {
        &self.inner.share_repository
    }

    pub fn oauth_store(&self) -> &OAuthStateStore {
        &self.inner.oauth_store
    }

    pub fn session_secret(&self) -> &SessionSecret {
        &self.inner.session_secret
    }

    /// The configured provider factories — the single dispatch point over the
    /// `Provider` enum. Handlers resolve a factory via
    /// `registry.factory_for(provider)` rather than `match provider {}`.
    pub fn provider_registry(&self) -> &ProviderRegistry {
        &self.inner.provider_registry
    }

    /// The hot-video disk cache (M4). `None` when the feature is disabled
    /// (`CASTIFY_VIDEO_CACHE_ENABLED=false`).
    pub fn video_cache(&self) -> Option<&Arc<DiskCache>> {
        self.inner.video_cache.as_ref()
    }

    /// In-memory unlock rate limiting (docs/specs/sharing). Per-share
    /// failure counters with a 15-minute cool-off; never persisted.
    pub fn unlock_rate_limiter(&self) -> &crate::shares::ratelimit::UnlockRateLimiter {
        &self.inner.unlock_rate_limiter
    }

    /// Per-video coordination map for local source resolution (M8 Task 005).
    pub fn local_source_registry(&self) -> &crate::local_source::LocalSourceRegistry {
        &self.inner.local_source_registry
    }

    /// Resolve a provider factory for the given provider. Under the `e2e`
    /// cargo feature this returns an `E2eMockFactory`; in production builds it
    /// delegates to the [`ProviderRegistry`]. Returns `None` when the provider
    /// is not configured (no OAuth credentials).
    ///
    /// GOTCHA: S3-compatible storage is the deliberate exception in the e2e
    /// build — it runs the REAL provider (s3-compatible-storage task 009).
    /// The browser suite connects through the real credentials form against
    /// the stack's MinIO service and must scan/stream with the real SDK
    /// client; the OAuth providers keep their mocks because CI cannot run
    /// a real OAuth round-trip.
    #[cfg(feature = "e2e")]
    pub fn factory_for(&self, provider: Provider) -> Option<Box<dyn ProviderFactory>> {
        if provider == Provider::S3Compatible {
            return self.inner.provider_registry.factory_for(provider);
        }
        Some(Box::new(crate::e2e::E2eMockFactory::new(provider)))
    }

    #[cfg(not(feature = "e2e"))]
    pub fn factory_for(&self, provider: Provider) -> Option<Box<dyn ProviderFactory>> {
        self.inner.provider_registry.factory_for(provider)
    }
}

/// Resolve the initial transcode toggle: the persisted `settings` value when
/// the owner has set one, else the env-config default. Read failures and
/// invalid stored values log a warning and fall back rather than blocking
/// startup.
async fn resolve_transcode_enabled(pool: &SqlitePool, default: bool) -> bool {
    use sqlx::Row;
    let value: Option<String> =
        sqlx::query("SELECT value FROM settings WHERE key = 'transcode_enabled'")
            .fetch_optional(pool)
            .await
            .map_err(|e| {
                tracing::warn!(
                    error = %e,
                    "failed to read transcode_enabled setting; using config default"
                );
                e
            })
            .ok()
            .flatten()
            .map(|row| row.get("value"));
    match value.as_deref() {
        Some("false") => false,
        Some("true") => true,
        Some(other) => {
            tracing::warn!(value = %other, "invalid transcode_enabled setting; using config default");
            default
        }
        None => default,
    }
}
