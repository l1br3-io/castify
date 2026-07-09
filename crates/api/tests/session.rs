mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use castify_api::app::build_app;
use castify_storage::{connect, run_migrations};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery staple";

/// Convenience: spin up a fresh app, run first-run setup, and return the
/// session cookie (`castify_session=<value>`) plus the state + db guard so
/// callers can drive additional requests through the same instance.
async fn boot_and_setup() -> (
    axum::Router,
    String,
    castify_api::state::AppState,
    tempfile::TempPath,
) {
    let (state, guard, _path) = common::fresh_state().await;
    let app = build_app(state.clone());
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
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "setup must succeed first"
    );
    let cookie = extract_cookie(response.headers()).expect("setup sets a cookie");
    (app, cookie, state, guard)
}

fn extract_cookie(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::SET_COOKIE)?.to_str().ok()?;
    let pair = raw.split(';').next()?;
    if pair.is_empty() {
        None
    } else {
        Some(pair.to_string())
    }
}

async fn post_session(
    app: axum::Router,
    body: &str,
    cookie: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/api/session")
        .header("content-type", "application/json");
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    let response = app
        .oneshot(
            builder
                .body(Body::from(Bytes::from(body.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let set_cookie = response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value, set_cookie)
}

async fn get_session(app: axum::Router, cookie: Option<&str>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method("GET").uri("/api/session");
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

async fn delete_session(
    app: axum::Router,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> (StatusCode, Option<String>) {
    let mut builder = Request::builder().method("DELETE").uri("/api/session");
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    if let Some(token) = csrf {
        // The double-submit pattern: the token travels both as a cookie
        // (readable by JS) and as a header. The test client emulates this by
        // appending the csrf cookie to the same Cookie header and setting
        // X-CSRF-Token to the token value.
        builder = builder.header("x-csrf-token", token);
        if let Some(existing) = cookie {
            builder = builder.header("cookie", format!("{existing}; castify_csrf={token}"));
        } else {
            builder = builder.header("cookie", format!("castify_csrf={token}"));
        }
    }
    let response = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let set_cookie = response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    (status, set_cookie)
}

/// Fetch a CSRF token via the authenticated `GET /api/csrf` endpoint. Returns
/// the token value extracted from the JSON body. The accompanying Set-Cookie
/// is not retained — the test client sends it inline on the next request via
/// `delete_session(..., Some(token))`.
async fn fetch_csrf(app: axum::Router, cookie: &str) -> String {
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/csrf")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    value["token"].as_str().expect("csrf token").to_string()
}

#[tokio::test]
async fn login_succeeds_with_correct_password() {
    let (app, _setup_cookie, _state, _guard) = boot_and_setup().await;
    let (status, body, cookie) = post_session(
        app,
        &serde_json::json!({"password": PASSWORD}).to_string(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["owner"]["display_name"], "Jane");
    assert!(body["owner"]["id"].is_string());
    let cookie = cookie.expect("login must set a cookie");
    assert!(
        cookie.contains("castify_session="),
        "missing cookie name: {cookie}"
    );
    assert!(cookie.contains("HttpOnly"), "must be HttpOnly: {cookie}");
}

#[tokio::test]
async fn login_fails_with_wrong_password() {
    let (app, _setup_cookie, _state, _guard) = boot_and_setup().await;
    let (status, _body, cookie) = post_session(
        app,
        &serde_json::json!({"password": "wrong password"}).to_string(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(cookie.is_none(), "no cookie should be set on failure");
}

#[tokio::test]
async fn login_fails_when_no_owner_exists() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = build_app(state);
    let (status, _body, _cookie) = post_session(
        app,
        &serde_json::json!({"password": PASSWORD}).to_string(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn login_validates_oversized_display_name() {
    let (app, _setup_cookie, _state, _guard) = boot_and_setup().await;
    let long_name = "x".repeat(81);
    let (status, _body, _cookie) = post_session(
        app,
        &serde_json::json!({"display_name": long_name, "password": PASSWORD}).to_string(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn get_session_returns_owner_with_valid_cookie() {
    let (app, setup_cookie, _state, _guard) = boot_and_setup().await;
    let (status, body) = get_session(app, Some(&setup_cookie)).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["owner"]["display_name"], "Jane");
    assert!(body["owner"]["id"].is_string());
}

#[tokio::test]
async fn get_session_returns_401_without_cookie() {
    let (app, _setup_cookie, _state, _guard) = boot_and_setup().await;
    let (status, body) = get_session(app, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("unauthorized"),
        "body = {body}"
    );
}

#[tokio::test]
async fn get_session_returns_401_with_tampered_cookie() {
    let (app, _setup_cookie, _state, _guard) = boot_and_setup().await;
    let tampered = "castify_session=tampered.deadbeef".to_string();
    let (status, _body) = get_session(app, Some(&tampered)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn logout_returns_204_and_clears_cookie() {
    let (app, setup_cookie, _state, _guard) = boot_and_setup().await;
    let csrf = fetch_csrf(app.clone(), &setup_cookie).await;
    let (status, set_cookie) = delete_session(app, Some(&setup_cookie), Some(&csrf)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let cleared = set_cookie.expect("logout must emit a Set-Cookie");
    assert!(
        cleared.contains("castify_session=") && cleared.contains("Max-Age=0"),
        "cookie must be cleared with Max-Age=0: {cleared}"
    );
}

#[tokio::test]
async fn logout_blocks_subsequent_get_on_same_state() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = build_app(state.clone());
    // Setup
    let resp = app
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
    let cookie = extract_cookie(resp.headers()).unwrap();

    // Logout (with CSRF)
    let csrf = fetch_csrf(app.clone(), &cookie).await;
    let (logout_status, _) = delete_session(app.clone(), Some(&cookie), Some(&csrf)).await;
    assert_eq!(logout_status, StatusCode::NO_CONTENT);

    // GET with the now-invalidated cookie must 401.
    let (status, _body) = get_session(app, Some(&cookie)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn logout_without_cookie_is_rejected() {
    // Logout is gated by the auth middleware like every other authenticated
    // `/api/*` route — an unauthenticated caller is not allowed to discover
    // whether the endpoint exists, so we return 401 (not 204).
    let (app, _setup_cookie, _state, _guard) = boot_and_setup().await;
    let (status, _set_cookie) = delete_session(app, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn session_survives_restart_with_persisted_secret() {
    let (state, guard, path) = common::fresh_state().await;
    let app = build_app(state.clone());
    // First-run setup creates the owner + session and persists the session
    // secret to app_meta.
    let resp = app
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
    assert_eq!(resp.status(), StatusCode::OK);
    let cookie = extract_cookie(resp.headers()).unwrap();

    // Simulate a process restart: drop the state, reconnect to the same
    // on-disk db, re-resolve the secret (must read the persisted value, not
    // generate a fresh one), and rebuild the app.
    drop(state);
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let secret = castify_auth::SessionSecret::resolve(&pool, None)
        .await
        .unwrap();
    let config = castify_core::Config {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        log_level: "warn".to_string(),
        data_dir: std::env::temp_dir().join("castify-restart-test"),
        database_path: path.clone(),
    };
    let new_state = castify_api::state::AppState::new(config, pool, secret);
    let new_app = build_app(new_state);

    let (status, body) = get_session(new_app, Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK, "session should survive restart");
    assert_eq!(body["owner"]["display_name"], "Jane");
    // Hold the temp path guard for the test lifetime.
    drop(guard);
}
