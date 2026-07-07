mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

#[tokio::test]
async fn health_returns_ok_with_payload() {
    let app = common::fresh_app().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("request succeeds");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["status"], "ok");
    assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
    assert!(
        value["uptime_seconds"].is_u64(),
        "uptime_seconds must be u64"
    );
    assert_eq!(
        value["db"], "ok",
        "db liveness field must be ok on happy path"
    );
}

#[tokio::test]
async fn unknown_api_route_returns_401_when_unauthenticated() {
    // Auth middleware gates all non-allowlisted `/api/*` paths *before* route
    // matching, so an unauthenticated request to a non-existent `/api/*` path
    // returns 401 rather than 404. This is intentional: it prevents path
    // enumeration by unauthenticated callers.
    let app = common::fresh_app().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/does-not-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn spa_root_serves_html() {
    let app = common::fresh_app().await;
    let response = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(
        body.contains("<div id=\"root\""),
        "expected SPA index, got: {body}"
    );
}

#[tokio::test]
async fn spa_deep_link_serves_html() {
    let app = common::fresh_app().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/some/deep/client/route")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn spa_serves_hashed_asset() {
    let app = common::fresh_app().await;
    let sample = castify_api::spa::list_embedded_assets()
        .into_iter()
        .find(|name| name.starts_with("assets/"))
        .expect("expected at least one embedded asset under assets/");
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/{sample}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
