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
    CatalogRepository, Credential, NewConnection, NewTranscodeEntry, NewVideo, Provider,
    TokenBundle,
};

const PASSWORD: &str = "correct horse battery staple";

/// Unique-ish counter for test data isolation (mirrors the pattern in
/// `common/mod.rs` so multiple tests in one process don't collide).
static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1000);

fn next_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}",
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
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
    let data_dir =
        std::env::temp_dir().join(format!("castify-api-transcode-test-{}", next_id("dir")));
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
            dir: data_dir.join("transcode-cache"),
            ..Default::default()
        },
        abr: castify_core::AbrConfig::default(),
    };
    let state = AppState::new(config, pool, secret, token_key).await;
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
async fn csrf_request_parts(app: &axum::Router, session_cookie: &str) -> (String, String) {
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
        .oneshot(
            Request::builder()
                .uri("/api/csrf")
                .body(Body::empty())
                .unwrap(),
        )
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
        (
            app,
            cookie,
            state.catalog_repository().clone(),
            state.config().data_dir.clone(),
            _g,
        )
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

// ── M8 Task 009: burn_subtitles master-playlist routing ──────────────

use castify_api::transcode::DEFAULT_PROFILE;

/// Helper: seed an embedded subtitle track row for a video. Returns the
/// track id. `family` is `"image"` (burnable) or `"text"` (→ 400 if burn
/// is requested).
async fn seed_subtitle_track(
    repo: &CatalogRepository,
    video_id: &str,
    track_id: &str,
    embedded_index: i64,
    family: &str,
) {
    repo.upsert_subtitle_track(
        track_id,
        video_id,
        embedded_index,
        "pgssub",
        family,
        Some("eng"),
        Some("English"),
    )
    .await
    .unwrap();
}

/// Helper: create a fake `.ts` segment on disk at the handler's computed
/// output dir for `(video, variant, profile)` and seed a `completed`
/// manifest row. The on-disk segment makes `ensure_transcode_started`
/// short-circuit (it sees existing segments and returns without calling
/// the provider or spawning ffmpeg); the manifest row makes the variant
/// appear in `fetch_transcodes_for_video`.
async fn seed_completed_variant(
    repo: &CatalogRepository,
    transcode_dir: &std::path::Path,
    video_id: &str,
    variant: &str,
    profile: &str,
) {
    let dir = transcode_dir.join(video_id).join(variant).join(profile);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("segment_00000.ts"), b"fake-segment-bytes").unwrap();

    repo.insert_pending_transcode(&NewTranscodeEntry {
        video_id,
        variant,
        profile,
        output_dir: &dir.to_string_lossy(),
        segment_duration_secs: 10,
        bitrate: Some(3_000_000),
        width: Some(1280),
        height: Some(720),
    })
    .await
    .unwrap();
    repo.mark_transcode_completed(video_id, variant, profile, 1)
        .await
        .unwrap();
}

/// `GET /transcode/master.m3u8` without `?burn_subtitles=` must list only
/// unburned variants — even when a burned variant for the same video
/// coexists in the manifest. This is the M7 regression guard (FR-3.2,
/// FR-7.3): the burned entry must not leak into the default master.
#[tokio::test]
async fn master_without_burn_param_lists_unburned_variant_only() {
    let (app, cookie, repo, data_dir, _guard) = boot_with_transcode_enabled().await;
    let vid = seed_video(&repo).await;

    // Seed both an unburned and a burned 720p variant for the same video.
    let transcode_dir = data_dir.join("transcode-cache");
    let burn_profile = format!("{DEFAULT_PROFILE}+subs-vid-sub-img");
    seed_completed_variant(&repo, &transcode_dir, &vid, "720p", DEFAULT_PROFILE).await;
    seed_completed_variant(&repo, &transcode_dir, &vid, "720p", &burn_profile).await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/videos/{vid}/transcode/master.m3u8"))
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let playlist = String::from_utf8(bytes.to_vec()).unwrap();

    // Exactly one STREAM-INF (the unburned 720p variant).
    assert_eq!(
        playlist.matches("EXT-X-STREAM-INF").count(),
        1,
        "unburned master must list exactly one variant: {playlist}"
    );
    assert!(
        playlist.contains("720p/playlist.m3u8"),
        "unburned variant must appear: {playlist}"
    );
    // The burned profile suffix must NOT appear anywhere in the unburned
    // master — it's a separate stream.
    assert!(
        !playlist.contains("+subs-"),
        "burned profile leaked into unburned master: {playlist}"
    );
}

/// `GET /transcode/master.m3u8?burn_subtitles=<image-track>` must list the
/// burned variant. The handler validates the track is image-family,
/// ensures the burned transcode is started, and filters the manifest to
/// the burned profile (FR-3.1, FR-3.6).
#[tokio::test]
async fn master_with_burn_param_lists_burned_variant() {
    let (app, cookie, repo, data_dir, _guard) = boot_with_transcode_enabled().await;
    let vid = seed_video(&repo).await;

    let track_id = format!("{vid}-sub-img");
    seed_subtitle_track(&repo, &vid, &track_id, 3, "image").await;

    // Seed the burned variant so ensure_transcode_started short-circuits.
    let transcode_dir = data_dir.join("transcode-cache");
    let burn_profile = format!("{DEFAULT_PROFILE}+subs-{track_id}");
    seed_completed_variant(&repo, &transcode_dir, &vid, "720p", &burn_profile).await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/videos/{vid}/transcode/master.m3u8?burn_subtitles={track_id}"
                ))
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let playlist = String::from_utf8(bytes.to_vec()).unwrap();

    assert_eq!(
        playlist.matches("EXT-X-STREAM-INF").count(),
        1,
        "burned master must list exactly one variant: {playlist}"
    );
    assert!(
        playlist.contains("720p/playlist.m3u8"),
        "burned variant must appear: {playlist}"
    );
}

/// `?burn_subtitles=<text-track-id>` → 400. Text subtitles are served to
/// the browser; they cannot be burned (FR-3.1). The handler rejects before
/// touching the transcode pipeline.
#[tokio::test]
async fn master_burn_param_with_text_track_returns_400() {
    let (app, cookie, repo, _data_dir, _guard) = boot_with_transcode_enabled().await;
    let vid = seed_video(&repo).await;

    let track_id = format!("{vid}-sub-txt");
    seed_subtitle_track(&repo, &vid, &track_id, 1, "text").await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/videos/{vid}/transcode/master.m3u8?burn_subtitles={track_id}"
                ))
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

/// `?burn_subtitles=<nonexistent-id>` → 404. The track id doesn't exist
/// for this video (FR-3.1).
#[tokio::test]
async fn master_burn_param_with_missing_track_returns_404() {
    let (app, cookie, repo, _data_dir, _guard) = boot_with_transcode_enabled().await;
    let vid = seed_video(&repo).await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/videos/{vid}/transcode/master.m3u8?burn_subtitles=does-not-exist"
                ))
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// Burned and unburned variants for the same video coexist in
/// `transcode_cache_entries` (different profile strings) and both appear
/// in `fetch_transcodes_for_video` (FR-7.3). The master playlist routing
/// is what separates them — the storage layer holds both.
#[tokio::test]
async fn burned_and_unburned_coexist_in_manifest() {
    let (app, cookie, repo, data_dir, _guard) = boot_with_transcode_enabled().await;
    let vid = seed_video(&repo).await;

    let track_id = format!("{vid}-sub-img");
    seed_subtitle_track(&repo, &vid, &track_id, 2, "image").await;

    let transcode_dir = data_dir.join("transcode-cache");
    let burn_profile = format!("{DEFAULT_PROFILE}+subs-{track_id}");
    seed_completed_variant(&repo, &transcode_dir, &vid, "720p", DEFAULT_PROFILE).await;
    seed_completed_variant(&repo, &transcode_dir, &vid, "720p", &burn_profile).await;

    // Both rows are in the manifest.
    let entries = repo.fetch_transcodes_for_video(&vid).await.unwrap();
    assert_eq!(
        entries.len(),
        2,
        "both burned and unburned must coexist in manifest"
    );

    // Toggling the param selects the right variant each time — no
    // re-transcode happens (segments already on disk), and each master
    // lists exactly one variant.
    for (param, label) in [(None, "unburned"), (Some(&track_id), "burned")] {
        let uri = match param {
            None => format!("/api/videos/{vid}/transcode/master.m3u8"),
            Some(t) => format!("/api/videos/{vid}/transcode/master.m3u8?burn_subtitles={t}"),
        };
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&uri)
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "{label} master should be 200"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let playlist = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(
            playlist.matches("EXT-X-STREAM-INF").count(),
            1,
            "{label} master must list exactly one variant: {playlist}"
        );
    }
}

// ── Remux (transcode-controls task 004) ────────────────────────────────
//
// Remux = stream copy into HLS (no decode/encode). Three layers of proof:
// 1. A real H.264/AAC MKV fed through `start_transcode(remux = true)`
//    produces valid HLS (below).
// 2. The HTTP master-playlist path derives the `-remux` profile and serves
//    existing remux segments from disk without spawning ffmpeg (the
//    resume path — no provider is reachable in these tests).
// 3. A previously failed remux flips the derivation to the full-transcode
//    profile (fallback, spec FR-3 risk mitigation).

/// Generate a tiny real H.264/AAC MKV via the system ffmpeg.
async fn make_h264_aac_mkv(mkv_path: &std::path::Path) {
    let status = tokio::process::Command::new("ffmpeg")
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("testsrc=duration=2:size=160x120:rate=10")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("sine=frequency=440:duration=2")
        .arg("-map")
        .arg("0:v:0")
        .arg("-map")
        .arg("1:a:0")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("64k")
        .arg(mkv_path)
        .status()
        .await
        .expect("spawn ffmpeg (installed for probe/transcode tests)");
    assert!(
        status.success(),
        "ffmpeg failed to generate the MKV fixture"
    );
}

/// Poll a transcode handle until ffmpeg exits (bounded — these fixtures
/// are 2 seconds of video).
async fn wait_until_done(handle: &castify_api::transcode::TranscodeHandle) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !handle.state.is_done() {
        assert!(
            std::time::Instant::now() < deadline,
            "transcode did not finish within 30s"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn remux_produces_valid_hls_from_h264_aac_mkv() {
    let src = tempfile::tempdir().unwrap();
    let mkv_path = src.path().join("source.mkv");
    make_h264_aac_mkv(&mkv_path).await;

    let out_root = tempfile::tempdir().unwrap();
    let out_dir = out_root.path().join("remux");

    let bytes: Bytes = Bytes::from(tokio::fs::read(&mkv_path).await.unwrap());
    let stream: castify_catalog::BodyStream =
        Box::pin(futures::stream::once(async move { Ok(bytes) }));

    let handle = castify_api::transcode::start_transcode(
        Some(stream),
        out_dir.clone(),
        "source",
        1,
        None,
        true,
    )
    .await
    .expect("start remux transcode");

    wait_until_done(&handle).await;
    assert!(
        handle
            .state
            .completed
            .load(std::sync::atomic::Ordering::Relaxed),
        "remux ffmpeg must exit zero for a well-formed H.264/AAC MKV"
    );

    let segments = castify_api::transcode::count_segments(&out_dir).await;
    assert!(segments >= 1, "expected at least one .ts segment");
    let playlist = castify_api::transcode::read_playlist(&out_dir)
        .await
        .expect("playlist.m3u8 on disk");
    assert!(playlist.starts_with("#EXTM3U"), "playlist: {playlist}");
    assert!(
        playlist.contains("EXTINF"),
        "playlist must carry media durations: {playlist}"
    );
    assert!(
        playlist.contains(".ts"),
        "playlist must reference .ts segments: {playlist}"
    );
}

/// Seed a video whose codecs are browser-compatible but whose container
/// isn't (the AC-1 seeded-MKV shape), return its id. Transcode dir is
/// `{data_dir}/transcode-cache` (boot helper config).
async fn seed_remux_eligible_video(repo: &CatalogRepository) -> String {
    let vid = seed_video(repo).await;
    sqlx::query(
        "UPDATE videos SET mime_type = 'video/x-matroska', video_codec = 'h264', audio_codec = 'aac' WHERE id = ?",
    )
    .bind(&vid)
    .execute(repo.pool())
    .await
    .unwrap();
    vid
}

/// Pre-create remux segments on disk so `ensure_transcode_started` takes
/// the resume path (no ffmpeg, no provider). 1080p source → pre-compute
/// variant 720p.
fn plant_remux_segments(data_dir: &std::path::Path, vid: &str) -> std::path::PathBuf {
    let dir = data_dir
        .join("transcode-cache")
        .join(vid)
        .join("720p")
        .join(format!("{}-remux", castify_api::transcode::DEFAULT_PROFILE));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("segment_00000.ts"), b"fake-ts-bytes").unwrap();
    dir
}

async fn get_master(app: &axum::Router, cookie: &str, vid: &str) -> (StatusCode, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/videos/{vid}/transcode/master.m3u8"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

#[tokio::test]
async fn master_serves_remux_outputs_from_disk_and_reuses_them() {
    let (app, cookie, repo, data_dir, _guard) = boot_with_transcode_enabled().await;
    let vid = seed_remux_eligible_video(&repo).await;
    let remux_dir = plant_remux_segments(&data_dir, &vid);

    // First master request: the resume path seeds a completed `-remux`
    // manifest row from the on-disk segments and builds the playlist —
    // no ffmpeg, no provider access (neither is reachable here).
    let (status, playlist) = get_master(&app, &cookie, &vid).await;
    assert_eq!(status, StatusCode::OK, "playlist: {playlist}");
    assert!(
        playlist.contains("720p/playlist.m3u8"),
        "master must list the 720p variant: {playlist}"
    );

    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT profile, status FROM transcode_cache_entries WHERE video_id = ?")
            .bind(&vid)
            .fetch_all(repo.pool())
            .await
            .unwrap();
    assert_eq!(rows.len(), 1, "exactly one manifest row: {rows:?}");
    assert_eq!(
        rows[0],
        (
            format!("{}-remux", castify_api::transcode::DEFAULT_PROFILE),
            "completed".into()
        ),
        "the row must carry the -remux profile: {rows:?}"
    );
    assert!(
        rows[0]
            .0
            .starts_with(castify_api::transcode::DEFAULT_PROFILE),
        "sanity"
    );
    let _ = remux_dir;

    // Second request: served from the same cache row — no second job.
    let (status, playlist) = get_master(&app, &cookie, &vid).await;
    assert_eq!(status, StatusCode::OK, "playlist: {playlist}");
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM transcode_cache_entries WHERE video_id = ?")
            .bind(&vid)
            .fetch_one(repo.pool())
            .await
            .unwrap();
    assert_eq!(count, 1, "second request must not create a new row");
}

#[tokio::test]
async fn failed_remux_row_falls_back_to_full_transcode_profile() {
    let (app, cookie, repo, data_dir, _guard) = boot_with_transcode_enabled().await;
    let vid = seed_remux_eligible_video(&repo).await;
    let remux_dir = plant_remux_segments(&data_dir, &vid);

    // A previous remux attempt failed (odd-MKV case). The on-disk remux
    // segments must now be dead weight: the derivation drops `-remux` and
    // the request starts down the full-transcode path instead (which
    // fails here only because no provider is reachable).
    repo.insert_pending_transcode(&NewTranscodeEntry {
        video_id: &vid,
        variant: "720p",
        profile: &format!("{}-remux", castify_api::transcode::DEFAULT_PROFILE),
        output_dir: &remux_dir.to_string_lossy(),
        segment_duration_secs: 10,
        bitrate: None,
        width: None,
        height: None,
    })
    .await
    .unwrap();
    repo.mark_transcode_failed(
        &vid,
        "720p",
        &format!("{}-remux", castify_api::transcode::DEFAULT_PROFILE),
        "remux exited non-zero",
    )
    .await
    .unwrap();

    let (status, _playlist) = get_master(&app, &cookie, &vid).await;
    assert_ne!(
        status,
        StatusCode::OK,
        "must NOT serve the remux segments after a failed remux"
    );

    // The full-transcode path was taken: a pending manifest row carrying
    // the base profile exists (inserted before ffmpeg/provider startup).
    let profiles: Vec<String> =
        sqlx::query_scalar("SELECT profile FROM transcode_cache_entries WHERE video_id = ?")
            .bind(&vid)
            .fetch_all(repo.pool())
            .await
            .unwrap();
    assert!(
        profiles.contains(&castify_api::transcode::DEFAULT_PROFILE.to_string()),
        "fallback must derive the full-transcode profile: {profiles:?}"
    );
}
