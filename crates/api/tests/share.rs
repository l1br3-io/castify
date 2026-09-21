//! Recipient-facing share endpoints — integration tests (tasks 003+004).
//!
//! Every request here carries **no session cookie**: the `/api/share/`
//! surface is pre-auth by design, so these tests double as proof that the
//! middleware allowlist lets recipients through. The status matrix (404 /
//! 410 / 401 / 200) lives at the HTTP boundary because that is the
//! contract the SPA consumes.
//!
//! The media-mirror section (task 005) additionally proves the guard
//! ordering: authorization runs before any provider access, so every
//! denial case answers without a configured provider.

mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use castify_api::shares::token::{hash_share_token, issue_unlock_value};
use castify_api::shares::{NewShare, ShareRepository};
use castify_api::state::AppState;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tower::ServiceExt;

/// Boot a fresh app with first-run setup done (an owner row must exist for
/// shares to reference). Recipient requests never use the session cookie.
async fn boot() -> (axum::Router, AppState, tempfile::TempDir) {
    boot_with(|_| {}).await
}

/// [`boot`] with config tweaks applied before the `AppState` is built —
/// the transcode/cached-stream mirror tests need those features enabled.
async fn boot_with(
    configure: impl FnOnce(&mut castify_core::Config),
) -> (axum::Router, AppState, tempfile::TempDir) {
    let (state, guard, _path) = common::fresh_state_with(configure).await;
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
    let response = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
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

// ------------------------------------------------- 404 (purged — task 004)

#[tokio::test]
async fn purged_share_is_404_unknown_for_recipient() {
    // Spec criterion 8 (docs/specs/share-management): after a purge the
    // token-hash row is gone, so the recipient resolve route answers 404
    // "unknown" — a deleted share is indistinguishable from one that never
    // existed. Deliberately LESS information than revoke's 410; the landing
    // page already renders both as terminal.
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, None, None, &videos).await;
    ShareRepository::new(state.pool().clone())
        .purge_owned(&owner_uuid(state.pool()).await.to_string(), &share.id)
        .await
        .unwrap();

    let (status, body) = get(app.clone(), &format!("/api/share/{}", share.token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "body = {body}");

    let (status, body) = get(app, &format!("/api/share/{}/items", share.token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "body = {body}");
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
    let mut keys: Vec<&str> = body
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
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

    let (status, _) = get(
        app,
        &format!("/api/share/{}/items", share.token),
        Some(&cookie),
    )
    .await;
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

    let items = body["items"].as_array().expect("items is an array");
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
    assert!(items[0]["sources"]
        .as_array()
        .is_some_and(|s| !s.is_empty()));
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

    let (status, body) = get(
        app,
        &format!("/api/share/{}/items", share.token),
        Some(&jar),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
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
async fn unlock_on_expired_share_is_410_share_unavailable() {
    let (app, state, _guard) = boot().await;
    // Seeded through the repo with a past expiry (the API would reject
    // one at creation). The status machine 410s before the placeholder
    // PHC string is ever verified.
    let share = seed_share(&state, Some("pw"), Some("2000-01-01T00:00:00Z"), &[]).await;

    let (status, cookie, body) = post_unlock(app, &share.token, "pw").await;
    assert_eq!(status, StatusCode::GONE, "body = {body}");
    assert_eq!(body["code"], "share_unavailable");
    assert!(cookie.is_none(), "a dead share must never mint a cookie");
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
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the engaging failure is still 401"
    );
    let (status, _, _) = post_unlock(app, &share.token, "correct horse").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

// ------------------------------------------------- media mirrors (task 005)

/// Raw GET returning status, the response headers, and the raw body —
/// mirror routes serve bytes (stream/thumbnail), so JSON parsing is out.
async fn get_raw(
    app: axum::Router,
    uri: &str,
    cookie: Option<&str>,
    range: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut builder = Request::builder().method("GET").uri(uri);
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    if let Some(range) = range {
        builder = builder.header("range", range);
    }
    let response = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, bytes.to_vec())
}

fn header_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

fn mirror_uri(token: &str, video_id: &str, suffix: &str) -> String {
    format!("/api/share/{token}/videos/{video_id}/{suffix}")
}

/// One boot, five denial shapes: an open share (its member video is the
/// positive control), a revoked share, an expired share, a locked share,
/// and an unknown token. Returns everything the per-route matrix tests
/// need. The guard must stay alive for the caller's lifetime — dropping it
/// unlinks the db file and later pool connections would 500 on an empty
/// database.
struct DenialFixture {
    app: axum::Router,
    open: String,
    revoked: String,
    expired: String,
    locked: String,
    member: String,
    outsider: String,
    _guard: tempfile::TempDir,
}

async fn denial_fixture() -> DenialFixture {
    let (app, state, guard) = boot().await;
    let videos = seed_videos(state.pool(), &["member.mp4", "outsider.mp4"]).await;
    let member = std::slice::from_ref(&videos[0]).to_vec();
    let open = seed_share(&state, None, None, &member).await.token;
    let revoked_share = seed_share(&state, None, None, &member).await;
    ShareRepository::new(state.pool().clone())
        .revoke(&revoked_share.id)
        .await
        .unwrap();
    // Seeded straight through the repo — the API rejects past expiries, so
    // an expired row can only exist if it expired after creation.
    let expired = seed_share(&state, None, Some("2000-01-01T00:00:00Z"), &member)
        .await
        .token;
    let locked = seed_share(&state, Some("pw"), None, &member).await.token;
    DenialFixture {
        app,
        open,
        revoked: revoked_share.token,
        expired,
        locked,
        member: videos[0].clone(),
        outsider: videos[1].clone(),
        _guard: guard,
    }
}

/// The shared per-route matrix: non-member → 404, revoked → 410, expired
/// → 410, locked (no cookie) → 401, unknown token → 404. Authorization
/// runs before any provider access, so these hold without a configured
/// provider.
async fn assert_mirror_denial_matrix(suffix: &str) {
    let f = denial_fixture().await;

    let (status, _, _) = get_raw(
        f.app.clone(),
        &mirror_uri(&f.open, &f.outsider, suffix),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "non-member must 404");

    let (status, _, _) = get_raw(
        f.app.clone(),
        &mirror_uri(&f.revoked, &f.member, suffix),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::GONE, "revoked must 410");

    let (status, _, _) = get_raw(
        f.app.clone(),
        &mirror_uri(&f.expired, &f.member, suffix),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::GONE, "expired must 410");

    let (status, _, _) = get_raw(
        f.app.clone(),
        &mirror_uri(&f.locked, &f.member, suffix),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "locked must 401");

    let (status, _, _) = get_raw(
        f.app.clone(),
        &mirror_uri("does-not-exist", &f.member, suffix),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "unknown token must 404");
}

#[tokio::test]
async fn mirror_stream_denial_matrix() {
    assert_mirror_denial_matrix("stream").await;
}

#[tokio::test]
async fn mirror_stream_url_denial_matrix() {
    assert_mirror_denial_matrix("stream-url").await;
}

#[tokio::test]
async fn mirror_thumbnail_denial_matrix() {
    assert_mirror_denial_matrix("thumbnail").await;
}

// ------------------------------------------- subtitle mirrors (task 006)

/// Seed a sidecar subtitle row on `video_id` (same shape as the owner
/// tests' `seed_subtitle`) — the list route reads it without touching a
/// provider, so this needs no e2e feature.
async fn seed_sidecar_subtitle(
    state: &AppState,
    video_id: &str,
    provider_file_id: &str,
    language: Option<&str>,
    filename: &str,
    format: &str,
) -> String {
    let id = format!("sub-{video_id}-{provider_file_id}");
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, language, filename, format, format_family) \
         VALUES (?, ?, 'c1', ?, ?, ?, ?, 'text')",
    )
    .bind(&id)
    .bind(video_id)
    .bind(provider_file_id)
    .bind(language)
    .bind(filename)
    .bind(format)
    .execute(state.pool())
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn mirror_subtitle_list_denial_matrix() {
    assert_mirror_denial_matrix("subtitles").await;
}

#[tokio::test]
async fn mirror_subtitle_track_denial_matrix() {
    // Denials run at the guard, before any track lookup, so the track id
    // in the path is arbitrary.
    assert_mirror_denial_matrix("subtitles/any-track").await;
}

#[tokio::test]
async fn mirror_subtitle_list_returns_sidecar_tracks_in_existing_dto_shape() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, None, None, &videos).await;
    seed_sidecar_subtitle(&state, &videos[0], "file-1", Some("en"), "a.en.srt", "srt").await;

    let (status, body) = get(
        app,
        &mirror_uri(&share.token, &videos[0], "subtitles"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    let tracks = body.as_array().expect("tracks is an array");
    assert_eq!(tracks.len(), 1);
    // Existing SubtitleTrack DTO — the SPA renders recipient tracks with
    // the same components as owner tracks.
    assert_eq!(tracks[0]["id"], format!("sub-{}-file-1", videos[0]));
    assert_eq!(tracks[0]["language"], "en");
    assert_eq!(tracks[0]["filename"], "a.en.srt");
    assert_eq!(tracks[0]["format"], "srt");
    assert_eq!(tracks[0]["format_family"], "text");
    assert!(tracks[0]["embedded_track_id"].is_null());
}

/// Seed an extracted-embedded track whose bytes live on local disk —
/// serving it never touches a provider, so the happy path runs without
/// the e2e feature. Returns the track id.
async fn seed_extracted_subtitle_on_disk(
    state: &AppState,
    video_id: &str,
    track_id: &str,
    format: &str,
    body: &[u8],
) -> String {
    let sub_dir = state
        .config()
        .data_dir
        .join("extracted-subs")
        .join(video_id);
    std::fs::create_dir_all(&sub_dir).unwrap();
    let path = sub_dir.join(format!("{track_id}.{format}"));
    std::fs::write(&path, body).unwrap();
    sqlx::query(
        "INSERT INTO video_subtitles \
         (id, video_id, connection_id, provider_file_id, embedded_track_id, \
          language, filename, format, format_family, extracted_path) \
         VALUES (?, ?, NULL, NULL, 1, NULL, ?, ?, 'text', ?)",
    )
    .bind(track_id)
    .bind(video_id)
    .bind(format!("{track_id}.{format}"))
    .bind(format)
    .bind(path.to_string_lossy().to_string())
    .execute(state.pool())
    .await
    .unwrap();
    track_id.to_string()
}

#[tokio::test]
async fn mirror_subtitle_track_serves_text_for_member() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, None, None, &videos).await;
    // SRT from disk exercises the same format rule as the owner route:
    // converted to WebVTT, served as text/vtt.
    let srt_body = b"1\n00:00:01,000 --> 00:00:03,000\nHello\n";
    let track_id =
        seed_extracted_subtitle_on_disk(&state, &videos[0], "track-srt", "srt", srt_body).await;

    let (status, headers, bytes) = get_raw(
        app,
        &mirror_uri(&share.token, &videos[0], &format!("subtitles/{track_id}")),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header_value(&headers, "content-type").as_deref(),
        Some("text/vtt")
    );
    let vtt = String::from_utf8_lossy(&bytes);
    assert!(vtt.starts_with("WEBVTT"), "SRT → VTT conversion: {vtt}");
    assert!(
        !vtt.contains("--> 00:00:03,000"),
        "comma timestamps replaced with dots"
    );
}

#[tokio::test]
async fn mirror_subtitle_track_rejects_track_bound_to_a_different_video() {
    // Both videos are members, so the guard passes for either — only the
    // track↔video binding check can reject the cross-video combination.
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;
    let share = seed_share(&state, None, None, &videos).await;
    let srt_body = b"1\n00:00:01,000 --> 00:00:03,000\nHello\n";
    let track_id =
        seed_extracted_subtitle_on_disk(&state, &videos[1], "track-b", "srt", srt_body).await;

    // Track belongs to videos[1]; the path names videos[0] → 404.
    let (status, _, _) = get_raw(
        app.clone(),
        &mirror_uri(&share.token, &videos[0], &format!("subtitles/{track_id}")),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "cross-video track must 404");

    // Positive control: the same track via its own video serves fine.
    let (status, _, _) = get_raw(
        app,
        &mirror_uri(&share.token, &videos[1], &format!("subtitles/{track_id}")),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn mirror_thumbnail_serves_disk_cached_bytes_for_member() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let share = seed_share(&state, None, None, &videos).await;

    // Seed the thumbnail cache exactly like the owner test does: mark the
    // video cached and drop a PNG on disk. The cached fast path never
    // touches a provider, so this happy path runs without the e2e feature.
    let test_png: &[u8] = b"\x89PNG\r\n\x1a\n test thumbnail";
    let cache_dir = state.config().data_dir.join("thumbnails");
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::write(cache_dir.join(&videos[0]), test_png).unwrap();
    state
        .catalog_repository()
        .update_thumbnail_status(&videos[0], "cached")
        .await
        .unwrap();

    let (status, headers, bytes) = get_raw(
        app,
        &mirror_uri(&share.token, &videos[0], "thumbnail"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header_value(&headers, "content-type").as_deref(),
        Some("image/png")
    );
    assert_eq!(bytes, test_png);
}

#[tokio::test]
async fn owner_video_routes_still_401_without_session() {
    // Mirrors add access; they must not widen it. A recipient holding only
    // a share URL (no session) still can't touch the owner surface.
    let (app, _state, _guard) = boot().await;
    for suffix in [
        "stream",
        "stream-url",
        "thumbnail",
        "subtitles",
        "subtitles/some-track",
    ] {
        let (status, _, _) = get_raw(
            app.clone(),
            &format!("/api/videos/some-id/{suffix}"),
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "owner /{suffix}");
    }
}

// --------------------------------------- media mirrors w/ provider bytes (e2e)
//
// Byte-serving happy paths need a provider factory; under the `e2e` cargo
// feature `AppState::factory_for` returns the mock provider (same gating
// as the owner stream tests in tests/videos.rs).

/// Seed a connection with a REAL (encrypted) token bundle + `names.len()`
/// videos — `fetch_token_bundle` must succeed for stream/stream-url.
#[cfg(feature = "e2e")]
async fn seed_streamable_videos(
    state: &AppState,
    provider: castify_catalog::Provider,
    names: &[&str],
) -> Vec<String> {
    use castify_catalog::{Credential, NewConnection, TokenBundle};
    let conn = state
        .catalog_repository()
        .create_connection(&NewConnection {
            provider,
            credential: Credential::OAuth(TokenBundle {
                access_token: "ya29.test".into(),
                refresh_token: Some("refresh".into()),
                expires_at: None,
                token_type: "Bearer".into(),
                scope: None,
            }),
            provider_account_id: Some(uuid::Uuid::new_v4().to_string()),
            provider_account_email: None,
        })
        .await
        .unwrap();
    let mut ids = Vec::with_capacity(names.len());
    for name in names {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos (id, connection_id, provider, provider_file_id, name, \
             size_bytes, duration_ms, scanned_at, created_at) \
             VALUES (?, ?, ?, ?, ?, 1, 60000, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(&id)
        .bind(&conn.id)
        .bind(provider.to_string())
        .bind(name)
        .bind(name)
        .execute(state.pool())
        .await
        .unwrap();
        ids.push(id);
    }
    ids
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn mirror_stream_serves_member_bytes_with_range_support() {
    use castify_catalog::Provider;
    let (app, state, _guard) = boot().await;
    let videos = seed_streamable_videos(&state, Provider::GoogleDrive, &["gd-vacation"]).await;
    let share = seed_share(&state, None, None, &videos).await;

    // Full content: 200, video/mp4, non-empty body.
    let (status, headers, bytes) = get_raw(
        app.clone(),
        &mirror_uri(&share.token, &videos[0], "stream"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header_value(&headers, "content-type").as_deref(),
        Some("video/mp4")
    );
    assert!(!bytes.is_empty(), "member bytes served");

    // Range request: 206 with a Content-Range prefix — body-identical
    // behavior to the owner route's passthrough.
    let (status, headers, bytes) = get_raw(
        app,
        &mirror_uri(&share.token, &videos[0], "stream"),
        None,
        Some("bytes=0-3"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    let content_range =
        header_value(&headers, "content-range").expect("content-range header present on 206");
    assert!(
        content_range.starts_with("bytes 0-3/"),
        "content-range: {content_range}"
    );
    assert_eq!(bytes.len(), 4);
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn mirror_stream_url_strategies_are_share_scoped() {
    use castify_catalog::Provider;
    let (app, state, _guard) = boot().await;

    // Drive mock → Proxied: the proxy URL must be rooted at the share
    // scope, NOT /api/videos/... (which the recipient cannot reach).
    let drive = seed_streamable_videos(&state, Provider::GoogleDrive, &["gd-vacation"]).await;
    let drive_share = seed_share(&state, None, None, &drive).await;
    let (status, body) = get(
        app.clone(),
        &mirror_uri(&drive_share.token, &drive[0], "stream-url"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["strategy"], "proxy");
    assert_eq!(
        body["url"],
        format!(
            "/api/share/{}/videos/{}/stream",
            drive_share.token, drive[0]
        ),
        "proxy URL must be share-scoped"
    );

    // OneDrive mock → Direct: browser-direct CDN URLs pass through unchanged.
    let od = seed_streamable_videos(&state, Provider::OneDrive, &["od-clip"]).await;
    let od_share = seed_share(&state, None, None, &od).await;
    let (status, body) = get(
        app,
        &mirror_uri(&od_share.token, &od[0], "stream-url"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["strategy"], "direct");
    let url = body["url"].as_str().expect("url present");
    assert!(
        url.starts_with("/api/__e2e/mock-cdn/"),
        "direct CDN URL passes through unchanged: {url}"
    );
}

/// Sidecar bytes live at the provider — the share mirror serves them
/// through the same fetch pipeline (single token refresh) as the owner
/// route, so this happy path needs the e2e mock provider.
#[cfg(feature = "e2e")]
#[tokio::test]
async fn mirror_subtitle_track_serves_sidecar_bytes_from_provider() {
    use castify_catalog::Provider;
    let (app, state, _guard) = boot().await;
    let videos = seed_streamable_videos(&state, Provider::GoogleDrive, &["gd-vacation"]).await;
    let share = seed_share(&state, None, None, &videos).await;

    // Sidecar row referencing the mock's subtitle file id — the mock's
    // fetch_subtitle_content returns a VTT-typed payload for any id.
    let connection_id: String = sqlx::query_scalar("SELECT connection_id FROM videos WHERE id = ?")
        .bind(&videos[0])
        .fetch_one(state.pool())
        .await
        .unwrap();
    let track_id = format!("sub-{}-gd-vacation-srt", videos[0]);
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, language, filename, format, format_family) \
         VALUES (?, ?, ?, 'gd-vacation-srt', 'en', 'vacation.en.srt', 'srt', 'text')",
    )
    .bind(&track_id)
    .bind(&videos[0])
    .bind(&connection_id)
    .execute(state.pool())
    .await
    .unwrap();

    let (status, headers, bytes) = get_raw(
        app,
        &mirror_uri(&share.token, &videos[0], &format!("subtitles/{track_id}")),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header_value(&headers, "content-type").as_deref(),
        Some("text/vtt")
    );
    let body = String::from_utf8_lossy(&bytes);
    assert!(
        body.starts_with("WEBVTT"),
        "sidecar SRT served as VTT: {body}"
    );
}

#[cfg(feature = "e2e")]
#[tokio::test]
async fn mirror_stream_url_transcode_override_is_share_scoped() {
    use castify_catalog::Provider;
    // Codec-override branch needs transcode enabled in config; the provider
    // call still runs first (Drive mock → Proxied), so this needs e2e too.
    let (state, guard, _path) = common::fresh_state_with(|cfg| cfg.transcode.enabled = true).await;
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
    let _guard = guard;

    let videos = seed_streamable_videos(&state, Provider::GoogleDrive, &["gd-vacation"]).await;
    let share = seed_share(&state, None, None, &videos).await;

    // Browser-incompatible codec + transcode enabled → override to the
    // transcode master playlist, share-scoped. (mpeg2video/aac is an
    // unconditional No in the codec map — hevc would only be
    // DependsOnBrowser.)
    sqlx::query("UPDATE videos SET video_codec = 'mpeg2video', audio_codec = 'aac' WHERE id = ?")
        .bind(&videos[0])
        .execute(state.pool())
        .await
        .unwrap();

    let (status, body) = get(
        app,
        &mirror_uri(&share.token, &videos[0], "stream-url"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["strategy"], "transcode");
    assert_eq!(
        body["url"],
        format!(
            "/api/share/{}/videos/{}/transcode/master.m3u8",
            share.token, videos[0]
        ),
        "transcode master URL must be share-scoped"
    );
}

// ------------------------- transcode + cached-stream mirrors (task 007)

#[tokio::test]
async fn mirror_transcode_master_denial_matrix() {
    assert_mirror_denial_matrix("transcode/master.m3u8").await;
}

#[tokio::test]
async fn mirror_transcode_playlist_denial_matrix() {
    assert_mirror_denial_matrix("transcode/720p/playlist.m3u8").await;
}

#[tokio::test]
async fn mirror_transcode_segment_denial_matrix() {
    assert_mirror_denial_matrix("transcode/720p/segment_00000.ts").await;
}

#[tokio::test]
async fn mirror_cached_stream_denial_matrix() {
    assert_mirror_denial_matrix("cached-stream").await;
}

/// Seed a completed transcode variant the way the owner transcode tests
/// do: a fake segment + playlist on disk plus a `completed` manifest row.
/// The on-disk segments make `ensure_transcode_started` short-circuit (it
/// never calls the provider or spawns ffmpeg), so the whole share chain
/// runs without either.
async fn seed_completed_variant(state: &AppState, video_id: &str, variant: &str) {
    use castify_catalog::NewTranscodeEntry;

    let profile = castify_api::transcode::DEFAULT_PROFILE;
    let dir = state
        .config()
        .transcode
        .dir
        .join(video_id)
        .join(variant)
        .join(profile);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("segment_00000.ts"), b"fake-segment-bytes").unwrap();
    std::fs::write(
        dir.join("playlist.m3u8"),
        "#EXTM3U\n#EXT-X-VERSION:6\n#EXTINF:10.0,\nsegment_00000.ts\n#EXT-X-ENDLIST\n",
    )
    .unwrap();
    state
        .catalog_repository()
        .insert_pending_transcode(&NewTranscodeEntry {
            video_id,
            variant,
            profile,
            output_dir: &dir.to_string_lossy(),
            segment_duration_secs: 10,
            bitrate: Some(3_000_000),
            width: Some(1280),
            height: Some(720),
        })
        .await
        .unwrap();
    state
        .catalog_repository()
        .mark_transcode_completed(video_id, variant, profile, 1)
        .await
        .unwrap();
}

/// Boot with transcode enabled, one member video (1080p source so the
/// pre-compute pick is 720p), an open share over it, and a completed 720p
/// variant. Returns everything the chain tests need.
struct TranscodeFixture {
    app: axum::Router,
    state: AppState,
    token: String,
    video: String,
    #[allow(dead_code)]
    guard: tempfile::TempDir,
}

async fn transcode_fixture() -> TranscodeFixture {
    // `transcode.dir` must be pinned inside the per-test data_dir — the
    // config default is a RELATIVE path, which would litter the checkout
    // with transcode-cache artifacts.
    let (app, state, guard) = boot_with(|cfg| {
        cfg.transcode.enabled = true;
        cfg.transcode.dir = cfg.data_dir.join("transcode-cache");
    })
    .await;
    let videos = seed_videos(state.pool(), &["vacation.mkv"]).await;
    sqlx::query("UPDATE videos SET height = 1080 WHERE id = ?")
        .bind(&videos[0])
        .execute(state.pool())
        .await
        .unwrap();
    let share = seed_share(&state, None, None, &videos).await;
    seed_completed_variant(&state, &videos[0], "720p").await;
    TranscodeFixture {
        app,
        state,
        token: share.token,
        video: videos[0].clone(),
        guard,
    }
}

#[tokio::test]
async fn mirror_transcode_chain_follows_master_playlist_segment_via_share_urls() {
    let f = transcode_fixture().await;
    let base = format!("/api/share/{}/videos/{}/transcode", f.token, f.video);

    // 1. Master playlist: 200, HLS content type, exactly one variant with
    //    a RELATIVE URI — it must resolve against the share scope, never
    //    embed an owner path the recipient can't reach.
    let (status, headers, bytes) =
        get_raw(f.app.clone(), &format!("{base}/master.m3u8"), None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header_value(&headers, "content-type").as_deref(),
        Some("application/vnd.apple.mpegurl")
    );
    let master = String::from_utf8(bytes.to_vec()).unwrap();
    assert_eq!(
        master.matches("EXT-X-STREAM-INF").count(),
        1,
        "master must list the variant: {master}"
    );
    let variant_uri = master
        .lines()
        .find(|l| l.ends_with("/playlist.m3u8"))
        .expect("variant URI line");
    assert!(
        !variant_uri.starts_with('/') && !variant_uri.contains("/api/"),
        "variant URI must stay relative (resolves under the share path): {variant_uri}"
    );

    // 2. Variant playlist via the share-scoped URL the master implies.
    let (status, _, bytes) =
        get_raw(f.app.clone(), &format!("{base}/{variant_uri}"), None, None).await;
    assert_eq!(status, StatusCode::OK);
    let playlist = String::from_utf8(bytes.to_vec()).unwrap();
    let segment_uri = playlist
        .lines()
        .find(|l| l.ends_with(".ts"))
        .expect("segment URI line");
    assert!(!segment_uri.contains('/'), "segment URI is a bare filename");

    // 3. Segment bytes via the share-scoped URL the playlist implies.
    let (status, headers, bytes) = get_raw(
        f.app.clone(),
        &format!("{base}/720p/{segment_uri}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"fake-segment-bytes".to_vec());
    assert_eq!(
        header_value(&headers, "content-type").as_deref(),
        Some("video/mp2t")
    );
}

#[tokio::test]
async fn share_master_reuses_owner_transcode_cache_no_duplicate_rows() {
    // Resolved fairness model (spec decision #3): share sessions share the
    // global transcode pipeline — one manifest, one output dir, one worker
    // registry — so the existing concurrent-transcode cap governs owner and
    // recipient traffic together (no separate share limit). The observable
    // proxy without ffmpeg: a share-driven master request reuses the
    // owner-seeded variant and leaves the manifest at exactly one row — no
    // share-scoped duplicate transcode was started.
    let f = transcode_fixture().await;
    let uri = format!(
        "/api/share/{}/videos/{}/transcode/master.m3u8",
        f.token, f.video
    );

    for i in 0..2 {
        let (status, _, _) = get_raw(f.app.clone(), &uri, None, None).await;
        assert_eq!(status, StatusCode::OK, "share master attempt {i}");
    }

    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM transcode_cache_entries WHERE video_id = ?")
            .bind(&f.video)
            .fetch_one(f.state.pool())
            .await
            .unwrap();
    assert_eq!(rows, 1, "share traffic must reuse, not duplicate, the row");
}

#[tokio::test]
async fn share_token_cannot_cancel_transcodes() {
    // `cancel_transcode` (DELETE) stays owner-only: no DELETE mirror
    // exists under /api/share/, and the auth middleware pre-auths only
    // GETs (plus the unlock POST) there — so a recipient's DELETE is
    // rejected before any handler runs.
    let f = transcode_fixture().await;
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!(
                    "/api/share/{}/videos/{}/transcode",
                    f.token, f.video
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "a recipient holds no session; the DELETE must not be pre-auth"
    );

    // The denial left the variant row completed, not failed — nothing was
    // cancelled. (The owner route remains the only cancel path; its
    // contract is covered by the owner transcode tests.)
    let entry = f
        .state
        .catalog_repository()
        .fetch_transcode_entry(&f.video, "720p", castify_api::transcode::DEFAULT_PROFILE)
        .await
        .unwrap()
        .expect("variant row present");
    assert_eq!(entry.status, "completed");
}

#[tokio::test]
async fn mirror_cached_stream_serves_hot_cache_hit_for_member() {
    let (app, state, _guard) = boot_with(|cfg| cfg.video_cache.enabled = true).await;
    let videos = seed_videos(state.pool(), &["hot.mp4"]).await;
    let share = seed_share(&state, None, None, &videos).await;

    // Seed the hot cache the way a finished tee leaves it: bytes on disk
    // plus a manifest row whose provider_file_id matches the video.
    let body_bytes = b"cached-video-bytes";
    state
        .video_cache()
        .expect("cache enabled")
        .put_bytes(&videos[0], body_bytes)
        .await
        .unwrap();
    state
        .catalog_repository()
        .upsert_video_cache_entry(&videos[0], "c1", "hot.mp4", body_bytes.len() as u64)
        .await
        .unwrap();

    // Full content: 200, video/mp4 (NULL mime falls back), exact bytes.
    let (status, headers, bytes) = get_raw(
        app.clone(),
        &mirror_uri(&share.token, &videos[0], "cached-stream"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, body_bytes.to_vec());
    assert_eq!(
        header_value(&headers, "content-type").as_deref(),
        Some("video/mp4")
    );
    assert_eq!(
        header_value(&headers, "accept-ranges").as_deref(),
        Some("bytes")
    );

    // Range: 206 + Content-Range — same shape as the owner cached-stream.
    let (status, headers, bytes) = get_raw(
        app,
        &mirror_uri(&share.token, &videos[0], "cached-stream"),
        None,
        Some("bytes=0-4"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    let content_range = header_value(&headers, "content-range").expect("content-range on 206");
    assert!(
        content_range.starts_with("bytes 0-4/"),
        "content-range: {content_range}"
    );
    assert_eq!(bytes.len(), 5);
}

// --------------------------- membership flip (mutable share list, task 004)
//
// The mutable-list contract's denial proof: `PUT /api/shares/{id}/items`
// must flip a recipient's access to a removed video from allow to deny on
// the very next request, with zero backend enforcement changes. Every
// mirror authorizes per-request via `authorize_share_item` → `is_member`,
// so if any route ever caches membership this test fails — that is its
// purpose.

/// Log the owner in through the real route and return the session cookie.
/// This file is otherwise session-free (pre-auth recipient surface); the
/// flip test needs the owner surface to drive the replace route.
async fn owner_session(app: &axum::Router) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    json!({"password": "correct horse battery staple"}).to_string(),
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
        .expect("login sets a session cookie")
}

/// Fetch a CSRF token with the owner session (mirrors the SPA's boot flow).
async fn csrf_token(app: &axum::Router, session: &str) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/csrf")
                .header("cookie", session)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice::<Value>(&bytes).unwrap()["token"]
        .as_str()
        .expect("csrf token")
        .to_string()
}

/// CSRF-correct `PUT`/`POST /api/shares/{id}/items` — same double-submit
/// shape as the SPA (PUT replaces, POST appends). Returns only the status
/// (204 on success).
async fn owner_mutate_items(
    app: &axum::Router,
    method: &str,
    session: &str,
    share_id: &str,
    video_ids: &[String],
) -> StatusCode {
    let csrf = csrf_token(app, session).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(format!("/api/shares/{share_id}/items"))
                .header("cookie", format!("{session}; castify_csrf={csrf}"))
                .header("x-csrf-token", &csrf)
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    json!({"video_ids": video_ids}).to_string(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    response.status()
}

/// CSRF-correct `PUT /api/shares/{id}/items` (replace).
async fn owner_replace_items(
    app: &axum::Router,
    session: &str,
    share_id: &str,
    video_ids: &[String],
) -> StatusCode {
    owner_mutate_items(app, "PUT", session, share_id, video_ids).await
}

#[tokio::test]
async fn removing_an_item_flips_recipient_access_from_allow_to_deny() {
    // Hot cache enabled so the share-scoped stream-url route can answer a
    // member 200 through its cached fast path — no provider involved.
    let (app, state, _guard) = boot_with(|cfg| cfg.video_cache.enabled = true).await;
    let videos = seed_videos(state.pool(), &["keep.mp4", "remove.mp4"]).await;
    let (kept, removed) = (videos[0].clone(), videos[1].clone());
    let cached_bytes: &[u8] = b"cached-video-bytes";
    for (id, name) in [(&kept, "keep.mp4"), (&removed, "remove.mp4")] {
        state
            .video_cache()
            .expect("cache enabled")
            .put_bytes(id, cached_bytes)
            .await
            .unwrap();
        state
            .catalog_repository()
            .upsert_video_cache_entry(id, "c1", name, cached_bytes.len() as u64)
            .await
            .unwrap();
    }
    let share = seed_share(&state, None, None, &[kept.clone(), removed.clone()]).await;
    let session = owner_session(&app).await;

    // Before: both are members and both serve. The removed-to-be video
    // answers through the items list AND the share-scoped stream-url path.
    let (status, body) = get(app.clone(), &format!("/api/share/{}", share.token), None).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["item_count"], 2);

    let (status, body) = get(
        app.clone(),
        &format!("/api/share/{}/items", share.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    let ids: Vec<&str> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![kept.as_str(), removed.as_str()]);

    let removed_stream_url = mirror_uri(&share.token, &removed, "stream-url");
    let (status, body) = get(app.clone(), &removed_stream_url, None).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "member stream-url pre-replace: {body}"
    );
    assert_eq!(body["strategy"], "cached");
    assert_eq!(
        body["url"],
        format!(
            "/api/share/{}/videos/{}/cached-stream",
            share.token, removed
        ),
        "served URL must be share-scoped"
    );

    // Owner replaces the list, keeping only `kept`.
    let status = owner_replace_items(&app, &session, &share.id, std::slice::from_ref(&kept)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // After: the share itself is fine — resolve and items still serve,
    // with counts converged to the new list.
    let (status, body) = get(app.clone(), &format!("/api/share/{}", share.token), None).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["item_count"], 1);

    let (status, body) = get(
        app.clone(),
        &format!("/api/share/{}/items", share.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    let ids: Vec<&str> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![kept.as_str()], "removed video drops out of items");

    // The IDENTICAL stream-url request that just served now 404s —
    // membership loss on the recipient surface is indistinguishable from
    // an unknown id, by design.
    let (status, _) = get(app.clone(), &removed_stream_url, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "post-replace stream-url");

    // And every other mirror denies at the guard too — no route may hold
    // a stale allow. Denials run before any provider access.
    for suffix in ["stream", "thumbnail", "subtitles"] {
        let (status, _, _) = get_raw(
            app.clone(),
            &mirror_uri(&share.token, &removed, suffix),
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "removed /{suffix}");
    }

    // Unaffected: the kept video still serves the identical request shape.
    let (status, body) = get(
        app.clone(),
        &mirror_uri(&share.token, &kept, "stream-url"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "kept video still serves: {body}");
    assert_eq!(body["strategy"], "cached");
}

// ------------------ append visibility (share management, task 002)

#[tokio::test]
async fn recipient_items_reflect_an_owner_append_immediately() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4", "c.mp4", "d.mp4"]).await;
    let share = seed_share(&state, None, None, &videos[..2]).await;
    let session = owner_session(&app).await;

    // Append [c, a, d]: `a` is already a member (skipped, keeps its
    // position), c and d join the tail in request order.
    let append = vec![videos[2].clone(), videos[0].clone(), videos[3].clone()];
    let status = owner_mutate_items(&app, "POST", &session, &share.id, &append).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // The recipient's very next items read reflects the appended order —
    // no cache, no propagation delay, by design.
    let (status, body) = get(
        app.clone(),
        &format!("/api/share/{}/items", share.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    let ids: Vec<&str> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        videos.iter().map(String::as_str).collect::<Vec<_>>(),
        "appended order is visible to the recipient immediately"
    );

    // Resolve agrees on the grown count.
    let (status, body) = get(app, &format!("/api/share/{}", share.token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["item_count"], 4);
}

// ---------------- folder tree payload (share-folders task 004)

#[tokio::test]
async fn recipient_items_carry_the_folder_tree() {
    let (app, state, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4", "c.mp4", "d.mp4"]).await;
    let share = seed_share(&state, None, None, &videos).await;

    // Owner-side organization straight through the repository: Trip at
    // root, Night nested under it; b,c in Trip; d in Night; a at root.
    let owner = owner_uuid(state.pool()).await;
    let repo = ShareRepository::new(state.pool().clone());
    let trip = repo
        .create_folder(&owner.to_string(), &share.id, None, "Trip")
        .await
        .unwrap()
        .unwrap();
    let night = repo
        .create_folder(&owner.to_string(), &share.id, Some(&trip.id), "Night")
        .await
        .unwrap()
        .unwrap();
    for (vid, folder) in [
        (&videos[1], Some(&trip.id)),
        (&videos[2], Some(&trip.id)),
        (&videos[3], Some(&night.id)),
    ] {
        repo.move_item(
            &owner.to_string(),
            &share.id,
            vid,
            folder.map(|s| s.as_str()),
        )
        .await
        .unwrap()
        .unwrap();
    }

    let (status, body) = get(app, &format!("/api/share/{}/items", share.token), None).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");

    // Folders arrive as the flat list ordered (parent_id, position) —
    // roots first, then each nested sibling group.
    let folders = body["folders"].as_array().expect("folders is an array");
    assert_eq!(folders.len(), 2);
    assert_eq!(folders[0]["name"], "Trip");
    assert_eq!(folders[0]["parent_id"], Value::Null);
    assert_eq!(folders[0]["position"], 0);
    assert_eq!(folders[1]["name"], "Night");
    assert_eq!(folders[1]["parent_id"], trip.id);
    assert_eq!(folders[1]["position"], 0);

    // Items: root items first in position order, then each folder's in
    // position order — the documented full order; per-scope relative
    // order is what the client rebuilds the tree from.
    let items = body["items"].as_array().expect("items is an array");
    let ids: Vec<&str> = items.iter().map(|v| v["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        vec![
            videos[0].as_str(),
            videos[1].as_str(),
            videos[2].as_str(),
            videos[3].as_str()
        ]
    );
    let folder_ids: Vec<&str> = items
        .iter()
        .map(|v| v["folder_id"].as_str().unwrap_or("ROOT"))
        .collect();
    assert_eq!(
        folder_ids,
        vec![
            "ROOT",
            trip.id.as_str(),
            trip.id.as_str(),
            night.id.as_str()
        ],
        "folder placement travels per item; root is null"
    );
}

#[tokio::test]
async fn member_video_inside_a_folder_still_streams() {
    let (app, state, _guard) = boot_with(|cfg| cfg.video_cache.enabled = true).await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let cached_bytes: &[u8] = b"cached-video-bytes";
    state
        .video_cache()
        .expect("cache enabled")
        .put_bytes(&videos[0], cached_bytes)
        .await
        .unwrap();
    state
        .catalog_repository()
        .upsert_video_cache_entry(&videos[0], "c1", "a.mp4", cached_bytes.len() as u64)
        .await
        .unwrap();
    let share = seed_share(&state, None, None, &videos).await;

    let owner = owner_uuid(state.pool()).await;
    let repo = ShareRepository::new(state.pool().clone());
    let folder = repo
        .create_folder(&owner.to_string(), &share.id, None, "Buried")
        .await
        .unwrap()
        .unwrap();
    repo.move_item(&owner.to_string(), &share.id, &videos[0], Some(&folder.id))
        .await
        .unwrap()
        .unwrap();

    // Authorization is membership-scoped only — folder placement never
    // enters the gate. One positive is the proof the tree didn't leak
    // into the mirrors.
    let (status, body) = get(
        app,
        &mirror_uri(&share.token, &videos[0], "stream-url"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
}
