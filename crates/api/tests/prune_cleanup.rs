//! Integration tests for catalog-prune disk-artifact cleanup (task 006).
//!
//! The catalog layer proves the pruning scan itself (see scanner tests);
//! these tests prove the api-layer half of the plan decision "repo owns
//! rows, api layer owns bytes": after a prune, transcode output dirs and
//! hot-cache files must not outlive their video rows.

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use castify_catalog::{
    CatalogRepository, Credential, NewConnection, NewTranscodeEntry, NewVideo, Provider,
    TokenBundle,
};

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(5000);

fn next_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}",
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

/// Boot with video cache enabled so the DiskCache bytes path is real, and
/// return the AppState alongside the app — the cleanup helper hangs off
/// state, not a route.
async fn boot_with_caches() -> (
    axum::Router,
    castify_api::state::AppState,
    CatalogRepository,
    std::path::PathBuf,
    tempfile::TempDir,
) {
    use castify_api::app::build_app;
    use castify_api::state::AppState;
    use castify_core::Config;
    use castify_storage::{connect, run_migrations};
    use sqlx::SqlitePool;

    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("db.sqlite3");
    let pool: SqlitePool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let secret = castify_auth::SessionSecret::resolve(&pool, None)
        .await
        .unwrap();
    let token_key = castify_catalog::TokenKey::resolve(&pool, None)
        .await
        .unwrap();
    let data_dir = dir.path().join("data");
    std::fs::create_dir_all(&data_dir).ok();
    let config = Config {
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
            enabled: true,
            max_bytes: 1024 * 1024 * 1024,
            dir: data_dir.join("video-cache"),
        },
        probe: castify_core::ProbeConfig::default(),
        transcode: castify_core::TranscodeConfig {
            enabled: true,
            dir: data_dir.join("transcode-cache"),
            ..Default::default()
        },
        abr: castify_core::AbrConfig::default(),
        prune: castify_core::PruneConfig::default(),
    };
    let state = AppState::new(config, pool, secret, token_key).await;
    let repo = state.catalog_repository().clone();
    let app = build_app(state.clone());

    // Session bootstrap (unused by the cleanup call itself, but keeps the
    // boot shape identical to the other test files).
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    serde_json::json!({"display_name":"Jane","password":"correct horse battery staple"}).to_string(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    (app, state, repo, data_dir, dir)
}

/// Seed a connection + video; returns (connection_id, video_id).
async fn seed_video(repo: &CatalogRepository) -> (String, String) {
    let conn = repo
        .create_connection(&NewConnection {
            provider: Provider::GoogleDrive,
            credential: Credential::OAuth(TokenBundle {
                access_token: "ya29.test".into(),
                refresh_token: Some("refresh".into()),
                expires_at: None,
                token_type: "Bearer".into(),
                scope: None,
            }),
            provider_account_id: Some(next_id("acct")),
            provider_account_email: None,
        })
        .await
        .unwrap();
    let provider_file_id = next_id("file");
    repo.upsert_video(
        &conn.id,
        Provider::GoogleDrive,
        &NewVideo {
            provider_file_id: provider_file_id.clone(),
            name: "test.mp4".into(),
            path: None,
            size_bytes: 1_000_000,
            mime_type: Some("video/mp4".into()),
            duration_ms: Some(60_000),
            width: Some(1920),
            height: Some(1080),
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        },
    )
    .await
    .unwrap();
    let video_id: String = sqlx::query_scalar("SELECT id FROM videos WHERE provider_file_id = ?")
        .bind(&provider_file_id)
        .fetch_one(repo.pool())
        .await
        .unwrap();
    (conn.id, video_id)
}

/// A pruning scan removes rows AND bytes; a surviving video keeps both.
#[tokio::test]
async fn pruned_video_loses_disk_artifacts_survivor_keeps_its_own() {
    let (_app, state, repo, data_dir, _guard) = boot_with_caches().await;

    let (_conn_a, doomed) = seed_video(&repo).await;
    let (_conn_b, survivor) = seed_video(&repo).await;

    // Completed transcode entry + real output dir with segments for both.
    let mut output_dirs = std::collections::HashMap::new();
    for (label, vid) in [("doomed", &doomed), ("survivor", &survivor)] {
        let out_dir = data_dir.join(format!("transcode-{label}"));
        std::fs::create_dir_all(&out_dir).unwrap();
        std::fs::write(out_dir.join("seg0.ts"), b"bytes").unwrap();
        repo.insert_pending_transcode(&NewTranscodeEntry {
            video_id: vid,
            variant: "720p",
            profile: "h264",
            output_dir: &out_dir.to_string_lossy(),
            segment_duration_secs: 10,
            bitrate: Some(3_000_000),
            width: Some(1280),
            height: Some(720),
        })
        .await
        .unwrap();
        repo.mark_transcode_completed(vid, "720p", "h264", 1)
            .await
            .unwrap();
        output_dirs.insert(label, out_dir);
    }

    // Hot-cache manifest row + real cached bytes for both.
    let cache = state.video_cache().expect("video cache enabled");
    for (vid, conn) in [(&doomed, &_conn_a), (&survivor, &_conn_b)] {
        cache.put_bytes(vid, b"cached-bytes").await.unwrap();
        let file_id: String =
            sqlx::query_scalar("SELECT provider_file_id FROM videos WHERE id = ?")
                .bind(vid)
                .fetch_one(repo.pool())
                .await
                .unwrap();
        repo.upsert_video_cache_entry(vid, conn, &file_id, 12)
            .await
            .unwrap();
    }

    // Simulate the prune a completed grace-1 scan performs (the catalog
    // scanner tests prove that half): tombstone + delete the doomed row.
    let now = "2026-02-02T00:00:00Z";
    let pool = repo.pool().clone();
    sqlx::query("UPDATE videos SET missing_scan_count = 1, missing_since = ? WHERE id = ?")
        .bind(now)
        .bind(&doomed)
        .execute(&pool)
        .await
        .unwrap();
    let pruned = repo.prune_missing_videos(&_conn_a, 1).await.unwrap();
    assert_eq!(pruned.video_ids, vec![doomed.clone()], "doomed row pruned");
    assert_eq!(
        pruned.transcode_output_dirs.len(),
        1,
        "output dir captured before the cascade ate the manifest row"
    );

    castify_api::routes::connections::cleanup_pruned_video_artifacts(&state, &pruned).await;

    // Doomed: transcode row + dir gone, cache manifest + bytes gone.
    assert!(
        repo.fetch_transcodes_for_video(&doomed)
            .await
            .unwrap()
            .is_empty(),
        "transcode rows cascade with the pruned video"
    );
    assert!(
        !output_dirs["doomed"].exists(),
        "pruned video's transcode output dir removed"
    );
    assert!(
        repo.fetch_video_cache_entry(&doomed)
            .await
            .unwrap()
            .is_none(),
        "cache manifest row removed"
    );
    assert!(
        !cache.bytes_path(&doomed).unwrap().exists(),
        "cached bytes removed"
    );

    // Survivor: everything intact.
    assert_eq!(
        repo.fetch_transcodes_for_video(&survivor)
            .await
            .unwrap()
            .len(),
        1,
        "survivor keeps its transcode row"
    );
    assert!(
        output_dirs["survivor"].exists(),
        "survivor keeps its output dir"
    );
    assert!(cache.bytes_path(&survivor).unwrap().exists());
}

/// Cleanup is best-effort: unknown ids / missing dirs never panic or error.
#[tokio::test]
async fn cleanup_of_unknown_ids_is_a_no_op() {
    let (_app, state, _repo, _data_dir, _guard) = boot_with_caches().await;
    castify_api::routes::connections::cleanup_pruned_video_artifacts(
        &state,
        &castify_catalog::PruneResult {
            video_ids: vec!["no-such-video".to_string()],
            transcode_output_dirs: vec![],
        },
    )
    .await;
}
