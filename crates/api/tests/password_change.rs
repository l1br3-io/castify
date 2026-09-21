mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use castify_api::app::build_app;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery staple";
const NEW_PASSWORD: &str = "staple battery horse correct";

/// Boot a fresh app, run first-run setup, and return the app + session
/// cookie (`castify_session=<value>`) + db-path guard. Mirrors the harness
/// in `tests/session.rs`.
async fn boot_and_setup() -> (axum::Router, String, tempfile::TempDir) {
    let (state, guard, _path) = common::fresh_state().await;
    let app = build_app(state);
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
    let raw = response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .expect("setup sets a cookie")
        .to_str()
        .unwrap();
    let cookie = raw.split(';').next().unwrap().to_string();
    (app, cookie, guard)
}

/// Fetch a CSRF token via the authenticated `GET /api/csrf` endpoint
/// (double-submit pattern — see `tests/session.rs`).
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

/// `PUT /api/session/password` with optional cookie / CSRF header. Returns
/// `(status, body, set_cookie)`.
async fn put_password(
    app: axum::Router,
    cookie: Option<&str>,
    csrf: Option<&str>,
    current: &str,
    new: &str,
) -> (StatusCode, Value, Option<String>) {
    let mut builder = Request::builder()
        .method("PUT")
        .uri("/api/session/password")
        .header("content-type", "application/json");
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    if let Some(token) = csrf {
        builder = builder.header("x-csrf-token", token);
        // Double-submit: token rides both as header and as csrf cookie.
        builder = builder.header(
            "cookie",
            match cookie {
                Some(existing) => format!("{existing}; castify_csrf={token}"),
                None => format!("castify_csrf={token}"),
            },
        );
    }
    let response = app
        .oneshot(
            builder
                .body(Body::from(Bytes::from(
                    serde_json::json!({
                        "current_password": current,
                        "new_password": new,
                    })
                    .to_string(),
                )))
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

/// `GET /api/session` with an optional cookie — session-liveness probe.
async fn get_session(app: axum::Router, cookie: &str) -> StatusCode {
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/session")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    response.status()
}

/// `POST /api/session` password login attempt. Returns `(status, body)`.
async fn try_login(app: axum::Router, password: &str) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    serde_json::json!({"password": password}).to_string(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

/// Login via `POST /api/session` and return the `castify_session=<value>`
/// cookie — a second "device" distinct from the setup session.
async fn login_session(app: axum::Router, password: &str) -> String {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    serde_json::json!({"password": password}).to_string(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "login must succeed");
    let raw = response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .expect("login sets a cookie")
        .to_str()
        .unwrap();
    raw.split(';').next().unwrap().to_string()
}

#[tokio::test]
async fn change_password_returns_204_and_revokes_every_session() {
    let (app, cookie, _guard) = boot_and_setup().await;
    let csrf = fetch_csrf(app.clone(), &cookie).await;

    let (status, body, set_cookie) = put_password(
        app.clone(),
        Some(&cookie),
        Some(&csrf),
        PASSWORD,
        NEW_PASSWORD,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "body = {body}");
    let cleared = set_cookie.expect("change must emit a Set-Cookie");
    assert!(
        cleared.contains("castify_session=") && cleared.contains("Max-Age=0"),
        "cookie must be cleared with Max-Age=0: {cleared}"
    );

    // The acting browser's own session is dead — it 401s on next use.
    assert_eq!(
        get_session(app.clone(), &cookie).await,
        StatusCode::UNAUTHORIZED
    );

    // New password logs in; old one no longer does.
    let (status, _body) = try_login(app.clone(), NEW_PASSWORD).await;
    assert_eq!(status, StatusCode::OK, "new password must log in");
    let (status, _body) = try_login(app, PASSWORD).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "old password must fail");
}

/// The effort's headline guarantee, observed through the HTTP endpoint:
/// a change on device A kills device B's session too — every previously
/// issued cookie 401s afterwards, not just the acting browser's.
#[tokio::test]
async fn change_password_revokes_sessions_of_other_devices() {
    let (app, cookie_a, _guard) = boot_and_setup().await;
    let cookie_b = login_session(app.clone(), PASSWORD).await;
    assert_eq!(get_session(app.clone(), &cookie_b).await, StatusCode::OK);

    let csrf = fetch_csrf(app.clone(), &cookie_a).await;
    let (status, body, _) = put_password(
        app.clone(),
        Some(&cookie_a),
        Some(&csrf),
        PASSWORD,
        NEW_PASSWORD,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "body = {body}");

    // Device B did not make the request, but its session dies all the same.
    assert_eq!(
        get_session(app.clone(), &cookie_b).await,
        StatusCode::UNAUTHORIZED
    );
    // The acting browser (device A) is signed out too.
    assert_eq!(get_session(app, &cookie_a).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_current_password_is_generic_401_and_changes_nothing() {
    let (app, cookie, _guard) = boot_and_setup().await;
    let csrf = fetch_csrf(app.clone(), &cookie).await;

    // Reference body: what a wrong-password login failure looks like.
    let (_, login_body) = try_login(app.clone(), "definitely not it").await;

    let (status, body, set_cookie) = put_password(
        app.clone(),
        Some(&cookie),
        Some(&csrf),
        "wrong current",
        NEW_PASSWORD,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "body = {body}");
    // No oracle: the change attempt is indistinguishable from login failure.
    assert_eq!(body, login_body, "must match login-failure error body");
    assert!(set_cookie.is_none(), "no cookie churn on failure");

    // Ordering guarantee exercised: the failed attempt (which would have hit
    // the hash write first) leaves the old password AND old sessions intact.
    assert_eq!(get_session(app.clone(), &cookie).await, StatusCode::OK);
    let (status, _body) = try_login(app, PASSWORD).await;
    assert_eq!(status, StatusCode::OK, "old password must still work");
}

#[tokio::test]
async fn invalid_new_password_is_400_and_changes_nothing() {
    let (app, cookie, _guard) = boot_and_setup().await;
    let csrf = fetch_csrf(app.clone(), &cookie).await;

    let too_short = "short";
    assert!(too_short.chars().count() < 8);
    let (status, body, _) =
        put_password(app.clone(), Some(&cookie), Some(&csrf), PASSWORD, too_short).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");

    let too_long = "x".repeat(257);
    let (status, body, _) =
        put_password(app.clone(), Some(&cookie), Some(&csrf), PASSWORD, &too_long).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");

    // No state changed: hash untouched, sessions alive.
    assert_eq!(get_session(app.clone(), &cookie).await, StatusCode::OK);
    let (status, _body) = try_login(app, PASSWORD).await;
    assert_eq!(status, StatusCode::OK, "old password must still work");
}

#[tokio::test]
async fn change_password_requires_a_session() {
    let (app, _cookie, _guard) = boot_and_setup().await;
    let (status, _body, _) = put_password(app, None, None, PASSWORD, NEW_PASSWORD).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn change_password_requires_a_csrf_token() {
    let (app, cookie, _guard) = boot_and_setup().await;
    let (status, _body, _) = put_password(app, Some(&cookie), None, PASSWORD, NEW_PASSWORD).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
