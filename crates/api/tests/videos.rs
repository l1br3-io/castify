mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use castify_catalog::{CatalogRepository, NewConnection, NewVideo, Provider, TokenBundle};

const PASSWORD: &str = "correct horse battery staple";

async fn boot_and_setup() -> (axum::Router, String, CatalogRepository, tempfile::TempPath) {
    let (state, guard, _path) = common::fresh_state().await;
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
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "f1", "a.mp4", None, None, None).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "f2", "b.mp4", None, None, None).await;

    let (status, body) = get_json(app, "/api/videos?q=", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 2, "empty q is treated as no search");
}

// ── Duration + resolution filters ────────────────────────────────────

#[tokio::test]
async fn duration_filter_excludes_outside_range() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "short", "s.mp4", None, Some(30_000), None).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "long", "l.mp4", None, Some(600_000), None).await;

    let (status, body) =
        get_json(app, "/api/videos?duration_min=60000", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1, "only the long video (>= 1 min)");
    assert_eq!(body["videos"][0]["name"], "l.mp4");
}

#[tokio::test]
async fn resolution_filter() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "sd", "sd.mp4", None, None, Some(480)).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "hd", "hd.mp4", None, None, Some(720)).await;

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
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "f1", "a.mp4", Some("/Movies/a.mp4"), None, None).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "f2", "b.mp4", Some("/Movies/b.mp4"), None, None).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "f3", "c.mp4", Some("/TV/c.mp4"), None, None).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "f4", "d.mp4", None, None, None).await;

    let (status, body) = get_json(app, "/api/videos/folders", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let folders = body.as_array().unwrap();
    let by_folder: std::collections::HashMap<String, i64> = folders
        .iter()
        .map(|f| (f["folder"].as_str().unwrap().to_string(), f["video_count"].as_i64().unwrap()))
        .collect();
    assert_eq!(by_folder["Movies"], 2);
    assert_eq!(by_folder["TV"], 1);
    assert_eq!(by_folder["(Unsorted)"], 1, "null path grouped under Unsorted");
    // Sorted by count desc → Movies first.
    assert_eq!(folders[0]["folder"], "Movies");
}

// ── Sort ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn sort_by_name_ascending() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    for name in ["zebra.mp4", "alpha.mp4", "mango.mp4"] {
        seed_full_video(&repo, &conn, Provider::GoogleDrive, name, name, None, None, None).await;
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
    repo.upsert_video(&conn, Provider::GoogleDrive, &NewVideo {
        provider_file_id: "small".into(), name: "small.mp4".into(), path: None,
        size_bytes: 100, mime_type: None, duration_ms: None, width: None, height: None,
        native_hash: None, native_hash_algo: None, provider_modified_at: None,
    }).await.unwrap();
    repo.upsert_video(&conn, Provider::GoogleDrive, &NewVideo {
        provider_file_id: "big".into(), name: "big.mp4".into(), path: None,
        size_bytes: 999_999, mime_type: None, duration_ms: None, width: None, height: None,
        native_hash: None, native_hash_algo: None, provider_modified_at: None,
    }).await.unwrap();

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
    let v1 = seed_full_video(&repo, &conn, Provider::GoogleDrive, "f1", "fav.mp4", None, None, None).await;
    let v2 = seed_full_video(&repo, &conn, Provider::GoogleDrive, "f2", "rated.mp4", None, None, None).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "f3", "plain.mp4", None, None, None).await;

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
    let v1 = seed_full_video(&repo, &conn, Provider::GoogleDrive, "f1", "fav.mp4", None, None, None).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "f2", "nofav.mp4", None, None, None).await;
    set_favorite(&repo, &owner, &v1).await;

    let (status, body) =
        get_json(app, "/api/videos?favorites_only=true", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1, "only the favorited video");
    assert_eq!(body["videos"][0]["name"], "fav.mp4");
}

#[tokio::test]
async fn min_rating_filter() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;
    let owner = owner_id(&repo).await;
    let v1 = seed_full_video(&repo, &conn, Provider::GoogleDrive, "f1", "high.mp4", None, None, None).await;
    let v2 = seed_full_video(&repo, &conn, Provider::GoogleDrive, "f2", "low.mp4", None, None, None).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "f3", "unrated.mp4", None, None, None).await;
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
    let v1 = seed_full_video(&repo, &conn, Provider::GoogleDrive, "f1", "top.mp4", None, None, None).await;
    let v2 = seed_full_video(&repo, &conn, Provider::GoogleDrive, "f2", "mid.mp4", None, None, None).await;
    seed_full_video(&repo, &conn, Provider::GoogleDrive, "f3", "unrated.mp4", None, None, None).await;
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
