use std::sync::Arc;
use std::time::Instant;

use castify_auth::{AuthRepository, SessionSecret};
use castify_core::Config;
use dashmap::DashMap;
use sqlx::SqlitePool;
use uuid::Uuid;
use webauthn_rs::prelude::{SecurityKeyAuthentication, SecurityKeyRegistration};
use webauthn_rs::Webauthn;

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
    webauthn: Webauthn,
    /// In-progress passkey registrations keyed by the candidate owner id.
    /// Fine for M0: we have a single owner, and registrations complete within
    /// the WebAuthn timeout window (default 5 minutes).
    pending_registrations: DashMap<Uuid, SecurityKeyRegistration>,
    /// In-progress passkey authentications (login) keyed by a fresh
    /// `auth_request_id` issued by the begin endpoint. Single-use: the entry
    /// is removed on finish (success or failure) to prevent replay.
    pending_authentications: DashMap<Uuid, SecurityKeyAuthentication>,
}

impl AppState {
    pub fn new(
        config: Config,
        pool: SqlitePool,
        session_secret: SessionSecret,
        webauthn: Webauthn,
    ) -> Self {
        let repository = AuthRepository::new(pool.clone());
        Self {
            inner: Arc::new(AppStateInner {
                config,
                started_at: Instant::now(),
                pool,
                repository,
                session_secret,
                webauthn,
                pending_registrations: DashMap::new(),
                pending_authentications: DashMap::new(),
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

    pub fn webauthn(&self) -> &Webauthn {
        &self.inner.webauthn
    }

    pub fn pending_registrations(&self) -> &DashMap<Uuid, SecurityKeyRegistration> {
        &self.inner.pending_registrations
    }

    pub fn pending_authentications(&self) -> &DashMap<Uuid, SecurityKeyAuthentication> {
        &self.inner.pending_authentications
    }
}
