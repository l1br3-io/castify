use std::sync::Arc;
use std::time::Instant;

use castify_auth::{AuthRepository, SessionSecret};
use castify_catalog::{CatalogRepository, OAuthStateStore, TokenKey};
use castify_core::Config;
use sqlx::SqlitePool;

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
    oauth_store: OAuthStateStore,
    session_secret: SessionSecret,
}

impl AppState {
    pub fn new(
        config: Config,
        pool: SqlitePool,
        session_secret: SessionSecret,
        token_key: TokenKey,
    ) -> Self {
        let repository = AuthRepository::new(pool.clone());
        let catalog_repository = CatalogRepository::new(pool.clone(), token_key);
        let oauth_store = OAuthStateStore::new();
        Self {
            inner: Arc::new(AppStateInner {
                config,
                started_at: Instant::now(),
                pool,
                repository,
                catalog_repository,
                oauth_store,
                session_secret,
            }),
        }
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

    pub fn oauth_store(&self) -> &OAuthStateStore {
        &self.inner.oauth_store
    }

    pub fn session_secret(&self) -> &SessionSecret {
        &self.inner.session_secret
    }
}
