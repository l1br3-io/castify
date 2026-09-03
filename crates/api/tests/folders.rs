// Folder organizer API tests (M9): `GET /api/folders/tree` (task 006) and
// `GET /api/folders/contents` (task 007). Seeds rows directly via the
// repository — same conventions as videos.rs.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use castify_catalog::{
    CatalogRepository, Credential, DiscoveredFile, FileKind, NewConnection, NewVideo, Provider,
    TokenBundle,
};

mod common;

fn sample_credential() -> Credential {
    Credential::OAuth(sample_bundle())
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

async fn boot_and_setup() -> (Router, String, CatalogRepository, tempfile::TempPath) {
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
                .body(Body::from(
                    r#"{"display_name":"Jane","password":"correct horse battery staple"}"#
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .expect("session cookie")
        .to_string();
    (app, cookie, repo, guard)
}

async fn get_json(app: Router, uri: &str, cookie: Option<&str>) -> (StatusCode, Value) {
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

async fn seed_connection(repo: &CatalogRepository, provider: Provider) -> String {
    let conn = repo
        .create_connection(&NewConnection {
            provider,
            credential: sample_credential(),
            provider_account_id: Some("acct".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();
    conn.id
}

async fn seed_file(
    repo: &CatalogRepository,
    conn_id: &str,
    file_id: &str,
    name: &str,
    path: Option<&str>,
    kind: FileKind,
) {
    repo.upsert_file(
        conn_id,
        &DiscoveredFile {
            provider_file_id: file_id.into(),
            name: name.into(),
            path: path.map(str::to_string),
            size_bytes: 10,
            mime_type: None,
            kind,
            provider_modified_at: None,
        },
    )
    .await
    .unwrap();
}

// ── GET /api/folders/tree (M9 FR-4) ──────────────────────────────────

#[tokio::test]
async fn folders_tree_requires_auth() {
    let (app, _cookie, _repo, _guard) = boot_and_setup().await;
    let (status, _) = get_json(app, "/api/folders/tree", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn folders_tree_returns_nested_nodes_over_videos_and_files() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;

    repo.upsert_video(
        &conn,
        Provider::GoogleDrive,
        &NewVideo {
            provider_file_id: "f1".into(),
            name: "movie.mp4".into(),
            path: Some("/Media/Movies/movie.mp4".into()),
            size_bytes: 1_000,
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
    seed_file(
        &repo,
        &conn,
        "x1",
        "song.mp3",
        Some("/Media/Music/song.mp3"),
        FileKind::Audio,
    )
    .await;
    seed_file(
        &repo,
        &conn,
        "x2",
        "poster.jpg",
        Some("/poster.jpg"),
        FileKind::Image,
    )
    .await;

    let (status, body) = get_json(app, "/api/folders/tree", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);

    // Top level: (Root) + Media.
    let top = body.as_array().expect("array of top-level nodes");
    let media = top
        .iter()
        .find(|n| n["name"] == "Media")
        .expect("Media node");
    assert_eq!(media["path"], "/Media");
    assert_eq!(media["video_count"], 1, "cumulative: Movies' video");
    assert_eq!(media["file_count"], 1, "cumulative: Music's file");

    let children = media["children"].as_array().expect("children");
    let movies = children
        .iter()
        .find(|c| c["name"] == "Movies")
        .expect("Movies");
    assert_eq!(movies["video_count"], 1);
    assert_eq!(movies["file_count"], 0);

    let root = top.iter().find(|n| n["name"] == "(Root)").expect("(Root)");
    assert_eq!(root["file_count"], 1, "poster.jpg is a root-level file");
    assert_eq!(root["video_count"], 0);
}

// ── GET /api/folders/contents (M9 FR-5) ──────────────────────────────

#[tokio::test]
async fn folders_contents_requires_auth() {
    let (app, _cookie, _repo, _guard) = boot_and_setup().await;
    let (status, _) = get_json(app, "/api/folders/contents", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn folders_contents_returns_mixed_sorted_entries() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo, Provider::GoogleDrive).await;

    repo.upsert_video(
        &conn,
        Provider::GoogleDrive,
        &NewVideo {
            provider_file_id: "v1".into(),
            name: "Zeta.mp4".into(),
            path: Some("/Movies/Zeta.mp4".into()),
            size_bytes: 1_000,
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
    seed_file(
        &repo,
        &conn,
        "x1",
        "Alpha.mp3",
        Some("/Movies/Alpha.mp3"),
        FileKind::Audio,
    )
    .await;
    // Deeper entry — excluded from the direct-children listing.
    seed_file(
        &repo,
        &conn,
        "x2",
        "nested.txt",
        Some("/Movies/Deep/nested.txt"),
        FileKind::Document,
    )
    .await;

    let (status, body) = get_json(
        app.clone(),
        "/api/folders/contents?path=%2FMovies",
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    assert_eq!(body["total"], 2);
    let entries = body["entries"].as_array().expect("entries");
    // Name-asc across kinds: Alpha (file) before Zeta (video).
    assert_eq!(entries[0]["kind"], "audio");
    assert_eq!(entries[0]["name"], "Alpha.mp3");
    assert_eq!(entries[0]["provider"], "google_drive");
    assert_eq!(entries[1]["kind"], "video");
    assert_eq!(entries[1]["name"], "Zeta.mp4");
    // Video entries carry the enriched fields PosterCard needs.
    assert_eq!(entries[1]["is_favorite"], false);
    assert!(entries[1]["my_rating"].is_null());
    assert_eq!(entries[1]["thumbnail_status"], "pending");

    // Kind filter isolates videos.
    let (_, video_only) = get_json(
        app.clone(),
        "/api/folders/contents?path=%2FMovies&kind=video",
        Some(&cookie),
    )
    .await;
    assert_eq!(video_only["total"], 1);
    assert_eq!(video_only["entries"][0]["kind"], "video");

    // q filter is a plain name contains.
    let (_, zeta) = get_json(
        app,
        "/api/folders/contents?path=%2FMovies&q=zeta",
        Some(&cookie),
    )
    .await;
    assert_eq!(zeta["total"], 1);
    assert_eq!(zeta["entries"][0]["name"], "Zeta.mp4");
}

// ── GET /api/files/{id}/download (M9 FR-6) ───────────────────────────
// These need the e2e mock provider (open_stream against canned bytes).

#[cfg(feature = "e2e")]
mod file_download {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn get_bytes(
        app: Router,
        uri: &str,
        cookie: Option<&str>,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut builder = Request::builder().method("GET").uri(uri);
        if let Some(c) = cookie {
            builder = builder.header("cookie", c);
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
    async fn file_download_requires_auth() {
        let (app, _cookie, _repo, _guard) = boot_and_setup().await;
        let (status, _, _) = get_bytes(app, "/api/files/whatever/download", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn file_download_streams_attachment_with_mock_bytes() {
        let (app, cookie, repo, _guard) = boot_and_setup().await;
        let conn = seed_connection(&repo, Provider::GoogleDrive).await;
        seed_file(
            &repo,
            &conn,
            "gd-f-song",
            "song.mp3",
            Some("/Media/Music/song.mp3"),
            FileKind::Audio,
        )
        .await;

        let file_id: String = file_row_id(&repo, "gd-f-song").await;
        let (status, headers, bytes) = get_bytes(
            app,
            &format!("/api/files/{file_id}/download"),
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // Provider MIME must not be forwarded — an attachment is served as
        // opaque bytes, never a provider-chosen (possibly text/html) type.
        assert_eq!(
            headers.get("content-type").and_then(|v| v.to_str().ok()),
            Some("application/octet-stream")
        );
        // Global defense-in-depth layer (MIME-confusion / sniffing).
        assert_eq!(
            headers
                .get("x-content-type-options")
                .and_then(|v| v.to_str().ok()),
            Some("nosniff")
        );
        let disposition = headers
            .get("content-disposition")
            .and_then(|v| v.to_str().ok())
            .expect("content-disposition present");
        assert!(
            disposition.starts_with("attachment;"),
            "disposition: {disposition}"
        );
        assert!(
            disposition.contains("filename=\"song.mp3\""),
            "disposition: {disposition}"
        );
        let body = String::from_utf8(bytes).unwrap();
        assert!(
            body.starts_with("e2e mock file content: gd-f-song"),
            "mock text bytes: {body}"
        );
    }

    #[tokio::test]
    async fn file_download_404_unknown_id() {
        let (app, cookie, _repo, _guard) = boot_and_setup().await;
        let (status, _, _) = get_bytes(app, "/api/files/no-such-id/download", Some(&cookie)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// FR-6.2: a file whose connection was disconnected is 404 — the SQL
    /// join filters `disconnected_at IS NULL`, mirroring videos.
    #[tokio::test]
    async fn file_download_404_inactive_connection() {
        let (app, cookie, repo, _guard) = boot_and_setup().await;
        let conn = seed_connection(&repo, Provider::GoogleDrive).await;
        seed_file(
            &repo,
            &conn,
            "gd-f-stale",
            "stale.mp3",
            Some("/Media/Music/stale.mp3"),
            FileKind::Audio,
        )
        .await;
        sqlx::query("UPDATE provider_connections SET disconnected_at = '2026-01-01T00:00:00Z'")
            .execute(repo.pool())
            .await
            .unwrap();

        let file_id = file_row_id(&repo, "gd-f-stale").await;
        let (status, _, _) = get_bytes(
            app,
            &format!("/api/files/{file_id}/download"),
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// Exact-match row id for a provider_file_id (no LIKE involved).
    async fn file_row_id(repo: &CatalogRepository, provider_file_id: &str) -> String {
        sqlx::query_scalar("SELECT id FROM files WHERE provider_file_id = ?")
            .bind(provider_file_id)
            .fetch_one(repo.pool())
            .await
            .unwrap()
    }
}
