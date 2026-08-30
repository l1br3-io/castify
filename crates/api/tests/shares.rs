//! Owner-facing shares REST — integration tests (task 002).
//!
//! Drives the full middleware stack (`build_app`) exactly like the browser
//! would: session cookie for auth, double-submit CSRF for mutations. The
//! denial matrix (401 without session, 403 without CSRF) and the
//! token-once contract live here because they only exist at the HTTP
//! boundary.

mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use castify_api::shares::token::hash_share_token;
use castify_api::state::AppState;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tower::ServiceExt;

const OWNER_PASSWORD: &str = "correct horse battery staple";
const FUTURE_EXPIRY: &str = "2099-01-01T00:00:00Z";

/// Boot a fresh app, run first-run setup, and return `(app, state, session
/// cookie, db guard)`. `state` is needed to seed catalog rows through the
/// pool and to inspect persisted bytes directly.
async fn boot() -> (axum::Router, AppState, String, tempfile::TempPath) {
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
                    json!({"display_name":"Jane","password":OWNER_PASSWORD}).to_string(),
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
    (app, state, cookie, guard)
}

/// Minimal catalog seed (mirrors `shares::repository` tests): one active
/// connection + `names.len()` videos. Returns video ids in insertion order.
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
             size_bytes, scanned_at, created_at) \
             VALUES (?, 'c1', 'google_drive', ?, ?, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
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

/// Fetch a real CSRF token with the session (mirrors the SPA's boot flow).
async fn fetch_csrf(app: &axum::Router, session: &str) -> String {
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
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    body["token"].as_str().expect("csrf token").to_string()
}

/// One-shot request helper. `csrf` is a `(cookie, header)` pair so tests
/// can send matching tokens (double-submit, like the browser) or mismatch
/// them on purpose.
async fn request(
    app: axum::Router,
    method: &str,
    uri: &str,
    session: Option<&str>,
    csrf: Option<(&str, &str)>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    let mut cookie_parts: Vec<String> = Vec::new();
    if let Some(c) = session {
        cookie_parts.push(c.to_string());
    }
    if let Some((cookie_value, _)) = csrf {
        cookie_parts.push(format!("castify_csrf={cookie_value}"));
    }
    if !cookie_parts.is_empty() {
        builder = builder.header("cookie", cookie_parts.join("; "));
    }
    if let Some((_, header_value)) = csrf {
        builder = builder.header("x-csrf-token", header_value);
    }
    let body = match body {
        Some(v) => {
            builder = builder.header("content-type", "application/json");
            Body::from(Bytes::from(v.to_string()))
        }
        None => Body::empty(),
    };
    let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

/// Create a share through the API with CSRF done right. Returns the
/// response body of the 201.
async fn create_share(app: &axum::Router, session: &str, body: Value) -> (StatusCode, Value) {
    let csrf = fetch_csrf(app, session).await;
    request(
        app.clone(),
        "POST",
        "/api/shares",
        Some(session),
        Some((&csrf, &csrf)),
        Some(body),
    )
    .await
}

// ---------------------------------------------------------------- 401 / 403

#[tokio::test]
async fn create_without_session_is_unauthorized() {
    let (app, _state, _session, _guard) = boot().await;
    let (status, _) = request(
        app,
        "POST",
        "/api/shares",
        None,
        None,
        Some(json!({"video_ids": ["x"]})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn list_without_session_is_unauthorized() {
    let (app, _state, _session, _guard) = boot().await;
    let (status, _) = request(app, "GET", "/api/shares", None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revoke_without_session_is_unauthorized() {
    let (app, _state, _session, _guard) = boot().await;
    let (status, _) = request(app, "DELETE", "/api/shares/whatever", None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn create_without_csrf_header_is_forbidden() {
    let (app, _state, session, _guard) = boot().await;
    let (status, _) = request(
        app,
        "POST",
        "/api/shares",
        Some(&session),
        None,
        Some(json!({"video_ids": ["x"]})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn create_with_mismatched_csrf_is_forbidden() {
    let (app, _state, session, _guard) = boot().await;
    // Cookie says one token, header says another.
    let (status, _) = request(
        app,
        "POST",
        "/api/shares",
        Some(&session),
        Some(("cookie-value", "header-value")),
        Some(json!({"video_ids": ["x"]})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn revoke_without_csrf_is_forbidden() {
    let (app, _state, session, _guard) = boot().await;
    let (status, _) = request(
        app,
        "DELETE",
        "/api/shares/whatever",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

// ------------------------------------------------------------------ create

#[tokio::test]
async fn create_returns_201_with_token_and_share_url_exactly_once() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;

    let (status, body) = create_share(
        &app,
        &session,
        json!({
            "title": "Trip footage",
            "video_ids": videos,
            "password": "family-only-secret",
            "expires_at": FUTURE_EXPIRY,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body = {body}");

    let token = body["token"]
        .as_str()
        .expect("token in response")
        .to_string();
    assert!(!token.is_empty());
    assert_eq!(body["share_url"], format!("/share/{token}"));
    assert_eq!(body["title"], "Trip footage");
    let share_id = body["id"].as_str().expect("id in response").to_string();

    // Persisted correctly: hash (never raw) in the DB.
    let stored: Vec<u8> = sqlx::query_scalar("SELECT token_hash FROM shares WHERE id = ?")
        .bind(&share_id)
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(
        stored,
        hash_share_token(&token),
        "stored bytes are the SHA-256"
    );
    assert_ne!(stored, token.as_bytes().to_vec());

    // Password persisted as an argon2id PHC string, verifiable, never plaintext.
    let stored_pw: String = sqlx::query_scalar("SELECT password_hash FROM shares WHERE id = ?")
        .bind(&share_id)
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert!(stored_pw.starts_with("$argon2id$"), "got {stored_pw}");
    assert_ne!(stored_pw, "family-only-secret");
    assert!(castify_auth::password::verify_password("family-only-secret", &stored_pw).is_ok());

    // Items persisted in curation order.
    let item_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM share_items WHERE share_id = ?")
        .bind(&share_id)
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(item_count, 2);
}

#[tokio::test]
async fn create_minimal_share_needs_neither_password_nor_expiry_nor_title() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["solo.mp4"]).await;

    let (status, body) = create_share(&app, &session, json!({"video_ids": videos})).await;
    assert_eq!(status, StatusCode::CREATED, "body = {body}");
    assert!(body["token"].as_str().is_some());
    assert!(
        body["title"].as_str().is_some_and(|t| !t.is_empty()),
        "a default title fills the NOT NULL column: {body}"
    );
}

#[tokio::test]
async fn create_rejects_empty_item_list() {
    let (app, _state, session, _guard) = boot().await;
    let (status, body) = create_share(&app, &session, json!({"video_ids": []})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");
    assert!(body["message"].as_str().unwrap_or("").contains("item"));
}

#[tokio::test]
async fn create_rejects_unknown_video_id_and_persists_nothing() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["real.mp4"]).await;
    let bogus = vec![videos[0].clone(), "not-a-video".to_string()];

    let (status, _body) = create_share(&app, &session, json!({"video_ids": bogus})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let shares: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shares")
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(shares, 0, "failed create must not persist a share");
}

#[tokio::test]
async fn create_rejects_duplicate_video_ids() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let dupes = vec![videos[0].clone(), videos[0].clone()];

    let (status, _body) = create_share(&app, &session, json!({"video_ids": dupes})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn create_rejects_short_password_via_shared_policy() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;

    let (status, body) = create_share(
        &app,
        &session,
        json!({"video_ids": videos, "password": "short"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");
    assert!(
        body["message"].as_str().unwrap_or("").contains("8"),
        "error should carry the shared policy message: {body}"
    );

    let shares: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shares")
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(shares, 0);
}

#[tokio::test]
async fn create_rejects_past_expiry() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;

    let (status, _body) = create_share(
        &app,
        &session,
        json!({"video_ids": videos, "expires_at": "2000-01-01T00:00:00Z"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let shares: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shares")
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(shares, 0);
}

#[tokio::test]
async fn create_rejects_malformed_expiry() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;

    for bad in ["not-a-date", "2027-01-01T00:00:00" /* no timezone */] {
        let (status, _body) = create_share(
            &app,
            &session,
            json!({"video_ids": videos, "expires_at": bad}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "expires_at = {bad:?}");
    }

    let shares: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shares")
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(shares, 0);
}

#[tokio::test]
async fn create_rejects_overlong_title() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let (status, _body) = create_share(
        &app,
        &session,
        json!({"video_ids": videos, "title": "x".repeat(201)}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// -------------------------------------------------------------------- list

#[tokio::test]
async fn list_returns_shares_newest_first_with_counts_and_no_token_material() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;

    let (_, first) = create_share(
        &app,
        &session,
        json!({"title": "First", "video_ids": [&videos[0]]}),
    )
    .await;
    let (_, second) = create_share(
        &app,
        &session,
        json!({"title": "Second", "video_ids": videos}),
    )
    .await;

    let (status, body) = request(app, "GET", "/api/shares", Some(&session), None, None).await;
    assert_eq!(status, StatusCode::OK, "body = {body}");

    let shares = body.as_array().expect("list is an array");
    assert_eq!(shares.len(), 2);
    assert_eq!(shares[0]["title"], "Second", "newest first");
    assert_eq!(shares[1]["title"], "First");
    assert_eq!(shares[0]["item_count"], 2);
    assert_eq!(shares[1]["item_count"], 1);
    assert_eq!(shares[0]["status"], "active");

    // No token material: neither raw token nor hash may appear anywhere in
    // the serialized response — a share link must not be reconstructable.
    let raw = serde_json::to_string(&body).unwrap();
    for token in [
        first["token"].as_str().unwrap(),
        second["token"].as_str().unwrap(),
    ] {
        assert!(!raw.contains(token), "list leaked raw token");
    }
    for entry in shares {
        assert!(
            entry.get("token").is_none()
                && entry.get("token_hash").is_none()
                && entry.get("password_hash").is_none()
                && entry.get("password").is_none()
        );
    }

    // Field contract: exactly the management fields, nothing extra.
    let mut keys: Vec<&str> = shares[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "created_at",
            "expires_at",
            "id",
            "item_count",
            "revoked_at",
            "status",
            "title"
        ]
    );
}

#[tokio::test]
async fn list_derives_expired_and_revoked_status() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let repo = castify_api::shares::ShareRepository::new(state.pool().clone());

    // A share that expired long ago (seeded straight through the repo —
    // the API would rightly refuse to create it).
    let expired_id = repo
        .create_share(&castify_api::shares::NewShare {
            owner_id: &owner_uuid(state.pool()).await,
            token_hash: &hash_share_token("expired-test-token-1"),
            password_hash: None,
            title: "Expired",
            expires_at: Some("2000-01-01T00:00:00Z"),
            video_ids: &videos,
        })
        .await
        .unwrap()
        .id;

    // A live share that then gets revoked through the API.
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let live_id = created["id"].as_str().unwrap().to_string();
    let csrf = fetch_csrf(&app, &session).await;
    let (status, _) = request(
        app.clone(),
        "DELETE",
        &format!("/api/shares/{live_id}"),
        Some(&session),
        Some((&csrf, &csrf)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Revoked-and-expired: revocation is the terminal word.
    let both_id = repo
        .create_share(&castify_api::shares::NewShare {
            owner_id: &owner_uuid(state.pool()).await,
            token_hash: &hash_share_token("expired-test-token-2"),
            password_hash: None,
            title: "Both",
            expires_at: Some("2000-01-01T00:00:00Z"),
            video_ids: &videos,
        })
        .await
        .unwrap()
        .id;
    repo.revoke(&both_id).await.unwrap();

    let (status, body) = request(app, "GET", "/api/shares", Some(&session), None, None).await;
    assert_eq!(status, StatusCode::OK);
    let by_title = |t: &str| {
        body.as_array()
            .unwrap()
            .iter()
            .find(|s| s["title"] == t)
            .unwrap_or_else(|| panic!("missing {t} in {body}"))
            .clone()
    };
    assert_eq!(by_title("Expired")["status"], "expired");
    assert_eq!(by_title("Expired")["id"], expired_id.as_str());
    let revoked = by_title("Both");
    assert_eq!(revoked["status"], "revoked", "revocation beats expiry");
    assert!(revoked["revoked_at"].as_str().is_some());

    // The API-revoked share also reads revoked.
    let api_revoked = body
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == live_id.as_str())
        .expect("live share listed");
    assert_eq!(api_revoked["status"], "revoked");
}

/// The single owner's UUID (first-run setup created exactly one owner row).
async fn owner_uuid(pool: &SqlitePool) -> uuid::Uuid {
    let id: String = sqlx::query_scalar("SELECT id FROM owners LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap();
    uuid::Uuid::parse_str(&id).unwrap()
}

// ------------------------------------------------------------------ revoke

#[tokio::test]
async fn revoke_is_idempotent_and_returns_204() {
    let (app, state, session, _guard) = boot().await;

    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();
    let csrf = fetch_csrf(&app, &session).await;

    let (first, _) = request(
        app.clone(),
        "DELETE",
        &format!("/api/shares/{id}"),
        Some(&session),
        Some((&csrf, &csrf)),
        None,
    )
    .await;
    assert_eq!(first, StatusCode::NO_CONTENT);

    // Revoking a revoked share: still 204, no error.
    let (second, _) = request(
        app.clone(),
        "DELETE",
        &format!("/api/shares/{id}"),
        Some(&session),
        Some((&csrf, &csrf)),
        None,
    )
    .await;
    assert_eq!(second, StatusCode::NO_CONTENT);

    // Unknown share id: 204 as well — DELETE is idempotent by contract.
    let (unknown, _) = request(
        app,
        "DELETE",
        "/api/shares/00000000-0000-0000-0000-000000000000",
        Some(&session),
        Some((&csrf, &csrf)),
        None,
    )
    .await;
    assert_eq!(unknown, StatusCode::NO_CONTENT);

    let revoked_at: Option<String> =
        sqlx::query_scalar("SELECT revoked_at FROM shares WHERE id = ?")
            .bind(&id)
            .fetch_one(state.pool())
            .await
            .unwrap();
    assert!(revoked_at.is_some(), "revoked_at persisted");
}

// ----------------------------------------------------------- replace items

/// CSRF-correct `PUT /api/shares/{id}/items` with the given video ids.
async fn replace_items(
    app: &axum::Router,
    session: &str,
    share_id: &str,
    video_ids: Vec<String>,
) -> (StatusCode, Value) {
    let csrf = fetch_csrf(app, session).await;
    request(
        app.clone(),
        "PUT",
        &format!("/api/shares/{share_id}/items"),
        Some(session),
        Some((&csrf, &csrf)),
        Some(json!({"video_ids": video_ids})),
    )
    .await
}

/// A share's items in curation order, straight from the table.
async fn persisted_items(pool: &SqlitePool, share_id: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT video_id FROM share_items WHERE share_id = ? ORDER BY position")
        .bind(share_id)
        .fetch_all(pool)
        .await
        .unwrap()
}

/// Insert a second owner and a share owned by them, bypassing the API
/// (first-run setup guarantees exactly one owner, so this is the only way
/// to exercise a foreign share id). Returns the stranger's share id.
async fn seed_stranger_share(pool: &SqlitePool, videos: &[String]) -> String {
    let stranger = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO owners (id, created_at, display_name) VALUES (?, '2026-01-01T00:00:00Z', NULL)",
    )
    .bind(stranger.to_string())
    .execute(pool)
    .await
    .unwrap();
    castify_api::shares::ShareRepository::new(pool.clone())
        .create_share(&castify_api::shares::NewShare {
            owner_id: &stranger,
            token_hash: &hash_share_token("stranger-test-token"),
            password_hash: None,
            title: "Stranger",
            expires_at: None,
            video_ids: videos,
        })
        .await
        .unwrap()
        .id
}

#[tokio::test]
async fn replace_items_without_session_is_unauthorized() {
    let (app, _state, _session, _guard) = boot().await;
    let (status, _) = request(
        app,
        "PUT",
        "/api/shares/whatever/items",
        None,
        None,
        Some(json!({"video_ids": ["x"]})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn replace_items_without_csrf_is_forbidden() {
    let (app, _state, session, _guard) = boot().await;
    let (status, _) = request(
        app,
        "PUT",
        "/api/shares/whatever/items",
        Some(&session),
        None,
        Some(json!({"video_ids": ["x"]})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn replace_items_swaps_list_in_order_and_leaves_share_fields_untouched() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4", "c.mp4"]).await;

    let (status, created) = create_share(
        &app,
        &session,
        json!({
            "title": "Trip footage",
            "video_ids": [&videos[0], &videos[1]],
            "password": "family-only-secret",
            "expires_at": FUTURE_EXPIRY,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body = {created}");
    let id = created["id"].as_str().unwrap().to_string();

    let before: (Vec<u8>, Option<String>, String, Option<String>) = sqlx::query_as(
        "SELECT token_hash, password_hash, title, expires_at FROM shares WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(state.pool())
    .await
    .unwrap();

    // Replace with a reordered subset — curation order is array order.
    let (status, body) = replace_items(
        &app,
        &session,
        &id,
        vec![videos[2].clone(), videos[0].clone()],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "body = {body}");

    let after: (Vec<u8>, Option<String>, String, Option<String>) = sqlx::query_as(
        "SELECT token_hash, password_hash, title, expires_at FROM shares WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(state.pool())
    .await
    .unwrap();
    assert_eq!(before, after, "this endpoint writes share_items only");

    assert_eq!(
        persisted_items(state.pool(), &id).await,
        vec![videos[2].clone(), videos[0].clone()],
        "exactly the new list, in the caller's order"
    );

    // The management list reflects the edit (item_count is server-owned).
    let (_, list) = request(app, "GET", "/api/shares", Some(&session), None, None).await;
    let entry = list
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id.as_str())
        .expect("share listed");
    assert_eq!(entry["item_count"], 2);
}

#[tokio::test]
async fn replace_items_on_revoked_share_conflicts() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    let csrf = fetch_csrf(&app, &session).await;
    let (status, _) = request(
        app.clone(),
        "DELETE",
        &format!("/api/shares/{id}"),
        Some(&session),
        Some((&csrf, &csrf)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, body) = replace_items(&app, &session, &id, videos.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT, "body = {body}");
    assert_eq!(
        persisted_items(state.pool(), &id).await,
        videos,
        "a rejected replace must not touch the old list"
    );
}

#[tokio::test]
async fn replace_items_on_expired_share_conflicts() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;

    // The API refuses to create an already-expired share, so seed the row
    // straight through the repository.
    let id = castify_api::shares::ShareRepository::new(state.pool().clone())
        .create_share(&castify_api::shares::NewShare {
            owner_id: &owner_uuid(state.pool()).await,
            token_hash: &hash_share_token("expired-edit-token"),
            password_hash: None,
            title: "Expired",
            expires_at: Some("2000-01-01T00:00:00Z"),
            video_ids: &videos,
        })
        .await
        .unwrap()
        .id;

    let (status, body) = replace_items(&app, &session, &id, videos).await;
    assert_eq!(status, StatusCode::CONFLICT, "body = {body}");
}

#[tokio::test]
async fn replace_items_on_unknown_or_foreign_share_is_not_found() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;

    // Unknown id: plain 404.
    let (status, _) = replace_items(
        &app,
        &session,
        "00000000-0000-0000-0000-000000000000",
        videos.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Foreign id: also plain 404 — no existence leak across owners.
    let stranger_id = seed_stranger_share(state.pool(), &videos).await;
    let (status, _) = replace_items(&app, &session, &stranger_id, videos.clone()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        persisted_items(state.pool(), &stranger_id).await,
        videos,
        "a foreign replace must not touch the stranger's list"
    );
}

#[tokio::test]
async fn replace_items_rejects_empty_list() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    let (status, body) = replace_items(&app, &session, &id, vec![]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");
    assert!(body["message"].as_str().unwrap_or("").contains("item"));
}

#[tokio::test]
async fn replace_items_rejects_duplicate_ids() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    let (status, body) = replace_items(
        &app,
        &session,
        &id,
        vec![videos[0].clone(), videos[0].clone()],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");
}

#[tokio::test]
async fn replace_items_rejects_non_catalog_id_and_keeps_old_list() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    let bogus = vec![videos[0].clone(), "not-a-video".to_string()];
    let (status, body) = replace_items(&app, &session, &id, bogus).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");

    assert_eq!(
        persisted_items(state.pool(), &id).await,
        videos,
        "a failed replace must leave the old list intact"
    );
}
