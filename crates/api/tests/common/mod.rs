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
    fresh_state_with(|_| {}).await
}

/// [`fresh_state`] with config tweaks applied before the `AppState` is
/// constructed (e.g. enabling transcode for a share-mirror test that needs
/// the codec-override branch of `/stream-url`).
pub async fn fresh_state_with(
    configure: impl FnOnce(&mut Config),
) -> (AppState, TempPath, PathBuf) {
    let named = tempfile::NamedTempFile::new().unwrap().into_temp_path();
    let path: PathBuf = named.to_path_buf();
    let pool: SqlitePool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let secret = castify_auth::SessionSecret::resolve(&pool, None)
        .await
        .unwrap();
    let token_key = castify_catalog::TokenKey::resolve(&pool, None)
        .await
        .unwrap();
    let data_dir = std::env::temp_dir().join(format!(
        "castify-api-test-{}",
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&data_dir).ok();
    let mut config = Config {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        log_level: "warn".to_string(),
        data_dir: data_dir.clone(),
        database_path: path.clone(),
        app_base_url: None,
        cookie_secure: false,
        google_oauth: None,
        dropbox_oauth: None,
        microsoft_oauth: None,
        video_cache: castify_core::VideoCacheConfig {
            enabled: false,
            max_bytes: 0,
            dir: data_dir.join("video-cache"),
        },
        probe: castify_core::ProbeConfig::default(),
        transcode: castify_core::TranscodeConfig {
            enabled: false,
            ..Default::default()
        },
        abr: castify_core::AbrConfig::default(),
    };
    configure(&mut config);
    let state = AppState::new(config, pool, secret, token_key);
    (state, named, path)
}

/// Build a fully wired app backed by a fresh on-disk SQLite database.
/// Returns the router and the `TempPath` guard keeping the db file alive.
/// Callers MUST hold the guard for the test's lifetime: dropping it unlinks
/// the db file, and because the pool opens connections lazily with
/// `create_if_missing(true)`, a later connection would re-open the path and
/// create a brand-new empty database (no tables) — surfacing as 500s.
#[allow(dead_code)]
pub async fn fresh_app() -> (axum::Router, TempPath) {
    let (state, guard, _path) = fresh_state().await;
    (build_app(state), guard)
}
