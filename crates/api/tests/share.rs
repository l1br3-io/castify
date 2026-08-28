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

/// One boot, four denial shapes: an open share (its member video is the
/// positive control), a revoked share, a locked share, and an unknown
/// token. Returns everything the per-route matrix tests need. The guard
/// must stay alive for the caller's lifetime — dropping it unlinks the
/// db file and later pool connections would 500 on an empty database.
struct DenialFixture {
    app: axum::Router,
    open: String,
    revoked: String,
    locked: String,
    member: String,
    outsider: String,
    _guard: tempfile::TempPath,
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
    let locked = seed_share(&state, Some("pw"), None, &member).await.token;
    DenialFixture {
        app,
        open,
        revoked: revoked_share.token,
        locked,
        member: videos[0].clone(),
        outsider: videos[1].clone(),
        _guard: guard,
    }
}

/// The shared per-route matrix: non-member → 404, revoked → 410, locked
/// (no cookie) → 401, unknown token → 404. Authorization runs before any
/// provider access, so these hold without a configured provider.
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
    for suffix in ["stream", "stream-url", "thumbnail"] {
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
    use castify_catalog::{NewConnection, TokenBundle};
    let conn = state
        .catalog_repository()
        .create_connection(&NewConnection {
            provider,
            token_bundle: TokenBundle {
                access_token: "ya29.test".into(),
                refresh_token: Some("refresh".into()),
                expires_at: None,
                token_type: "Bearer".into(),
                scope: None,
            },
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
