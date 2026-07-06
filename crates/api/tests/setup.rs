mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

async fn post_setup(body: &str) -> (StatusCode, Value, Option<String>) {
    let app = common::fresh_app().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(body.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value, cookie)
}

#[tokio::test]
async fn setup_with_password_creates_owner_and_sets_cookie() {
    let (status, body, cookie) =
        post_setup(r#"{"display_name":"Jane","password":"correct horse"}"#).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["owner"]["display_name"], "Jane");
    assert!(body["owner"]["id"].is_string());
    let cookie = cookie.expect("session cookie must be set");
    assert!(
        cookie.contains("castify_session="),
        "missing cookie name: {cookie}"
    );
    assert!(
        cookie.contains("HttpOnly"),
        "cookie must be HttpOnly: {cookie}"
    );
    assert!(
        cookie.contains("SameSite=Lax"),
        "cookie must be SameSite=Lax: {cookie}"
    );
}

#[tokio::test]
async fn setup_is_rejected_after_first_call() {
    // First call succeeds and closes setup.
    let (first_status, _, _) =
        post_setup(r#"{"display_name":"Jane","password":"correct horse"}"#).await;
    assert_eq!(first_status, StatusCode::OK);

    // A second, independent app instance must observe that an owner exists.
    // We simulate that by hitting setup on a fresh app with a fresh DB — but
    // the AC is about the same instance. Use the same state by sharing it.
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    r#"{"display_name":"First","password":"correct horse"}"#,
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    r#"{"display_name":"Second","password":"correct horse"}"#,
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn setup_rejects_short_password() {
    let (status, body, _) = post_setup(r#"{"display_name":"Jane","password":"short"}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("password"),
        "body = {body}"
    );
}

#[tokio::test]
async fn setup_rejects_empty_display_name() {
    let (status, _, _) = post_setup(r#"{"display_name":"","password":"correct horse"}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn setup_rejects_malformed_json() {
    let (status, _, _) = post_setup(r#"{"not": valid json"#).await;
    assert!(
        status == StatusCode::BAD_REQUEST || status == StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "unexpected status: {status}"
    );
}

async fn get_setup_status(app: axum::Router) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/setup")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

#[tokio::test]
async fn setup_status_open_when_no_owner() {
    // Fresh DB, no owner — must return 200 {"status":"open"} without a cookie.
    let app = common::fresh_app().await;
    let (status, body) = get_setup_status(app).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["status"], "open", "body = {body}");
}

#[tokio::test]
async fn setup_status_conflict_after_owner_exists() {
    // Establish an owner on a shared app instance, then probe must report closed.
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    r#"{"display_name":"Jane","password":"correct horse"}"#,
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let (status, _body) = get_setup_status(app).await;
    assert_eq!(status, StatusCode::CONFLICT);
}
