//! Integration tests for M7 transcode admin + cancellation routes.
//!
//! These tests don't actually run ffmpeg — they verify the HTTP contract
//! (route registered, JSON shape, status codes, manifest interaction).
//! Full lifecycle coverage (real ffmpeg + hls.js + ABR switching) is
//! manual verification, matching the M3.5 streaming-audit pattern.

mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use castify_catalog::{
    CatalogRepository, NewConnection, NewTranscodeEntry, NewVideo, Provider, TokenBundle,
};

const PASSWORD: &str = "correct horse battery staple";

/// Unique-ish counter for test data isolation (mirrors the pattern in
/// `common/mod.rs` so multiple tests in one process don't collide).
static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1000);

fn next_id(prefix: &str) -> String {
    format!("{prefix}-{}", COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

/// Same shape as `common::fresh_state` but with `transcode.enabled = true`
/// so the admin + cancel routes don't short-circuit to 404.
async fn boot_with_transcode_enabled() -> (
    axum::Router,
    String,
    CatalogRepository,
    std::path::PathBuf,
    tempfile::TempPath,
) {
    use castify_api::app::build_app;
    use castify_api::state::AppState;
    use castify_core::Config;
    use castify_storage::{connect, run_migrations};
    use sqlx::SqlitePool;

    let named = tempfile::NamedTempFile::new().unwrap().into_temp_path();
    let path = named.to_path_buf();
    let pool: SqlitePool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let secret = castify_auth::SessionSecret::resolve(&pool, None)
        .await
        .unwrap();
    let token_key = castify_catalog::TokenKey::resolve(&pool, None)
        .await
        .unwrap();
    let data_dir = std::env::temp_dir().join(format!(
        "castify-api-transcode-test-{}",
        next_id("dir")
    ));
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
            enabled: false,
            max_bytes: 0,
            dir: data_dir.join("video-cache"),
        },
        probe: castify_core::ProbeConfig::default(),
        transcode: castify_core::TranscodeConfig {
            enabled: true,
            ..Default::default()
        },
        abr: castify_core::AbrConfig::default(),
    };
    let state = AppState::new(config, pool, secret, token_key);
    let repo = state.catalog_repository().clone();
    let app = build_app(state);

    // Run the setup wizard so the test has a valid session cookie.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    serde_json::json!({"display_name":"Jane","password":PASSWORD}).to_string(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .expect("session cookie");
    (app, cookie, repo, data_dir, named)
}

async fn seed_video(repo: &CatalogRepository) -> String {
    let conn = repo
        .create_connection(&NewConnection {
            provider: Provider::GoogleDrive,
            token_bundle: TokenBundle {
                access_token: "ya29.test".into(),
                refresh_token: Some("refresh".into()),
                expires_at: None,
                token_type: "Bearer".into(),
                scope: None,
            },
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
    let row: (String,) = sqlx::query_as("SELECT id FROM videos WHERE provider_file_id = ?")
        .bind(&provider_file_id)
        .fetch_one(repo.pool())
        .await
        .unwrap();
    row.0
}

async fn fetch_csrf(app: &axum::Router, session_cookie: &str) -> (String, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/csrf")
                .header("cookie", session_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let csrf_cookie = response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').find(|c| c.starts_with("castify_csrf=")))
        .unwrap()
        .to_string();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let token = body["token"].as_str().unwrap().to_string();
    (token, csrf_cookie)
}

/// Build the cookie + header pair needed for a CSRF-protected mutation.
/// Combines the session cookie with the CSRF cookie in a single Cookie
/// header, and returns the matching X-CSRF-Token value.
async fn csrf_request_parts(
    app: &axum::Router,
    session_cookie: &str,
) -> (String, String) {
    let (token, csrf_cookie) = fetch_csrf(app, session_cookie).await;
    let cookies = format!("{session_cookie}; {csrf_cookie}");
    (token, cookies)
}

#[tokio::test]
async fn get_transcode_admin_returns_empty_when_nothing_cached() {
    let (app, cookie, _repo, _data_dir, _guard) = boot_with_transcode_enabled().await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/admin/transcode")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["enabled"], true);
    assert!(body["variants"].is_array());
    assert_eq!(body["variants"].as_array().unwrap().len(), 0);
    assert_eq!(body["pool"]["active_workers"], 0);
    assert!(body["configured_ladder"].is_array());
    // Default ladder is the full set.
    let ladder = body["configured_ladder"].as_array().unwrap();
    let names: Vec<&str> = ladder.iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(names, vec!["360p", "480p", "720p", "1080p"]);
}

#[tokio::test]
async fn get_transcode_admin_reports_stats_per_rung_after_manifest_writes() {
    let (app, cookie, repo, data_dir, _guard) = boot_with_transcode_enabled().await;
    let vid1 = seed_video(&repo).await;
    let vid2 = seed_video(&repo).await;

    // Seed two completed 720p variants.
    let out_dir1 = data_dir.join(&vid1).join("720p").join("prof");
    let out_dir2 = data_dir.join(&vid2).join("720p").join("prof");
    std::fs::create_dir_all(&out_dir1).unwrap();
    std::fs::create_dir_all(&out_dir2).unwrap();

    repo.insert_pending_transcode(&NewTranscodeEntry {
        video_id: &vid1,
        variant: "720p",
        profile: "prof",
        output_dir: &out_dir1.to_string_lossy(),
        segment_duration_secs: 10,
        bitrate: Some(3_000_000),
        width: Some(1280),
        height: Some(720),
    })
    .await
    .unwrap();
    repo.mark_transcode_completed(&vid1, "720p", "prof", 10)
        .await
        .unwrap();

    repo.insert_pending_transcode(&NewTranscodeEntry {
        video_id: &vid2,
        variant: "720p",
        profile: "prof",
        output_dir: &out_dir2.to_string_lossy(),
        segment_duration_secs: 10,
        bitrate: Some(3_000_000),
        width: Some(1280),
        height: Some(720),
    })
    .await
    .unwrap();
    repo.mark_transcode_completed(&vid2, "720p", "prof", 10)
        .await
        .unwrap();

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/admin/transcode")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let variants = body["variants"].as_array().unwrap();
    assert_eq!(variants.len(), 1, "only 720p rung present");
    assert_eq!(variants[0]["variant"], "720p");
    assert_eq!(variants[0]["cached_count"], 2);
    assert_eq!(variants[0]["in_progress_count"], 0);
    assert_eq!(variants[0]["failed_count"], 0);
    // 2 * 3_000_000 bps * 10 segs * 10 sec / 8 = 75_000_000 bytes.
    assert_eq!(variants[0]["total_bytes"], 75_000_000);
}

#[tokio::test]
async fn cancel_transcode_returns_204_when_nothing_running() {
    // Idempotent: no active transcodes → still 204 so the client can retry.
    let (app, cookie, repo, _data_dir, _guard) = boot_with_transcode_enabled().await;
    let vid = seed_video(&repo).await;
    let (csrf, cookies) = csrf_request_parts(&app, &cookie).await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/videos/{vid}/transcode"))
                .header("cookie", &cookies)
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn cancel_transcode_returns_204_leaves_manifest_untouched_when_no_active_worker() {
    // Cancel is keyed off the in-process registry of active ffmpeg handles.
    // A manifest row without a running worker is "completed data we can
    // later evict," not "in-flight work to cancel." So cancel returns 204
    // (idempotent) but doesn't touch the manifest row. Marking rows failed
    // only happens for genuinely-running transcodes (verified manually —
    // testing it here would require a real ffmpeg).
    let (app, cookie, repo, data_dir, _guard) = boot_with_transcode_enabled().await;
    let vid = seed_video(&repo).await;
    let out_dir = data_dir.join(&vid).join("720p").join("prof");
    std::fs::create_dir_all(&out_dir).unwrap();

    repo.insert_pending_transcode(&NewTranscodeEntry {
        video_id: &vid,
        variant: "720p",
        profile: "prof",
        output_dir: &out_dir.to_string_lossy(),
        segment_duration_secs: 10,
        bitrate: Some(3_000_000),
        width: Some(1280),
        height: Some(720),
    })
    .await
    .unwrap();
    repo.mark_transcode_in_progress(&vid, "720p", "prof")
        .await
        .unwrap();

    let (csrf, cookies) = csrf_request_parts(&app, &cookie).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/videos/{vid}/transcode"))
                .header("cookie", &cookies)
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    // No active worker → row stays in_progress.
    let entry = repo
        .fetch_transcode_entry(&vid, "720p", "prof")
        .await
        .unwrap()
        .expect("row present");
    assert_eq!(entry.status, "in_progress");
}

#[tokio::test]
async fn cancel_transcode_404_when_disabled() {
    // Boot with transcode disabled (the default test fixture).
    let (state, guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let csrf = app
        .clone()
        .oneshot(Request::builder().uri("/api/csrf").body(Body::empty()).unwrap())
        .await
        .unwrap();
    // No session needed — the route short-circuits before auth for disabled
    // transcode (actually it short-circuits inside the handler after auth,
    // so let's also setup a session to keep the test honest).
    let _ = csrf;
    let _ = guard;

    // The handler returns NotFound when transcode.enabled = false. Without
    // auth this would also 401; either way we're not 204. We test by setting
    // up auth properly.
    let (app, cookie, _repo, _data_dir, _guard2) = {
        let (state, _g, _p) = common::fresh_state().await;
        let app = castify_api::app::build_app(state.clone());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/setup")
                    .header("content-type", "application/json")
                    .body(Body::from(Bytes::from(
                        serde_json::json!({"display_name":"Jane","password":PASSWORD}).to_string(),
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        let cookie = response
            .headers()
            .get(axum::http::header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(';').next())
            .map(|s| s.to_string())
            .unwrap();
        (app, cookie, state.catalog_repository().clone(), state.config().data_dir.clone(), _g)
    };
    let vid = seed_video(&_repo).await;
    let (csrf, cookies) = csrf_request_parts(&app, &cookie).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/videos/{vid}/transcode"))
                .header("cookie", &cookies)
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
