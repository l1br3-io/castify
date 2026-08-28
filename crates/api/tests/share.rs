//! Recipient-facing share endpoints — integration tests (tasks 003+004).
//!
//! Every request here carries **no session cookie**: the `/api/share/`
//! surface is pre-auth by design, so these tests double as proof that the
//! middleware allowlist lets recipients through. The status matrix (404 /
//! 410 / 401 / 200) lives at the HTTP boundary because that is the
//! contract the SPA consumes.

mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use castify_api::shares::token::{hash_share_token, issue_unlock_value};
use castify_api::state::AppState;
use castify_api::shares::{NewShare, ShareRepository};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tower::ServiceExt;

/// Boot a fresh app with first-run setup done (an owner row must exist for
/// shares to reference). Recipient requests never use the session cookie.
async fn boot() -> (axum::Router, AppState, tempfile::TempPath) {
    let (state, guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    json!({"display_name":"Jane","password":"correct horse battery staple"})
                        .to_string(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    (app, state, guard)
}

/// One catalog connection + `names.len()` videos (same seed shape as
/// `tests/shares.rs`). Returns video ids in insertion order.
async fn seed_videos(pool: &SqlitePool, names: &[&str]) -> Vec<String> {
    sqlx::query(
        "INSERT INTO provider_connections (id, provider, token_bundle, connected_at) \
         VALUES ('c1', 'google_drive', x'00', '2026-01-01T00:00:00Z')",
    )
    .execute(pool)
    .await
    .unwrap();
    let mut ids = Vec::with_capacity(names.len());
    for name in names {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos (id, connection_id, provider, provider_file_id, name, \
             size_bytes, duration_ms, scanned_at, created_at) \
             VALUES (?, 'c1', 'google_drive', ?, ?, 1, 60000, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(&id)
        .bind(name)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
        ids.push(id);
    }
    ids
}

async fn owner_uuid(pool: &SqlitePool) -> uuid::Uuid {
    let id: String = sqlx::query_scalar("SELECT id FROM owners LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap();
    uuid::Uuid::parse_str(&id).unwrap()
}

struct SeededShare {
    token: String,
    id: String,
}

/// Seed a share straight through the repository (bypasses the API's
/// future-expiry validation so expired/revoked rows can exist) and return
/// its raw token + id.
async fn seed_share(
    state: &AppState,
    password: Option<&str>,
    expires_at: Option<&str>,
    video_ids: &[String],
) -> SeededShare {
    let owner = owner_uuid(state.pool()).await;
    let token = castify_api::shares::token::generate_share_token();
    let row = ShareRepository::new(state.pool().clone())
        .create_share(&NewShare {
            owner_id: &owner,
            token_hash: &hash_share_token(&token),
            // Hashing a real password here is slow (argon2id); the status
            // machine only checks presence, and unlock verification is
            // task 004 — a placeholder PHC string is enough for 401 paths.
            password_hash: password.map(|_| "$argon2id$placeholder"),
            title: "Trip footage",
            expires_at,
            video_ids,
        })
        .await
        .unwrap();
    SeededShare { token, id: row.id }
}

/// Pre-auth GET — no session, no CSRF. `cookie` extra is for unlock tests.
async fn get(app: axum::Router, uri: &str, cookie: Option<&str>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method("GET").uri(uri);
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    let response = app.oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

// ------------------------------------------------------------- 404 (unknown)

#[tokio::test]
async fn resolve_unknown_token_is_404_without_session() {
    let (app, _state, _guard) = boot().await;
    let (status, _) = get(app, "/api/share/does-not-exist", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn items_unknown_token_is_404_without_session() {
    let (app, _state, _guard) = boot().await;
    let (status, _) = get(app, "/api/share/does-not-exist/items", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ------------------------------------------------- 410 (revoked / expired)

#[tokio::test]
async fn revoked_share_is_410_share_unavailable_on_resolve_and_items() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, None, None, &videos).await;
    ShareRepository::new(state.pool().clone())
        .revoke(&share.id)
        .await
        .unwrap();

    let (status, body) = get(app.clone(), &format!("/api/share/{}", share.token), None).await;
    assert_eq!(status, StatusCode::GONE, "body = {body}");
    assert_eq!(body["code"], "share_unavailable");

    let (status, body) = get(app, &format!("/api/share/{}/items", share.token), None).await;
    assert_eq!(status, StatusCode::GONE, "body = {body}");
    assert_eq!(body["code"], "share_unavailable");
}

#[tokio::test]
async fn expired_share_is_410_share_unavailable() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, None, Some("2000-01-01T00:00:00Z"), &videos).await;

    let (status, _) = get(app.clone(), &format!("/api/share/{}", share.token), None).await;
    assert_eq!(status, StatusCode::GONE);

    let (status, _) = get(app, &format!("/api/share/{}/items", share.token), None).await;
    assert_eq!(status, StatusCode::GONE);
}

// ------------------------------------------------------------- 401 (locked)

#[tokio::test]
async fn locked_share_items_without_unlock_is_401_share_locked() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, Some("pw"), None, &videos).await;

    let (status, body) = get(app, &format!("/api/share/{}/items", share.token), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "body = {body}");
    assert_eq!(body["code"], "share_locked");
}

#[tokio::test]
async fn locked_share_resolve_is_200_with_locked_true_and_no_items() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;
    let share = seed_share(&state, Some("pw"), None, &videos).await;

    let (status, body) = get(app, &format!("/api/share/{}", share.token), None).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["locked"], true);
    assert_eq!(body["status"], "active");
    assert_eq!(body["title"], "Trip footage");
    assert_eq!(body["item_count"], 2);

    // Field contract: title/count/locked/status only — no items, no video
    // metadata, no token/password material may leak pre-unlock.
    let mut keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["item_count", "locked", "status", "title"]);
}

#[tokio::test]
async fn garbage_unlock_cookie_does_not_unlock_items() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, Some("pw"), None, &videos).await;

    let (status, _) = get(
        app,
        &format!("/api/share/{}/items", share.token),
        Some("castify_share_unlock=tampered-garbage"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn unlock_cookie_for_a_different_share_does_not_unlock() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, Some("pw"), None, &videos).await;
    let other = seed_share(&state, None, None, &videos).await;

    // Properly signed by the real secret, but scoped to the other share.
    let foreign = issue_unlock_value(state.session_secret(), &other.id).unwrap();
    let (status, _) = get(
        app,
        &format!("/api/share/{}/items", share.token),
        Some(&format!("castify_share_unlock={foreign}")),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn valid_unlock_cookie_unlocks_items_and_flips_resolve_locked() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, Some("pw"), None, &videos).await;
    let cookie_value = issue_unlock_value(state.session_secret(), &share.id).unwrap();
    let cookie = format!("castify_share_unlock={cookie_value}");

    let (status, body) = get(
        app.clone(),
        &format!("/api/share/{}", share.token),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["locked"], false, "a current unlock flips locked");

    let (status, _) = get(app, &format!("/api/share/{}/items", share.token), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
}

// ---------------------------------------------------------------- 200 (live)

#[tokio::test]
async fn open_share_resolves_200_unlocked_without_session() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, None, None, &videos).await;

    let (status, body) = get(app, &format!("/api/share/{}", share.token), None).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["locked"], false);
    assert_eq!(body["status"], "active");
    assert_eq!(body["item_count"], 1);
}

#[tokio::test]
async fn items_returns_member_metadata_in_curation_order_with_neutral_personalization() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["first.mp4", "second.mp4", "third.mp4"]).await;
    // Curated order deliberately differs from catalog insertion order.
    let curated = vec![videos[2].clone(), videos[0].clone(), videos[1].clone()];
    let share = seed_share(&state, None, None, &curated).await;

    let (status, body) = get(app, &format!("/api/share/{}/items", share.token), None).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");

    let items = body.as_array().expect("items is an array");
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["id"], curated[0]);
    assert_eq!(items[1]["id"], curated[1]);
    assert_eq!(items[2]["id"], curated[2]);
    assert_eq!(items[0]["name"], "third.mp4");

    // Existing video DTO shape, but personalization must be neutral — the
    // owner's favorites/ratings/progress never leak to recipients.
    assert_eq!(items[0]["is_favorite"], false);
    assert!(items[0]["my_rating"].is_null());
    assert!(items[0]["position_seconds"].is_null());
    assert_eq!(items[0]["completed"], false);
    assert_eq!(items[0]["duration_ms"], 60000);
    assert!(items[0]["sources"].as_array().is_some_and(|s| !s.is_empty()));
}

// ------------------------------------------------- unlock (task 004)

/// Like [`seed_share`] but with a REAL argon2id hash — unlock actually
/// verifies the password, so placeholders won't do.
async fn seed_password_share(
    state: &AppState,
    password: &str,
    video_ids: &[String],
) -> SeededShare {
    let owner = owner_uuid(state.pool()).await;
    let token = castify_api::shares::token::generate_share_token();
    let password_hash = castify_auth::password::hash_password(password).unwrap();
    let row = ShareRepository::new(state.pool().clone())
        .create_share(&NewShare {
            owner_id: &owner,
            token_hash: &hash_share_token(&token),
            password_hash: Some(&password_hash),
            title: "Trip footage",
            expires_at: None,
            video_ids,
        })
        .await
        .unwrap();
    SeededShare { token, id: row.id }
}

/// POST the unlock endpoint — no session, no CSRF (pre-auth by
/// `is_share_unlock_post`). Returns status, the raw `Set-Cookie` header
/// value (present on 204), and the parsed JSON body.
async fn post_unlock(
    app: axum::Router,
    token: &str,
    password: &str,
) -> (StatusCode, Option<String>, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/share/{token}/unlock"))
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    json!({"password": password}).to_string(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, cookie, value)
}

#[tokio::test]
async fn unlock_wrong_password_is_401_share_locked_without_cookie() {
    let (app, state, _guard) = boot().await;
    let share = seed_password_share(&state, "correct horse", &[]).await;

    let (status, cookie, body) = post_unlock(app, &share.token, "wrong").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "body = {body}");
    assert_eq!(body["code"], "share_locked");
    assert!(cookie.is_none(), "a failed unlock must never mint a cookie");
}

#[tokio::test]
async fn unlock_correct_password_is_204_with_scoped_signed_cookie() {
    let (app, state, _guard) = boot().await;
    let share = seed_password_share(&state, "correct horse", &[]).await;

    let (status, cookie, _body) = post_unlock(app, &share.token, "correct horse").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let cookie = cookie.expect("204 must set the unlock cookie");

    // Attribute contract mirrors the session cookie, but scoped to the
    // share surface so it never travels on owner routes. `Secure` is off
    // in the test config (cookie_secure=false), matching local dev.
    assert!(cookie.starts_with("castify_share_unlock="), "got {cookie}");
    assert!(cookie.contains("HttpOnly"), "got {cookie}");
    assert!(cookie.contains("SameSite=Lax"), "got {cookie}");
    assert!(cookie.contains("Path=/api/share/"), "got {cookie}");
    assert!(!cookie.contains("Secure"), "got {cookie}");
}

#[tokio::test]
async fn unlock_cookie_opens_items_and_flips_resolve_locked() {
    // Closes the loop with task 003: the cookie minted by unlock is
    // exactly what the status machine honors on the guarded reads.
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_password_share(&state, "correct horse", &videos).await;

    let (status, cookie, _) = post_unlock(app.clone(), &share.token, "correct horse").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let value = cookie
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .trim_start_matches("castify_share_unlock=")
        .to_string();
    let jar = format!("castify_share_unlock={value}");

    let (status, body) = get(
        app.clone(),
        &format!("/api/share/{}", share.token),
        Some(&jar),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["locked"], false);

    let (status, body) = get(app, &format!("/api/share/{}/items", share.token), Some(&jar)).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn unlock_unknown_token_and_passwordless_share_are_404() {
    let (app, _state, _guard) = boot().await;
    let (status, _, _) = post_unlock(app.clone(), "does-not-exist", "x").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A live open share has no gate to unlock — indistinguishable from a
    // bad URL so the endpoint doesn't leak which tokens are passwordless.
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, None, None, &videos).await;
    let (status, _, _) = post_unlock(app, &share.token, "x").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unlock_on_revoked_share_is_410_share_unavailable() {
    let (app, state, _guard) = boot().await;
    let share = seed_password_share(&state, "correct horse", &[]).await;
    ShareRepository::new(state.pool().clone())
        .revoke(&share.id)
        .await
        .unwrap();

    let (status, _, body) = post_unlock(app, &share.token, "correct horse").await;
    assert_eq!(status, StatusCode::GONE, "body = {body}");
    assert_eq!(body["code"], "share_unavailable");
}

#[tokio::test]
async fn unlock_rate_limit_engages_after_five_failures_even_with_right_password() {
    let (app, state, _guard) = boot().await;
    let share = seed_password_share(&state, "correct horse", &[]).await;

    // Five consecutive wrong passwords: all 401 (the fifth engages the
    // cool-off), and no cookie is ever set.
    for i in 0..5 {
        let (status, cookie, body) = post_unlock(app.clone(), &share.token, "wrong").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "attempt {i}: {body}");
        assert!(cookie.is_none());
    }

    // The cool-off rejects even the CORRECT password — without hashing it.
    let (status, cookie, body) = post_unlock(app.clone(), &share.token, "correct horse").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "body = {body}");
    assert_eq!(body["code"], "rate_limited");
    assert!(cookie.is_none());

    // And the lockout is per-token: a different share still unlocks fine.
    let other = seed_password_share(&state, "other pw", &[]).await;
    let (status, _, _) = post_unlock(app, &other.token, "other pw").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn unlock_rate_limit_counter_resets_on_success() {
    let (app, state, _guard) = boot().await;
    let share = seed_password_share(&state, "correct horse", &[]).await;

    // Four failures, then a success resets the counter to zero.
    for _ in 0..4 {
        let (status, _, _) = post_unlock(app.clone(), &share.token, "wrong").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, _, _) = post_unlock(app.clone(), &share.token, "correct horse").await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Without the reset, a 5th cumulative failure would have engaged the
    // cool-off mid-batch and the correct password would 429. With it, the
    // whole fresh batch of four stays 401 and a fifth failure only then
    // engages — the NEXT attempt (even correct) is 429.
    for i in 0..4 {
        let (status, _, _) = post_unlock(app.clone(), &share.token, "wrong").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "post-reset attempt {i}");
    }
    let (status, _, _) = post_unlock(app.clone(), &share.token, "wrong").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the engaging failure is still 401");
    let (status, _, _) = post_unlock(app, &share.token, "correct horse").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}
