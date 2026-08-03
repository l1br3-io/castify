mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use castify_catalog::{CatalogRepository, NewConnection, NewVideo, Provider, TokenBundle};

const PASSWORD: &str = "correct horse battery staple";

async fn boot_and_setup_full() -> (
    axum::Router,
    String,
    CatalogRepository,
    std::path::PathBuf,
    tempfile::TempPath,
) {
    let (state, guard, _path) = common::fresh_state().await;
    let data_dir = state.config().data_dir.clone();
    let repo = state.catalog_repository().clone();
    let app = castify_api::app::build_app(state);
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
    (app, cookie, repo, data_dir, guard)
}

async fn boot_and_setup() -> (axum::Router, String, CatalogRepository, tempfile::TempPath) {
    let (app, cookie, repo, _dir, guard) = boot_and_setup_full().await;
    (app, cookie, repo, guard)
}

async fn get_json(app: axum::Router, uri: &str, cookie: Option<&str>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method("GET").uri(uri);
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    let response = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

async fn get_thumbnail_bytes(
    app: axum::Router,
    uri: &str,
    cookie: Option<&str>,
) -> (StatusCode, Vec<u8>, Option<String>) {
    let mut builder = Request::builder().method("GET").uri(uri);
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    let response = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec(), content_type)
}

fn sample_bundle() -> TokenBundle {
    TokenBundle {
        access_token: "ya29.test".into(),
        refresh_token: Some("refresh".into()),
        expires_at: None,
        token_type: "Bearer".into(),
        scope: None,
    }
}

#[tokio::test]
async fn empty_catalog_returns_empty_page() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, body) = get_json(app, "/api/videos", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 0);
    assert!(body["videos"].is_array());
    assert_eq!(body["videos"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = get_json(app, "/api/videos", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn returns_videos_with_pagination() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;

    let conn = repo
        .create_connection(&NewConnection {
            provider: Provider::GoogleDrive,
            token_bundle: sample_bundle(),
            provider_account_id: Some("acct-1".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();

    for i in 0..5 {
        repo.upsert_video(
            &conn.id,
            Provider::GoogleDrive,
            &NewVideo {
                provider_file_id: format!("file-{i}"),
                name: format!("video-{i}.mp4"),
                path: None,
                size_bytes: 1000 * (i + 1),
                mime_type: Some("video/mp4".into()),
                duration_ms: None,
                width: None,
                height: None,
                native_hash: None,
                native_hash_algo: None,
                provider_modified_at: None,
            },
        )
        .await
        .unwrap();
    }

    let (status, body) = get_json(app, "/api/videos?limit=3", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 5);
    assert_eq!(body["limit"], 3);
    assert_eq!(body["videos"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn dedup_groups_duplicates() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;

    let conn1 = repo
        .create_connection(&NewConnection {
            provider: Provider::GoogleDrive,
            token_bundle: sample_bundle(),
            provider_account_id: Some("a1".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();
    let conn2 = repo
        .create_connection(&NewConnection {
            provider: Provider::Dropbox,
            token_bundle: sample_bundle(),
            provider_account_id: Some("a2".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();

    // conn1 and conn2 have no videos yet — seed some
    for (conn_id, provider, file_id) in [
        (&conn1.id, Provider::GoogleDrive, "gd-file-1"),
        (&conn2.id, Provider::Dropbox, "db-file-1"),
    ] {
        repo.upsert_video(
            conn_id,
            provider,
            &NewVideo {
                provider_file_id: file_id.into(),
                name: "same-video.mp4".into(),
                path: None,
                size_bytes: 9999,
                mime_type: Some("video/mp4".into()),
                duration_ms: None,
                width: None,
                height: None,
                native_hash: None,
                native_hash_algo: None,
                provider_modified_at: None,
            },
        )
        .await
        .unwrap();
    }

    // Set the same dedup group on both videos.
    let vids1 = repo.fetch_unhashed_videos(&conn1.id, 0).await.unwrap();
    let vids2 = repo.fetch_unhashed_videos(&conn2.id, 0).await.unwrap();
    repo.update_video_dedup(&vids1[0].0, "hashabc", "hashabc:9999")
        .await
        .unwrap();
    repo.update_video_dedup(&vids2[0].0, "hashabc", "hashabc:9999")
        .await
        .unwrap();

    let (status, body) = get_json(app, "/api/videos", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1, "two copies should dedup to one entry");
    assert_eq!(body["videos"][0]["sources"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn provider_filter_works() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;

    let conn1 = repo
        .create_connection(&NewConnection {
            provider: Provider::GoogleDrive,
            token_bundle: sample_bundle(),
            provider_account_id: Some("a1".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();
    let conn2 = repo
        .create_connection(&NewConnection {
            provider: Provider::Dropbox,
            token_bundle: sample_bundle(),
            provider_account_id: Some("a2".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();

    repo.upsert_video(
        &conn1.id,
        Provider::GoogleDrive,
        &NewVideo {
            provider_file_id: "gd-1".into(),
            name: "drive-video.mp4".into(),
            path: None,
            size_bytes: 500,
            mime_type: None,
            duration_ms: None,
            width: None,
            height: None,
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        },
    )
    .await
    .unwrap();

    repo.upsert_video(
        &conn2.id,
        Provider::Dropbox,
        &NewVideo {
            provider_file_id: "db-1".into(),
            name: "dropbox-video.mp4".into(),
            path: None,
            size_bytes: 600,
            mime_type: None,
            duration_ms: None,
            width: None,
            height: None,
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        },
    )
    .await
    .unwrap();

    let (status, body) = get_json(app, "/api/videos?provider=google_drive", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1);
    assert_eq!(body["videos"][0]["provider"], "google_drive");
}

// ── Helpers for T3 enrichment tests ──────────────────────────────────

/// Fetch the single owner id created by `boot_and_setup`.
async fn owner_id(repo: &CatalogRepository) -> String {
    sqlx::query_scalar("SELECT id FROM owners LIMIT 1")
        .fetch_one(repo.pool())
        .await
        .unwrap()
}

/// Seed a video with full metadata and return its row id.
#[allow(clippy::too_many_arguments)]
async fn seed_full_video(
    repo: &CatalogRepository,
    conn_id: &str,
    provider: Provider,
    file_id: &str,
    name: &str,
    path: Option<&str>,
    duration_ms: Option<i64>,
    height: Option<i64>,
) -> String {
    repo.upsert_video(
        conn_id,
        provider,
        &NewVideo {
            provider_file_id: file_id.into(),
            name: name.into(),
            path: path.map(str::to_string),
            size_bytes: 10_000,
            mime_type: Some("video/mp4".into()),
            duration_ms,
            width: height.map(|h| h * 16 / 9),
            height,
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        },
    )
    .await
    .unwrap();
    // upsert_video doesn't return the id; fetch it.
    sqlx::query_scalar("SELECT id FROM videos WHERE connection_id = ? AND provider_file_id = ?")
        .bind(conn_id)
        .bind(file_id)
        .fetch_one(repo.pool())
        .await
        .unwrap()
}

async fn set_favorite(repo: &CatalogRepository, owner_id: &str, video_id: &str) {
    sqlx::query(
        "INSERT OR IGNORE INTO video_favorites (owner_id, video_id, created_at) VALUES (?, ?, ?)",
    )
    .bind(owner_id)
    .bind(video_id)
    .bind("2026-07-12T00:00:00Z")
    .execute(repo.pool())
    .await
    .unwrap();
}

async fn set_rating(repo: &CatalogRepository, owner_id: &str, video_id: &str, rating: i32) {
    sqlx::query(
        "INSERT INTO video_ratings (owner_id, video_id, rating, updated_at) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT (owner_id, video_id) DO UPDATE SET rating = excluded.rating",
    )
    .bind(owner_id)
    .bind(video_id)
    .bind(rating)
    .bind("2026-07-12T00:00:00Z")
    .execute(repo.pool())
    .await
    .unwrap();
}

/// Create one connection for seeding.
async fn seed_connection(repo: &CatalogRepository, provider: Provider) -> String {
    let conn = repo
        .create_connection(&NewConnection {
            provider,
            token_bundle: sample_bundle(),
            provider_account_id: Some("acct".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();
    conn.id
}

// ── Enriched field presence ──────────────────────────────────────────

#[tokio::test]
async fn video_summary_includes_enriched_fields() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "concert.mp4",
        Some("/Music/concert.mp4"),
        Some(120_000),
        Some(1080),
    )
    .await;

    let (status, body) = get_json(app, "/api/videos", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let v = &body["videos"][0];
    assert!(v["created_at"].is_string(), "created_at present");
    assert_eq!(v["path"], "/Music/concert.mp4");
    assert_eq!(v["thumbnail_status"], "pending");
    assert_eq!(v["is_favorite"], false);
    assert!(v["my_rating"].is_null());
}

// ── FTS5 search ──────────────────────────────────────────────────────

#[tokio::test]
async fn search_finds_by_name() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "concert_video.mp4",
        None,
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f2",
        "vacation_clip.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, body) = get_json(app, "/api/videos?q=concert", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1, "only concert matches");
    assert_eq!(body["videos"][0]["name"], "concert_video.mp4");
}

#[tokio::test]
async fn search_finds_by_path() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "movie.mp4",
        Some("/Movies/Action/movie.mp4"),
        None,
        None,
    )
    .await;

    let (status, body) = get_json(app, "/api/videos?q=Action", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1, "path token matches");
}

#[tokio::test]
async fn empty_search_returns_all() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "a.mp4",
        None,
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f2",
        "b.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, body) = get_json(app, "/api/videos?q=", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 2, "empty q is treated as no search");
}

// ── Duration + resolution filters ────────────────────────────────────

#[tokio::test]
async fn duration_filter_excludes_outside_range() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "short",
        "s.mp4",
        None,
        Some(30_000),
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "long",
        "l.mp4",
        None,
        Some(600_000),
        None,
    )
    .await;

    let (status, body) = get_json(app, "/api/videos?duration_min=60000", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1, "only the long video (>= 1 min)");
    assert_eq!(body["videos"][0]["name"], "l.mp4");
}

#[tokio::test]
async fn resolution_filter() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "sd",
        "sd.mp4",
        None,
        None,
        Some(480),
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "hd",
        "hd.mp4",
        None,
        None,
        Some(720),
    )
    .await;

    let (status, body) = get_json(app, "/api/videos?min_height=720", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1, "only HD+");
    assert_eq!(body["videos"][0]["name"], "hd.mp4");
}

// ── Folder filter + enumeration ──────────────────────────────────────

#[tokio::test]
async fn folder_filter_matches_top_level_segment() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "a.mp4",
        Some("/Movies/Action/a.mp4"),
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f2",
        "b.mp4",
        Some("/TV/Shows/b.mp4"),
        None,
        None,
    )
    .await;

    let (status, body) = get_json(app, "/api/videos?folder=Movies", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1);
    assert_eq!(body["videos"][0]["name"], "a.mp4");
}

#[tokio::test]
async fn folder_enumeration_returns_counts() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "a.mp4",
        Some("/Movies/a.mp4"),
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f2",
        "b.mp4",
        Some("/Movies/b.mp4"),
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f3",
        "c.mp4",
        Some("/TV/c.mp4"),
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f4",
        "d.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, body) = get_json(app, "/api/videos/folders", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let folders = body.as_array().unwrap();
    let by_folder: std::collections::HashMap<String, i64> = folders
        .iter()
        .map(|f| {
            (
                f["folder"].as_str().unwrap().to_string(),
                f["video_count"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(by_folder["Movies"], 2);
    assert_eq!(by_folder["TV"], 1);
    assert_eq!(
        by_folder["(Unsorted)"], 1,
        "null path grouped under Unsorted"
    );
    // Sorted by count desc → Movies first.
    assert_eq!(folders[0]["folder"], "Movies");
}

// ── Sort ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn sort_by_name_ascending() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    for name in ["zebra.mp4", "alpha.mp4", "mango.mp4"] {
        seed_full_video(
            &repo,
            &conn,
            Provider::GoogleDrive,
            name,
            name,
            None,
            None,
            None,
        )
        .await;
    }

    let (status, body) = get_json(app, "/api/videos?sort=name", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = body["videos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["alpha.mp4", "mango.mp4", "zebra.mp4"]);
}

#[tokio::test]
async fn sort_by_size_descending() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    repo.upsert_video(
        &conn,
        Provider::GoogleDrive,
        &NewVideo {
            provider_file_id: "small".into(),
            name: "small.mp4".into(),
            path: None,
            size_bytes: 100,
            mime_type: None,
            duration_ms: None,
            width: None,
            height: None,
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        },
    )
    .await
    .unwrap();
    repo.upsert_video(
        &conn,
        Provider::GoogleDrive,
        &NewVideo {
            provider_file_id: "big".into(),
            name: "big.mp4".into(),
            path: None,
            size_bytes: 999_999,
            mime_type: None,
            duration_ms: None,
            width: None,
            height: None,
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        },
    )
    .await
    .unwrap();

    let (status, body) = get_json(app, "/api/videos?sort=size", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["videos"][0]["name"], "big.mp4");
    assert_eq!(body["videos"][1]["name"], "small.mp4");
}

// ── Favorites + ratings enrichment ───────────────────────────────────

#[tokio::test]
async fn favorites_and_ratings_appear_in_summary() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let owner = owner_id(&repo).await;
    let v1 = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "fav.mp4",
        None,
        None,
        None,
    )
    .await;
    let v2 = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f2",
        "rated.mp4",
        None,
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f3",
        "plain.mp4",
        None,
        None,
        None,
    )
    .await;

    set_favorite(&repo, &owner, &v1).await;
    set_rating(&repo, &owner, &v2, 4).await;

    let (status, body) = get_json(app, "/api/videos?sort=name", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let by_name: std::collections::HashMap<&str, &serde_json::Value> = body["videos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| (v["name"].as_str().unwrap(), v))
        .collect();
    assert_eq!(by_name["fav.mp4"]["is_favorite"].as_bool(), Some(true));
    assert!(by_name["fav.mp4"]["my_rating"].is_null());
    assert_eq!(by_name["rated.mp4"]["is_favorite"].as_bool(), Some(false));
    assert_eq!(by_name["rated.mp4"]["my_rating"], 4);
    assert_eq!(by_name["plain.mp4"]["is_favorite"].as_bool(), Some(false));
    assert!(by_name["plain.mp4"]["my_rating"].is_null());
}

#[tokio::test]
async fn favorites_only_filter() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let owner = owner_id(&repo).await;
    let v1 = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "fav.mp4",
        None,
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f2",
        "nofav.mp4",
        None,
        None,
        None,
    )
    .await;
    set_favorite(&repo, &owner, &v1).await;

    let (status, body) = get_json(app, "/api/videos?favorites_only=true", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1, "only the favorited video");
    assert_eq!(body["videos"][0]["name"], "fav.mp4");
}

#[tokio::test]
async fn min_rating_filter() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let owner = owner_id(&repo).await;
    let v1 = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "high.mp4",
        None,
        None,
        None,
    )
    .await;
    let v2 = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f2",
        "low.mp4",
        None,
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f3",
        "unrated.mp4",
        None,
        None,
        None,
    )
    .await;
    set_rating(&repo, &owner, &v1, 5).await;
    set_rating(&repo, &owner, &v2, 2).await;

    let (status, body) = get_json(app, "/api/videos?min_rating=4", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1, "only the >= 4 star video");
    assert_eq!(body["videos"][0]["name"], "high.mp4");
}

#[tokio::test]
async fn rating_sort_orders_by_my_rating() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let owner = owner_id(&repo).await;
    let v1 = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "top.mp4",
        None,
        None,
        None,
    )
    .await;
    let v2 = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f2",
        "mid.mp4",
        None,
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f3",
        "unrated.mp4",
        None,
        None,
        None,
    )
    .await;
    set_rating(&repo, &owner, &v1, 5).await;
    set_rating(&repo, &owner, &v2, 3).await;

    let (status, body) = get_json(app, "/api/videos?sort=rating", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = body["videos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect();
    // Highest rated first; unrated (NULLS LAST) at the end.
    assert_eq!(names, vec!["top.mp4", "mid.mp4", "unrated.mp4"]);
}

// ── Thumbnail proxy (T5) ──────────────────────────────────────────────

#[tokio::test]
async fn thumbnail_video_not_found_returns_404() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, _, _) =
        get_thumbnail_bytes(app, "/api/videos/nonexistent/thumbnail", Some(&cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn thumbnail_unauthenticated_returns_401() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _, _) = get_thumbnail_bytes(app, "/api/videos/some-id/thumbnail", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn thumbnail_unsupported_returns_404() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "v.mp4",
        None,
        None,
        None,
    )
    .await;
    repo.update_thumbnail_status(&vid, "unsupported")
        .await
        .unwrap();

    let (status, _, _) =
        get_thumbnail_bytes(app, &format!("/api/videos/{vid}/thumbnail"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn thumbnail_cached_serves_from_disk() {
    let (app, cookie, repo, data_dir, _guard) = boot_and_setup_full().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "f1",
        "v.mp4",
        None,
        None,
        None,
    )
    .await;

    // Seed the cache: write a test PNG and mark the video as cached.
    let cache_dir = data_dir.join("thumbnails");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let test_png = b"\x89PNG\r\n\x1a\n test thumbnail";
    std::fs::write(cache_dir.join(&vid), test_png).unwrap();
    repo.update_thumbnail_status(&vid, "cached").await.unwrap();

    let (status, bytes, content_type) =
        get_thumbnail_bytes(app, &format!("/api/videos/{vid}/thumbnail"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type.as_deref(), Some("image/png"));
    assert_eq!(bytes, test_png);
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn thumbnail_fetches_caches_and_serves() {
    let (app, cookie, repo, data_dir, _guard) = boot_and_setup_full().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "gd-vacation",
        "vacation.mp4",
        None,
        None,
        None,
    )
    .await;

    // First request — fetches from mock provider, caches, serves.
    let (status, bytes, content_type) =
        get_thumbnail_bytes(app, &format!("/api/videos/{vid}/thumbnail"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type.as_deref(), Some("image/png"));
    assert!(!bytes.is_empty());

    // Cache file written to disk.
    let cache_path = data_dir.join("thumbnails").join(&vid);
    assert!(cache_path.exists(), "cache file should exist");

    // thumbnail_status updated to "cached" in DB.
    let db_status: String = sqlx::query_scalar("SELECT thumbnail_status FROM videos WHERE id = ?")
        .bind(&vid)
        .fetch_one(repo.pool())
        .await
        .unwrap();
    assert_eq!(db_status, "cached");
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn thumbnail_second_request_serves_from_cache() {
    let (app, cookie, repo, _data_dir, _guard) = boot_and_setup_full().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "gd-concert",
        "concert.mp4",
        None,
        None,
        None,
    )
    .await;

    // First request — fetches and caches.
    let (status1, bytes1, _) = get_thumbnail_bytes(
        app.clone(),
        &format!("/api/videos/{vid}/thumbnail"),
        Some(&cookie),
    )
    .await;
    assert_eq!(status1, StatusCode::OK);

    // Second request — serves from cache (same bytes).
    let (status2, bytes2, _) =
        get_thumbnail_bytes(app, &format!("/api/videos/{vid}/thumbnail"), Some(&cookie)).await;
    assert_eq!(status2, StatusCode::OK);
    assert_eq!(bytes1, bytes2, "second request should serve same bytes");

    // Confirm status is cached.
    let db_status: String = sqlx::query_scalar("SELECT thumbnail_status FROM videos WHERE id = ?")
        .bind(&vid)
        .fetch_one(repo.pool())
        .await
        .unwrap();
    assert_eq!(db_status, "cached");
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn thumbnail_provider_not_found_sets_unsupported() {
    let (app, cookie, repo, _data_dir, _guard) = boot_and_setup_full().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    // "no-thumb-" prefix makes the e2e mock return ProviderError::NotFound.
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "no-thumb-1",
        "nothumb.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, _, _) =
        get_thumbnail_bytes(app, &format!("/api/videos/{vid}/thumbnail"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let db_status: String = sqlx::query_scalar("SELECT thumbnail_status FROM videos WHERE id = ?")
        .bind(&vid)
        .fetch_one(repo.pool())
        .await
        .unwrap();
    assert_eq!(db_status, "unsupported");
}

// ── Favorites + ratings CRUD (T6) ─────────────────────────────────────

/// Fetch a CSRF token + cookie via an authenticated `GET /api/csrf`.
/// Returns `(header_token, cookie_string)` where `cookie_string` is the
/// `castify_csrf=…` value to join into the request Cookie header.
async fn get_csrf(app: &axum::Router, session_cookie: &str) -> (String, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
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
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    let token = value["token"].as_str().unwrap().to_string();
    (token, csrf_cookie)
}

/// Generic authenticated mutation (POST/PUT/DELETE) with double-submit CSRF.
/// `body` is sent as JSON; pass `vec![]` for bodyless methods (POST favorite,
/// DELETE). `csrf_header` / `csrf_cookie` are `None` to test CSRF rejection.
async fn mutate(
    app: axum::Router,
    method: &str,
    uri: &str,
    body: Vec<u8>,
    cookie: Option<&str>,
    csrf_header: Option<&str>,
    csrf_cookie: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if !body.is_empty() {
        builder = builder.header("content-type", "application/json");
    }
    let mut cookie_parts: Vec<String> = Vec::new();
    if let Some(c) = cookie {
        cookie_parts.push(c.to_string());
    }
    if let Some(c) = csrf_cookie {
        cookie_parts.push(c.to_string());
    }
    if !cookie_parts.is_empty() {
        builder = builder.header("cookie", cookie_parts.join("; "));
    }
    if let Some(h) = csrf_header {
        builder = builder.header("x-csrf-token", h);
    }
    let response = app
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

/// Boot, setup, and return everything T6 mutation tests need: the app, the
/// session cookie, a CSRF (token, cookie) pair, the repo, a seeded connection,
/// and one seeded video id.
async fn boot_with_csrf_and_video() -> (
    axum::Router,
    String,
    String,
    String,
    CatalogRepository,
    String,
    tempfile::TempPath,
) {
    let (app, cookie, repo, guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "fav-1",
        "favoriteable.mp4",
        None,
        None,
        None,
    )
    .await;
    (app, cookie, csrf_token, csrf_cookie, repo, vid, guard)
}

// ── Favorites ─────────────────────────────────────────────────────────

#[tokio::test]
async fn favorite_set_echoes_true_and_appears_in_list() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;

    let (status, body) = mutate(
        app.clone(),
        "POST",
        &format!("/api/videos/{vid}/favorite"),
        vec![],
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["is_favorite"].as_bool(), Some(true));

    // Read-after-write: GET /api/videos reflects the new favorite state.
    let (status, body) = get_json(app, "/api/videos", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["videos"][0]["is_favorite"].as_bool(), Some(true));
}

#[tokio::test]
async fn favorite_set_is_idempotent() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;
    let uri = format!("/api/videos/{vid}/favorite");

    for _ in 0..2 {
        let (status, body) = mutate(
            app.clone(),
            "POST",
            &uri,
            vec![],
            Some(&cookie),
            Some(&csrf_token),
            Some(&csrf_cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["is_favorite"].as_bool(), Some(true));
    }
}

#[tokio::test]
async fn favorite_unset_echoes_false_and_disappears_from_list() {
    let (app, cookie, csrf_token, csrf_cookie, repo, vid, _guard) =
        boot_with_csrf_and_video().await;
    let owner = owner_id(&repo).await;
    let uri = format!("/api/videos/{vid}/favorite");

    // Seed a favorite via the repo, then unset via the API.
    set_favorite(&repo, &owner, &vid).await;

    let (status, body) = mutate(
        app.clone(),
        "DELETE",
        &uri,
        vec![],
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["is_favorite"].as_bool(), Some(false));

    let (status, body) = get_json(app, "/api/videos", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["videos"][0]["is_favorite"].as_bool(), Some(false));
}

#[tokio::test]
async fn favorite_unset_is_idempotent() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;
    let uri = format!("/api/videos/{vid}/favorite");

    for _ in 0..2 {
        let (status, body) = mutate(
            app.clone(),
            "DELETE",
            &uri,
            vec![],
            Some(&cookie),
            Some(&csrf_token),
            Some(&csrf_cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["is_favorite"].as_bool(), Some(false));
    }
}

#[tokio::test]
async fn favorite_missing_video_returns_404() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, _vid, _guard) =
        boot_with_csrf_and_video().await;

    let (status, _body) = mutate(
        app,
        "POST",
        "/api/videos/no-such-video/favorite",
        vec![],
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn favorite_and_rating_reject_unauthenticated() {
    let (app, _cookie, _csrf_token, _csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;

    let (status, _) = mutate(
        app.clone(),
        "POST",
        &format!("/api/videos/{vid}/favorite"),
        vec![],
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = mutate(
        app,
        "PUT",
        &format!("/api/videos/{vid}/rating"),
        serde_json::json!({"rating": 3}).to_string().into_bytes(),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn favorite_and_rating_reject_missing_csrf() {
    let (app, cookie, _csrf_token, _csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;

    // Authenticated session but no CSRF header/cookie.
    let (status, _) = mutate(
        app.clone(),
        "POST",
        &format!("/api/videos/{vid}/favorite"),
        vec![],
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _) = mutate(
        app,
        "PUT",
        &format!("/api/videos/{vid}/rating"),
        serde_json::json!({"rating": 3}).to_string().into_bytes(),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

// ── Ratings ───────────────────────────────────────────────────────────

#[tokio::test]
async fn rating_set_and_update_round_trip() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;
    let uri = format!("/api/videos/{vid}/rating");

    // Initial set.
    let (status, body) = mutate(
        app.clone(),
        "PUT",
        &uri,
        serde_json::json!({"rating": 3}).to_string().into_bytes(),
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["my_rating"].as_i64(), Some(3));

    // Update existing.
    let (status, body) = mutate(
        app.clone(),
        "PUT",
        &uri,
        serde_json::json!({"rating": 5}).to_string().into_bytes(),
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["my_rating"].as_i64(), Some(5));

    // Read-after-write.
    let (status, body) = get_json(app, "/api/videos", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["videos"][0]["my_rating"].as_i64(), Some(5));
}

#[tokio::test]
async fn rating_out_of_range_returns_400() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;
    let uri = format!("/api/videos/{vid}/rating");

    for invalid in [0, 6] {
        let (status, body) = mutate(
            app.clone(),
            "PUT",
            &uri,
            serde_json::json!({"rating": invalid})
                .to_string()
                .into_bytes(),
            Some(&cookie),
            Some(&csrf_token),
            Some(&csrf_cookie),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "rating={invalid} should 400"
        );
        assert!(
            body.get("message").is_some(),
            "error body should have message"
        );
    }
}

#[tokio::test]
async fn rating_unset_echoes_null_and_clears_in_list() {
    let (app, cookie, csrf_token, csrf_cookie, repo, vid, _guard) =
        boot_with_csrf_and_video().await;
    let owner = owner_id(&repo).await;
    let uri = format!("/api/videos/{vid}/rating");

    // Seed a rating via the repo, then clear via the API.
    set_rating(&repo, &owner, &vid, 4).await;

    let (status, body) = mutate(
        app.clone(),
        "DELETE",
        &uri,
        vec![],
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["my_rating"].is_null());

    let (status, body) = get_json(app, "/api/videos", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["videos"][0]["my_rating"].is_null());
}

#[tokio::test]
async fn rating_unset_is_idempotent() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;
    let uri = format!("/api/videos/{vid}/rating");

    for _ in 0..2 {
        let (status, body) = mutate(
            app.clone(),
            "DELETE",
            &uri,
            vec![],
            Some(&cookie),
            Some(&csrf_token),
            Some(&csrf_cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["my_rating"].is_null());
    }
}

#[tokio::test]
async fn rating_missing_video_returns_404() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, _vid, _guard) =
        boot_with_csrf_and_video().await;

    let (status, _body) = mutate(
        app,
        "PUT",
        "/api/videos/no-such-video/rating",
        serde_json::json!({"rating": 3}).to_string().into_bytes(),
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ── Playback progress (T4) ────────────────────────────────────────────

#[tokio::test]
async fn progress_upsert_and_fetch_round_trip() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;

    // Save progress.
    let (status, body) = mutate(
        app.clone(),
        "POST",
        &format!("/api/videos/{vid}/progress"),
        serde_json::json!({"position_seconds": 42.5, "duration_seconds": 120.0})
            .to_string()
            .into_bytes(),
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["position_seconds"].as_f64(), Some(42.5));
    assert_eq!(body["duration_seconds"].as_f64(), Some(120.0));
    assert_eq!(body["completed"].as_bool(), Some(false));

    // Fetch it back.
    let (status, body) = get_json(app, &format!("/api/videos/{vid}/progress"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["position_seconds"].as_f64(), Some(42.5));
}

#[tokio::test]
async fn progress_update_overwrites_previous() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;

    // First save.
    mutate(
        app.clone(),
        "POST",
        &format!("/api/videos/{vid}/progress"),
        serde_json::json!({"position_seconds": 10.0})
            .to_string()
            .into_bytes(),
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;

    // Second save — new position.
    let (status, body) = mutate(
        app.clone(),
        "POST",
        &format!("/api/videos/{vid}/progress"),
        serde_json::json!({"position_seconds": 90.0, "completed": true})
            .to_string()
            .into_bytes(),
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["position_seconds"].as_f64(), Some(90.0));
    assert_eq!(body["completed"].as_bool(), Some(true));
}

#[tokio::test]
async fn progress_get_returns_404_when_none() {
    let (app, cookie, _csrf_token, _csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;

    let (status, _body) =
        get_json(app, &format!("/api/videos/{vid}/progress"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn progress_post_returns_404_for_missing_video() {
    let (app, cookie, csrf_token, csrf_cookie, _repo, _vid, _guard) =
        boot_with_csrf_and_video().await;

    let (status, _body) = mutate(
        app,
        "POST",
        "/api/videos/no-such-video/progress",
        serde_json::json!({"position_seconds": 1.0})
            .to_string()
            .into_bytes(),
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn progress_post_rejects_unauthenticated() {
    let (app, _cookie, _csrf_token, _csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;

    let (status, _) = mutate(
        app,
        "POST",
        &format!("/api/videos/{vid}/progress"),
        serde_json::json!({"position_seconds": 1.0})
            .to_string()
            .into_bytes(),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn progress_post_rejects_missing_csrf() {
    let (app, cookie, _csrf_token, _csrf_cookie, _repo, vid, _guard) =
        boot_with_csrf_and_video().await;

    let (status, _) = mutate(
        app,
        "POST",
        &format!("/api/videos/{vid}/progress"),
        serde_json::json!({"position_seconds": 1.0})
            .to_string()
            .into_bytes(),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn in_progress_filter_returns_only_in_progress() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let owner = owner_id(&repo).await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;

    let v1 = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "prog-1",
        "in-progress.mp4",
        None,
        None,
        None,
    )
    .await;
    let v2 = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "prog-2",
        "completed.mp4",
        None,
        None,
        None,
    )
    .await;
    seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "prog-3",
        "no-progress.mp4",
        None,
        None,
        None,
    )
    .await;

    // v1: in-progress (position > 0, not completed).
    repo.upsert_progress(&owner, &v1, 30.0, Some(120.0), false)
        .await
        .unwrap();
    // v2: completed.
    repo.upsert_progress(&owner, &v2, 120.0, Some(120.0), true)
        .await
        .unwrap();

    let (status, body) = get_json(app, "/api/videos?in_progress=true", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1, "only the in-progress video");
    assert_eq!(body["videos"][0]["name"], "in-progress.mp4");
}

#[tokio::test]
async fn video_summary_includes_position_seconds() {
    let (app, cookie, csrf_token, csrf_cookie, repo, vid, _guard) =
        boot_with_csrf_and_video().await;
    let owner = owner_id(&repo).await;

    repo.upsert_progress(&owner, &vid, 45.5, Some(100.0), false)
        .await
        .unwrap();

    let (status, body) = get_json(app, "/api/videos", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["videos"][0]["position_seconds"].as_f64(), Some(45.5));
    assert_eq!(body["videos"][0]["completed"].as_bool(), Some(false));

    // Ensure CSRF/progress state didn't interfere — just checking the field is
    // there, not asserting on the csrf vars.
    let _ = (csrf_token, csrf_cookie);
}

// ── Video detail (T5) ─────────────────────────────────────────────────

async fn seed_subtitle(
    repo: &CatalogRepository,
    video_id: &str,
    connection_id: &str,
    provider_file_id: &str,
    language: Option<&str>,
    filename: &str,
    format: &str,
) -> String {
    let id = format!("sub-{provider_file_id}");
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, language, filename, format, format_family) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'text')",
    )
    .bind(&id)
    .bind(video_id)
    .bind(connection_id)
    .bind(provider_file_id)
    .bind(language)
    .bind(filename)
    .bind(format)
    .execute(repo.pool())
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn video_detail_returns_all_fields() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "detail-1",
        "detail-test.mp4",
        Some("/Movies/detail-test.mp4"),
        Some(120_000),
        Some(1080),
    )
    .await;

    let (status, body) = get_json(app, &format!("/api/videos/{vid}"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], vid);
    assert_eq!(body["name"], "detail-test.mp4");
    assert_eq!(body["provider"], "google_drive");
    assert_eq!(body["size_bytes"], 10_000);
    assert_eq!(body["mime_type"], "video/mp4");
    assert_eq!(body["duration_ms"], 120_000);
    assert_eq!(body["width"], 1920);
    assert_eq!(body["height"], 1080);
    assert!(body["sources"].is_array());
    assert!(!body["sources"].as_array().unwrap().is_empty());
    assert!(body["created_at"].is_string());
    assert_eq!(body["path"], "/Movies/detail-test.mp4");
    assert_eq!(body["thumbnail_status"], "pending");
    assert_eq!(body["is_favorite"].as_bool(), Some(false));
    assert!(body["my_rating"].is_null());
    assert!(body["position_seconds"].is_null());
    assert!(body["duration_seconds"].is_null());
    assert_eq!(body["completed"].as_bool(), Some(false));
    assert_eq!(body["subtitle_tracks"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn video_detail_returns_404_for_missing() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, _body) = get_json(app, "/api/videos/nonexistent", Some(&cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn video_detail_subtitle_tracks_populated_when_seeded() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "detail-subs-1",
        "with-subs.mp4",
        None,
        None,
        None,
    )
    .await;

    seed_subtitle(
        &repo,
        &vid,
        &conn,
        "sub-file-1",
        Some("en"),
        "with-subs.en.srt",
        "srt",
    )
    .await;
    seed_subtitle(
        &repo,
        &vid,
        &conn,
        "sub-file-2",
        Some("es"),
        "with-subs.es.vtt",
        "vtt",
    )
    .await;

    let (status, body) = get_json(app, &format!("/api/videos/{vid}"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let tracks = body["subtitle_tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 2);
    // Ordered by filename — en < es
    assert_eq!(tracks[0]["language"], "en");
    assert_eq!(tracks[0]["filename"], "with-subs.en.srt");
    assert_eq!(tracks[0]["format"], "srt");
    assert_eq!(tracks[1]["language"], "es");
    assert_eq!(tracks[1]["filename"], "with-subs.es.vtt");
    assert_eq!(tracks[1]["format"], "vtt");
}

#[tokio::test]
async fn video_detail_includes_playback_progress() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "detail-prog-1",
        "progress-video.mp4",
        None,
        None,
        None,
    )
    .await;
    let owner = owner_id(&repo).await;
    repo.upsert_progress(&owner, &vid, 120.5, Some(600.0), false)
        .await
        .unwrap();

    let (status, body) = get_json(app, &format!("/api/videos/{vid}"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["position_seconds"].as_f64(), Some(120.5));
    assert_eq!(body["duration_seconds"].as_f64(), Some(600.0));
    assert_eq!(body["completed"].as_bool(), Some(false));
}

#[tokio::test]
async fn video_detail_includes_personalization() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "detail-pers-1",
        "personal.mp4",
        None,
        None,
        None,
    )
    .await;
    let owner = owner_id(&repo).await;
    set_favorite(&repo, &owner, &vid).await;
    set_rating(&repo, &owner, &vid, 4).await;

    let (status, body) = get_json(app, &format!("/api/videos/{vid}"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["is_favorite"].as_bool(), Some(true));
    assert_eq!(body["my_rating"], 4);
}

#[tokio::test]
async fn video_detail_rejects_unauthenticated() {
    let (_app, _cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "detail-auth-1",
        "auth-test.mp4",
        None,
        None,
        None,
    )
    .await;

    let (state, _guard2, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = get_json(app, &format!("/api/videos/{vid}"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ── Subtitle list + serving (T6) ──────────────────────────────────────

#[tokio::test]
async fn subtitle_list_returns_tracks() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "sub-list-1",
        "subtitled.mp4",
        None,
        None,
        None,
    )
    .await;
    seed_subtitle(
        &repo,
        &vid,
        &conn,
        "slist-1",
        Some("en"),
        "subtitled.en.srt",
        "srt",
    )
    .await;
    seed_subtitle(&repo, &vid, &conn, "slist-2", None, "subtitled.vtt", "vtt").await;

    let (status, body) =
        get_json(app, &format!("/api/videos/{vid}/subtitles"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let tracks = body.as_array().unwrap();
    assert_eq!(tracks.len(), 2);
    assert_eq!(tracks[0]["language"], "en");
    assert_eq!(tracks[0]["format"], "srt");
}

#[tokio::test]
async fn subtitle_list_returns_empty_when_none() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "sub-empty-1",
        "no-subs.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, body) =
        get_json(app, &format!("/api/videos/{vid}/subtitles"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn subtitle_list_returns_404_for_missing_video() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, _body) = get_json(app, "/api/videos/nonexistent/subtitles", Some(&cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ── Stream + download proxy (T3) ──────────────────────────────────────

/// GET a stream/download URI with optional cookie + Range header. Returns
/// status, response headers, and body bytes.
async fn get_stream_bytes(
    app: axum::Router,
    uri: &str,
    cookie: Option<&str>,
    range: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut builder = Request::builder().method("GET").uri(uri);
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    if let Some(r) = range {
        builder = builder.header("range", r);
    }
    let response = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, bytes.to_vec())
}

#[tokio::test]
async fn stream_video_not_found_returns_404() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, _, _) =
        get_stream_bytes(app, "/api/videos/nonexistent/stream", Some(&cookie), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn stream_unauthenticated_returns_401() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _, _) = get_stream_bytes(app, "/api/videos/some-id/stream", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_returns_200_full_content() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "gd-vacation",
        "vacation.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, headers, bytes) = get_stream_bytes(
        app,
        &format!("/api/videos/{vid}/stream"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get("content-type").unwrap().to_str().unwrap(),
        "video/mp4"
    );
    assert!(headers.get("accept-ranges").is_some());
    assert!(!bytes.is_empty(), "body should have bytes");
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_range_returns_206_with_content_range() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "gd-concert",
        "concert.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, headers, bytes) = get_stream_bytes(
        app,
        &format!("/api/videos/{vid}/stream"),
        Some(&cookie),
        Some("bytes=0-7"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    let content_range = headers.get("content-range").unwrap().to_str().unwrap();
    assert!(
        content_range.starts_with("bytes 0-7/"),
        "content-range: {content_range}"
    );
    assert_eq!(bytes.len(), 8, "should return 8 bytes for range 0-7");
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_not_found_prefix_returns_404() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "no-stream-1",
        "unstreamable.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, _, _) = get_stream_bytes(
        app,
        &format!("/api/videos/{vid}/stream"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn download_returns_content_disposition() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "gd-vacation",
        "vacation.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, headers, _bytes) = get_stream_bytes(
        app,
        &format!("/api/videos/{vid}/download"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let disposition = headers
        .get("content-disposition")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(
        disposition.contains("attachment"),
        "should be attachment: {disposition}"
    );
    assert!(
        disposition.contains("vacation.mp4"),
        "should include filename: {disposition}"
    );
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn e2e_subtitle_list_and_serving() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "gd-vacation",
        "vacation.mp4",
        None,
        None,
        None,
    )
    .await;
    // Seed a subtitle track pointing at the mock's subtitle file ID.
    // The mock's fetch_subtitle_content returns MOCK_VTT for any non-"no-subs-" ID.
    let track_id = seed_subtitle(
        &repo,
        &vid,
        &conn,
        "gd-vacation-srt",
        Some("en"),
        "vacation.en.srt",
        "srt",
    )
    .await;

    // GET /subtitles — list tracks
    let (status, body) = get_json(
        app.clone(),
        &format!("/api/videos/{vid}/subtitles"),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let tracks = body.as_array().unwrap();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0]["language"], "en");
    assert_eq!(tracks[0]["filename"], "vacation.en.srt");
    assert_eq!(tracks[0]["format"], "srt");

    // GET /subtitles/{track_id} — serve as VTT
    let (status, bytes, content_type) = get_thumbnail_bytes(
        app,
        &format!("/api/videos/{vid}/subtitles/{track_id}"),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type.as_deref(), Some("text/vtt"));
    let vtt = String::from_utf8_lossy(&bytes);
    assert!(vtt.starts_with("WEBVTT"), "should start with WEBVTT header");
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn e2e_subtitle_serving_404_missing_track() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "gd-concert",
        "concert.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, _, _) = get_thumbnail_bytes(
        app,
        &format!("/api/videos/{vid}/subtitles/nonexistent"),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ── M8 Task 003: format-aware subtitle serving ───────────────────────

/// Seed an extracted-embedded subtitle track. Unlike sidecars (which have a
/// provider_file_id and fetch bytes from the provider), extracted tracks have
/// NULL provider_file_id, a non-NULL extracted_path pointing at local disk,
/// and an embedded_track_id linking back to the muxed stream index.
#[allow(clippy::too_many_arguments)]
async fn seed_extracted_subtitle(
    repo: &CatalogRepository,
    video_id: &str,
    track_id: &str,
    embedded_track_id: i64,
    language: Option<&str>,
    filename: &str,
    format: &str,
    extracted_path: &str,
) {
    sqlx::query(
        "INSERT INTO video_subtitles \
         (id, video_id, connection_id, provider_file_id, embedded_track_id, \
          language, filename, format, format_family, extracted_path) \
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, 'text', ?)",
    )
    .bind(track_id)
    .bind(video_id)
    .bind(embedded_track_id)
    .bind(language)
    .bind(filename)
    .bind(format)
    .bind(extracted_path)
    .execute(repo.pool())
    .await
    .unwrap();
}

/// An extracted ASS track reads bytes from `extracted_path` on disk and
/// serves them raw as `text/plain` — libass.js (Task 004) consumes the raw
/// ASS source. The provider is never touched (`provider_file_id` is NULL).
#[tokio::test]
async fn subtitle_serving_extracted_ass_serves_raw_text_plain() {
    let (app, cookie, repo, data_dir, _guard) = boot_and_setup_full().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "extract-ass-1",
        "mkv-with-ass.mp4",
        None,
        None,
        None,
    )
    .await;

    let ass_body = b"[Script Info]\nTitle: Test\n";
    let sub_dir = data_dir.join("extracted-subs").join(&vid);
    std::fs::create_dir_all(&sub_dir).unwrap();
    let ass_path = sub_dir.join("track-ass.ass");
    std::fs::write(&ass_path, ass_body).unwrap();

    let track_id = "extract-ass-track";
    seed_extracted_subtitle(
        &repo,
        &vid,
        track_id,
        3,
        Some("en"),
        "mkv-with-ass.ass",
        "ass",
        &ass_path.to_string_lossy(),
    )
    .await;

    let (status, bytes, content_type) = get_thumbnail_bytes(
        app,
        &format!("/api/videos/{vid}/subtitles/{track_id}"),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type.as_deref(), Some("text/plain"));
    assert_eq!(
        bytes, ass_body,
        "ASS body should be served raw (no conversion)"
    );
}

/// An extracted SRT track reads from disk and applies the same SRT→WebVTT
/// conversion as sidecar SRT — the extraction path is transparent to the
/// format rule.
#[tokio::test]
async fn subtitle_serving_extracted_srt_converts_to_vtt() {
    let (app, cookie, repo, data_dir, _guard) = boot_and_setup_full().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "extract-srt-1",
        "mkv-with-srt.mp4",
        None,
        None,
        None,
    )
    .await;

    let srt_body = b"1\n00:00:01,000 --> 00:00:03,000\nHello\n";
    let sub_dir = data_dir.join("extracted-subs").join(&vid);
    std::fs::create_dir_all(&sub_dir).unwrap();
    let srt_path = sub_dir.join("track-srt.srt");
    std::fs::write(&srt_path, srt_body).unwrap();

    let track_id = "extract-srt-track";
    seed_extracted_subtitle(
        &repo,
        &vid,
        track_id,
        2,
        None,
        "mkv-with-srt.srt",
        "srt",
        &srt_path.to_string_lossy(),
    )
    .await;

    let (status, bytes, content_type) = get_thumbnail_bytes(
        app,
        &format!("/api/videos/{vid}/subtitles/{track_id}"),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type.as_deref(), Some("text/vtt"));
    let vtt = String::from_utf8_lossy(&bytes);
    assert!(vtt.starts_with("WEBVTT"), "extracted SRT → VTT conversion");
    assert!(
        !vtt.contains("--> 00:00:03,000"),
        "comma timestamps replaced with dots"
    );
}

/// A deleted extracted file (the path in the DB no longer exists on disk)
/// returns 404 — not a 500 crash. Happens when the cache is cleared out of
/// band while the DB row lingers.
#[tokio::test]
async fn subtitle_serving_extracted_missing_file_returns_404() {
    let (app, cookie, repo, _data_dir, _guard) = boot_and_setup_full().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "extract-missing-1",
        "mkv-missing-sub.mp4",
        None,
        None,
        None,
    )
    .await;

    let track_id = "extract-missing-track";
    seed_extracted_subtitle(
        &repo,
        &vid,
        track_id,
        1,
        None,
        "phantom.ass",
        "ass",
        "/nonexistent/extracted-subs/phantom.ass",
    )
    .await;

    let (status, _bytes, _content_type) = get_thumbnail_bytes(
        app,
        &format!("/api/videos/{vid}/subtitles/{track_id}"),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// A sidecar ASS track fetches bytes from the provider (same pipeline as
/// SRT/VTT sidecars) but serves them raw as `text/plain` — the format drives
/// the Content-Type, not the fetch path.
#[cfg(feature = "e2e")]
#[tokio::test]
async fn subtitle_serving_sidecar_ass_returns_text_plain() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "gd-sidecar-ass",
        "styled.mp4",
        None,
        None,
        None,
    )
    .await;

    let track_id = seed_subtitle(
        &repo,
        &vid,
        &conn,
        "gd-ass-sidecar",
        Some("en"),
        "styled.en.ass",
        "ass",
    )
    .await;

    let (status, bytes, content_type) = get_thumbnail_bytes(
        app,
        &format!("/api/videos/{vid}/subtitles/{track_id}"),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        content_type.as_deref(),
        Some("text/plain"),
        "ASS sidecar should be served as text/plain, not text/vtt"
    );
    assert!(!bytes.is_empty(), "raw provider bytes served");
}

// ── /stream-url endpoint (T12) ─────────────────────────────────────────
//
// The endpoint tells the frontend where to fetch video bytes: a direct
// CDN URL (all providers — OneDrive/Dropbox preauthenticated, Google Drive
// via `?alt=media` redirect-follow), or our own /stream proxy as a fallback
// for files Drive can't direct-serve. These tests verify the response shape
// for each strategy, plus 404 / unauthenticated handling.

#[tokio::test]
async fn stream_url_video_not_found_returns_404() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, body) = get_json(app, "/api/videos/nonexistent/stream-url", Some(&cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["status"], "error");
}

#[tokio::test]
async fn stream_url_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = get_json(app, "/api/videos/any/stream-url", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_url_returns_proxy_strategy_for_google_drive() {
    // The e2e mock returns Proxied for Drive (deliberately, to exercise the
    // /stream proxy path in the browser suite). Production Drive usually
    // returns Direct (when ?alt=media redirects) but falls back to Proxied
    // for inline-byte cases — see `stream_drive_inline_byte_fallback` below.
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "gd-vacation",
        "vacation.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, body) =
        get_json(app, &format!("/api/videos/{vid}/stream-url"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["strategy"], "proxy");
    let url = body["url"].as_str().expect("url present");
    assert!(
        url.ends_with("/stream"),
        "proxy URL should point at /stream endpoint: {url}"
    );
    // expires_at is null for the proxy path (no CDN URL to expire).
    assert!(body.get("expires_at").is_some());
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_url_returns_direct_strategy_for_onedrive() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::OneDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::OneDrive,
        "od-clip",
        "onedrive-clip.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, body) =
        get_json(app, &format!("/api/videos/{vid}/stream-url"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["strategy"], "direct");
    let url = body["url"].as_str().expect("url present");
    assert!(
        url.starts_with("/api/__e2e/mock-cdn/"),
        "mock direct URL should point at the e2e CDN route: {url}"
    );
    // expires_at is null in the mock; the production impl sets it (~55min for
    // OneDrive). Just check the field exists.
    assert!(body.get("expires_at").is_some());
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_url_returns_direct_strategy_for_dropbox() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::Dropbox).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::Dropbox,
        "db-screenshots",
        "screenshots.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, body) =
        get_json(app, &format!("/api/videos/{vid}/stream-url"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["strategy"], "direct");
    let url = body["url"].as_str().expect("url present");
    assert!(
        url.starts_with("/api/__e2e/mock-cdn/"),
        "mock direct URL should point at the e2e CDN route: {url}"
    );
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_url_direct_strategy_404_propagates() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::OneDrive).await;
    // The e2e mock returns NotFound for file IDs starting with "no-stream-".
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::OneDrive,
        "no-stream-1",
        "unstreamable.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, body) =
        get_json(app, &format!("/api/videos/{vid}/stream-url"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["status"], "error");
}

// ── Post-refresh Unauthorized leak fix ───────────────────────────────
//
// When the provider returns 401 on BOTH the first call and the retry after
// refresh, the API layer must surface a structured `401 code: "reauth_required"`
// — NOT leak the raw provider message as a 502. The frontend's
// `useStreamUrl` hook keys off the structured code to render the reconnect
// card; a 502 with "unauthorized: token may be expired or revoked" gives the
// user no actionable path. See `map_post_refresh_error` in routes/videos.rs.

#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_url_returns_reauth_required_when_refresh_does_not_recover() {
    // OneDrive's mock returns `Direct` from `open_stream_url`; the e2e mock
    // returns Unauthorized for any `refresh-fail-*` file ID on every call,
    // so refresh succeeds but the retried call still 401s.
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::OneDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::OneDrive,
        "refresh-fail-onedrive",
        "unauth.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, body) =
        get_json(app, &format!("/api/videos/{vid}/stream-url"), Some(&cookie)).await;

    // The fix: 401, not 502.
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["status"], "error");
    assert_eq!(body["code"], "reauth_required");
    assert_eq!(body["connection_id"], conn);
    assert_eq!(body["provider"], "onedrive");
    // The leaky raw provider message must NOT be the surfaced message.
    let msg = body["message"].as_str().expect("message present");
    assert!(
        !msg.contains("token may be expired or revoked"),
        "raw provider leak should not surface: got {msg:?}"
    );
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_proxy_returns_reauth_required_when_refresh_does_not_recover() {
    // Google Drive's mock returns `Proxied` from `open_stream_url`, so the
    // browser's `<video src>` then hits `/stream` for bytes. That path goes
    // through `open_stream_with_refresh` → `map_post_refresh_error`. Verify
    // the same reauth signal for the proxy path.
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "refresh-fail-drive",
        "unauth.mp4",
        None,
        None,
        None,
    )
    .await;

    let (status, body) =
        get_json(app, &format!("/api/videos/{vid}/stream"), Some(&cookie)).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "reauth_required");
    assert_eq!(body["connection_id"], conn);
    assert_eq!(body["provider"], "google_drive");
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn mock_cdn_serves_video_bytes_with_range_support() {
    // The e2e mock CDN route must serve the same bytes as `open_stream` so
    // the browser's `<video>` element can actually fetch them. This test
    // verifies the route works (Range + full content). The route sits under
    // `/api/*` so it requires an authenticated session — the e2e browser
    // has one too.
    let (app, cookie, _repo, _guard) = boot_and_setup().await;

    // Full content (no Range).
    let (status, headers, bytes) = get_stream_bytes(
        app.clone(),
        "/api/__e2e/mock-cdn/anything",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get("content-type").unwrap().to_str().unwrap(),
        "video/mp4"
    );
    assert!(headers.get("accept-ranges").is_some());
    assert!(!bytes.is_empty());

    // Range request → 206 partial content.
    let (status, headers, bytes) = get_stream_bytes(
        app,
        "/api/__e2e/mock-cdn/anything",
        Some(&cookie),
        Some("bytes=0-3"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    let content_range = headers.get("content-range").unwrap().to_str().unwrap();
    assert!(
        content_range.starts_with("bytes 0-3/"),
        "content-range: {content_range}"
    );
    assert_eq!(bytes.len(), 4);
}

// ── M3.5 streaming audit tests ──────────────────────────────────────

/// M3.5 FR-7.1 — Drive inline-byte fallback path. When Drive serves bytes
/// inline instead of 302-redirecting (rare: restricted sharing, large files,
/// flagged mimetypes), `/stream-url` returns `strategy: "proxy"` pointing at
/// `/stream`, and `/stream` serves the bytes correctly with Range support.
///
/// The e2e mock exercises this path unconditionally for Drive (production
/// usually returns Direct via redirect-follow). This test verifies the
/// end-to-end proxy path: stream-url returns proxy, stream serves 206 with
/// correct Content-Range for a Range request.
#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_drive_inline_byte_fallback() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "gd-inline",
        "inline-video.mp4",
        None,
        None,
        None,
    )
    .await;

    // Step 1: stream-url returns proxy strategy.
    let (status, body) =
        get_json(app.clone(), &format!("/api/videos/{vid}/stream-url"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["strategy"], "proxy");
    let url = body["url"].as_str().expect("url present");
    assert!(
        url.ends_with("/stream"),
        "proxy URL should point at /stream: {url}"
    );

    // Step 2: /stream serves 206 with correct Content-Range for Range request.
    let (status, headers, bytes) = get_stream_bytes(
        app,
        &format!("/api/videos/{vid}/stream"),
        Some(&cookie),
        Some("bytes=0-3"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    let content_range = headers.get("content-range").unwrap().to_str().unwrap();
    assert!(
        content_range.starts_with("bytes 0-3/"),
        "content-range: {content_range}"
    );
    assert_eq!(bytes.len(), 4);
    assert_eq!(
        headers.get("content-type").unwrap().to_str().unwrap(),
        "video/mp4"
    );
    assert_eq!(
        headers.get("accept-ranges").unwrap().to_str().unwrap(),
        "bytes"
    );
}

/// M3.5 FR-7.2 — token refresh mid-stream. When the provider returns 401 on
/// the first `open_stream` call, the API layer refreshes the token once and
/// retries. The response should be 206 with correct Content-Range (the user
/// never sees the 401). The e2e mock simulates this via the `refresh-once-`
/// file-ID prefix: first call returns Unauthorized, second succeeds.
#[cfg(feature = "e2e")]
#[tokio::test]
async fn stream_token_refresh_mid_stream() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    // The `refresh-once-` prefix triggers the mock's Unauthorized-then-success
    // behavior. The factory's shared state ensures the second `open_stream`
    // call (after refresh) sees the counter incremented.
    let vid = seed_full_video(
        &repo,
        &conn,
        Provider::GoogleDrive,
        "refresh-once-test",
        "refresh-test.mp4",
        None,
        None,
        None,
    )
    .await;

    // Range request through the proxy. First open_stream returns 401 → API
    // refreshes → retry succeeds. Client sees only the successful 206.
    let (status, headers, bytes) = get_stream_bytes(
        app,
        &format!("/api/videos/{vid}/stream"),
        Some(&cookie),
        Some("bytes=0-3"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    let content_range = headers.get("content-range").unwrap().to_str().unwrap();
    assert!(
        content_range.starts_with("bytes 0-3/"),
        "content-range: {content_range}"
    );
    assert_eq!(bytes.len(), 4);
}
