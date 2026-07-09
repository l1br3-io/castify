use std::sync::Arc;
use std::time::Instant;

use castify_auth::{AuthRepository, SessionSecret};
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
    session_secret: SessionSecret,
}

impl AppState {
    pub fn new(config: Config, pool: SqlitePool, session_secret: SessionSecret) -> Self {
        let repository = AuthRepository::new(pool.clone());
        Self {
            inner: Arc::new(AppStateInner {
                config,
                started_at: Instant::now(),
                pool,
                repository,
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

    pub fn session_secret(&self) -> &SessionSecret {
        &self.inner.session_secret
    }
}
