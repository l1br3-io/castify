use castify_api::app::build_app;
use castify_api::state::AppState;
use castify_core::Config;
use castify_storage::{connect, run_migrations};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::TempPath;

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Build a fully wired AppState backed by a fresh on-disk SQLite database.
/// Returns the state and the TempPath keeping the db file alive (caller must
/// hold both for the test's lifetime).
pub async fn fresh_state() -> (AppState, TempPath, PathBuf) {
    let named = tempfile::NamedTempFile::new().unwrap().into_temp_path();
    let path: PathBuf = named.to_path_buf();
    let pool: SqlitePool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let secret = castify_auth::SessionSecret::resolve(&pool, None)
        .await
        .unwrap();
    let data_dir = std::env::temp_dir().join(format!(
        "castify-api-test-{}",
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&data_dir).ok();
    let config = Config {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        log_level: "warn".to_string(),
        data_dir: data_dir.clone(),
        database_path: path.clone(),
    };
    let state = AppState::new(config, pool, secret);
    (state, named, path)
}

#[allow(dead_code)]
pub async fn fresh_app() -> axum::Router {
    let (state, _guard, _path) = fresh_state().await;
    build_app(state)
}
