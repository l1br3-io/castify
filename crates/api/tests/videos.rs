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
