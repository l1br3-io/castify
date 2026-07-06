mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery staple";

/// Boot a fresh app, run first-run setup, and return the app, the session
/// cookie pair (`castify_session=<value>`), and the temp db guard.
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
    let cookie = response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .expect("setup sets a session cookie");
    (app, cookie, guard)
}

async fn get(
    app: axum::Router,
    uri: &str,
    cookie: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut builder = Request::builder().method("GET").uri(uri);
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
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
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value, set_cookie)
}

async fn delete(
    app: axum::Router,
    uri: &str,
    session_cookie: Option<&str>,
    csrf_cookie: Option<&str>,
    csrf_header: Option<&str>,
) -> StatusCode {
    let mut builder = Request::builder().method("DELETE").uri(uri);
    let mut cookie_parts: Vec<String> = Vec::new();
    if let Some(c) = session_cookie {
        cookie_parts.push(c.to_string());
    }
    if let Some(c) = csrf_cookie {
        cookie_parts.push(format!("castify_csrf={c}"));
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
async fn get_csrf_requires_session() {
    let (app, _session, _guard) = boot_and_setup().await;
    let (status, _body, _set_cookie) = get(app, "/api/csrf", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn get_csrf_returns_token_and_sets_cookie_when_authenticated() {
    let (app, session, _guard) = boot_and_setup().await;
    let (status, body, set_cookie) = get(app, "/api/csrf", Some(&session)).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    let token = body["token"]
        .as_str()
        .expect("csrf response has a token field")
        .to_string();
    assert!(!token.is_empty(), "token must not be empty: {body}");
    let set_cookie = set_cookie.expect("csrf endpoint must set a cookie");
    assert!(
        set_cookie.contains("castify_csrf="),
        "missing csrf cookie: {set_cookie}"
    );
    // The cookie must NOT be HttpOnly — client JS needs to read it.
    assert!(
        !set_cookie.contains("HttpOnly"),
        "csrf cookie must not be HttpOnly: {set_cookie}"
    );
}

#[tokio::test]
async fn protected_route_rejects_missing_session() {
    let (app, _session, _guard) = boot_and_setup().await;
    // GET /api/csrf is gated — no cookie → 401.
    let (status, _, _) = get(app, "/api/csrf", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn unknown_api_path_rejects_missing_session() {
    // Unauthenticated requests to unknown `/api/*` paths get 401, not 404 —
    // path enumeration is gated behind auth.
    let app = common::fresh_app().await;
    let (status, _, _) = get(app, "/api/secret-stuff", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn pre_auth_allowlist_passes_without_session() {
    // Each of these must respond with anything other than 401 — they're
    // the routes that establish the session in the first place.
    let app = common::fresh_app().await;
    // /api/health (GET)
    let (status, _, _) = get(app.clone(), "/api/health", None).await;
    assert_eq!(status, StatusCode::OK);
    // POST /api/setup is exercised by boot_and_setup; POST /api/session and
    // the webauthn variants are covered by their dedicated test modules.
}

#[tokio::test]
async fn logout_without_csrf_header_is_forbidden() {
    let (app, session, _guard) = boot_and_setup().await;
    // Session cookie alone is not enough — DELETE is a mutation and needs CSRF.
    let status = delete(app, "/api/session", Some(&session), None, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn logout_with_mismatched_csrf_is_forbidden() {
    let (app, session, _guard) = boot_and_setup().await;
    // Cookie says one token, header says another.
    let status = delete(
        app,
        "/api/session",
        Some(&session),
        Some("cookie-value"),
        Some("header-value"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn logout_with_matching_csrf_succeeds() {
    let (app, session, _guard) = boot_and_setup().await;
    // Fetch a real CSRF token, then echo it back as both cookie and header.
    let (status, body, _) = get(app.clone(), "/api/csrf", Some(&session)).await;
    assert_eq!(status, StatusCode::OK);
    let token = body["token"].as_str().unwrap().to_string();
    let status = delete(
        app,
        "/api/session",
        Some(&session),
        Some(&token),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn safe_method_does_not_require_csrf() {
    // GET on an authenticated route — needs session, no CSRF.
    let (app, session, _guard) = boot_and_setup().await;
    let (status, _, _) = get(app, "/api/session", Some(&session)).await;
    assert_eq!(status, StatusCode::OK);
}
