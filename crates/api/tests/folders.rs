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
    CatalogRepository, DiscoveredFile, FileKind, NewConnection, NewVideo, Provider, TokenBundle,
};

mod common;

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
            token_bundle: sample_bundle(),
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
