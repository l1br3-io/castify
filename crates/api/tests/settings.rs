//! Integration tests for the runtime transcode toggle (Settings page).
//!
//! Task 001 scope: the GET/PUT contract — startup value comes from the env
//! config default (no settings row yet), PUT persists to the `settings`
//! table *then* flips the runtime flag, the next request sees the new
//! value, and `/api/admin/transcode` reflects the same runtime flag.
//! Auth/CSRF-negative and restart-semantics coverage extends this file in
//! task 002.

mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use castify_api::app::build_app;

const PASSWORD: &str = "correct horse battery staple";

/// Run the setup wizard so the test holds a valid session cookie.
async fn setup_owner(app: &axum::Router) -> String {
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
    response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .expect("session cookie")
}

async fn get_json(app: &axum::Router, session_cookie: &str, uri: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("cookie", session_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
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
async fn csrf_request_parts(app: &axum::Router, session_cookie: &str) -> (String, String) {
    let (token, csrf_cookie) = fetch_csrf(app, session_cookie).await;
    let cookies = format!("{session_cookie}; {csrf_cookie}");
    (token, cookies)
}

#[tokio::test]
async fn transcode_toggle_roundtrips_persists_and_gates_admin() {
    let (state, guard, path) = common::fresh_state_with(|c| c.transcode.enabled = false).await;
    let app = build_app(state);

    let cookie = setup_owner(&app).await;

    // Startup: no settings row yet → the env-config default (false).
    let (status, body) = get_json(&app, &cookie, "/api/settings/transcode").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], false, "startup value = env-config default");

    // The admin endpoint reads the same runtime flag.
    let (status, body) = get_json(&app, &cookie, "/api/admin/transcode").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], false, "admin reflects runtime flag");

    // PUT persists then flips; the response carries the new state.
    let (token, cookies) = csrf_request_parts(&app, &cookie).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/settings/transcode")
                .header("cookie", &cookies)
                .header("x-csrf-token", &token)
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    serde_json::json!({"enabled": true}).to_string(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["enabled"], true, "PUT returns the new state");

    // The next request sees the new value without a restart (FR-4)…
    let (status, body) = get_json(&app, &cookie, "/api/settings/transcode").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], true);

    // …and every gate flips with it.
    let (status, body) = get_json(&app, &cookie, "/api/admin/transcode").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["enabled"], true,
        "admin reflects runtime flag after PUT"
    );

    // The value is durable: a fresh connection over the same db file sees
    // the persisted row.
    let pool = castify_storage::connect(&path).await.unwrap();
    let (value,): (String,) =
        sqlx::query_as("SELECT value FROM settings WHERE key = 'transcode_enabled'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(value, "true");
    pool.close().await;
    drop(guard);
}
