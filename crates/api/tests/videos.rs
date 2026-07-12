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
