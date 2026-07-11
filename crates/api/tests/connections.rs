mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery staple";

async fn boot_and_setup() -> (axum::Router, String, tempfile::TempPath) {
    let (state, guard, _path) = common::fresh_state().await;
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
    let cookie = extract_cookie(&response);
    (app, cookie, guard)
}

fn extract_cookie(response: &axum::http::Response<Body>) -> String {
    response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .expect("expected a session cookie")
}

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

async fn post_json(
    app: axum::Router,
    uri: &str,
    cookie: Option<&str>,
    csrf_header: Option<&str>,
    csrf_cookie: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json");
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
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

async fn delete(
    app: axum::Router,
    uri: &str,
    cookie: Option<&str>,
    csrf_header: Option<&str>,
    csrf_cookie: Option<&str>,
) -> StatusCode {
    let mut builder = Request::builder().method("DELETE").uri(uri);
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
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    response.status()
}

#[tokio::test]
async fn available_returns_all_false_when_unconfigured() {
    let (app, cookie, _guard) = boot_and_setup().await;
    let (status, body) = get_json(app, "/api/connections/available", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["google_drive"], false);
    assert_eq!(body["dropbox"], false);
    assert_eq!(body["onedrive"], false);
}

#[tokio::test]
async fn list_returns_empty_array() {
    let (app, cookie, _guard) = boot_and_setup().await;
    let (status, body) = get_json(app, "/api/connections", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.is_array());
    assert_eq!(body.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn start_returns_503_when_not_configured() {
    let (app, cookie, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let (status, body) = post_json(
        app,
        "/api/connections/google_drive/start",
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or("")
            .contains("not configured"),
        "body = {body}"
    );
}

#[tokio::test]
async fn start_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = post_json(app, "/api/connections/google_drive/start", None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn dropbox_start_returns_503_when_not_configured() {
    let (app, cookie, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let (status, body) = post_json(
        app,
        "/api/connections/dropbox/start",
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or("")
            .contains("not configured"),
        "body = {body}"
    );
}

#[tokio::test]
async fn dropbox_start_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = post_json(app, "/api/connections/dropbox/start", None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn onedrive_start_returns_503_when_not_configured() {
    let (app, cookie, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let (status, body) = post_json(
        app,
        "/api/connections/onedrive/start",
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or("")
            .contains("not configured"),
        "body = {body}"
    );
}

#[tokio::test]
async fn onedrive_start_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = post_json(app, "/api/connections/onedrive/start", None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn available_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = get_json(app, "/api/connections/available", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn disconnect_nonexistent_returns_404() {
    let (app, cookie, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let status = delete(
        app,
        "/api/connections/nonexistent-id",
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn disconnect_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let status = delete(app, "/api/connections/some-id", None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn list_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = get_json(app, "/api/connections", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
