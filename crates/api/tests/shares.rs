//! Owner-facing shares REST — integration tests (tasks 002 + 003).
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
async fn boot() -> (axum::Router, AppState, String, tempfile::TempDir) {
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

// ------------------------------------------------------------------- purge

/// CSRF-correct `DELETE` on the given URI (the caller appends any query
/// string, e.g. `?purge=true`).
async fn delete_share(app: &axum::Router, session: &str, uri: &str) -> (StatusCode, Value) {
    let csrf = fetch_csrf(app, session).await;
    request(
        app.clone(),
        "DELETE",
        uri,
        Some(session),
        Some((&csrf, &csrf)),
        None,
    )
    .await
}

#[tokio::test]
async fn purge_without_session_is_unauthorized() {
    let (app, _state, _session, _guard) = boot().await;
    let (status, _) = request(
        app,
        "DELETE",
        "/api/shares/whatever?purge=true",
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn purge_without_csrf_is_forbidden() {
    let (app, _state, session, _guard) = boot().await;
    let (status, _) = request(
        app,
        "DELETE",
        "/api/shares/whatever?purge=true",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn purge_removes_the_row_its_items_and_the_list_entry() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;
    let (_, created) = create_share(
        &app,
        &session,
        json!({"title": "Doomed", "video_ids": videos}),
    )
    .await;
    let id = created["id"].as_str().unwrap().to_string();

    let (status, body) =
        delete_share(&app, &session, &format!("/api/shares/{id}?purge=true")).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "body = {body}");

    // Hard delete: no shares row, no share_items rows (cascade), and the
    // next management list omits it.
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shares WHERE id = ?")
        .bind(&id)
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(rows, 0, "purge removes the share row");
    let items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM share_items WHERE share_id = ?")
        .bind(&id)
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(items, 0, "cascade removes the item rows");

    let (status, list) = request(app, "GET", "/api/shares", Some(&session), None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        list.as_array().unwrap().is_empty(),
        "purged share omitted from the list"
    );
}

#[tokio::test]
async fn purge_false_and_absent_param_keep_soft_delete_semantics() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;

    // Explicit false — the row survives with revoked_at set.
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let explicit = created["id"].as_str().unwrap().to_string();
    let (status, _) = delete_share(
        &app,
        &session,
        &format!("/api/shares/{explicit}?purge=false"),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (revoked_at, items): (Option<String>, i64) = sqlx::query_as(
        "SELECT revoked_at, (SELECT COUNT(*) FROM share_items WHERE share_id = shares.id) \
         FROM shares WHERE id = ?",
    )
    .bind(&explicit)
    .fetch_one(state.pool())
    .await
    .unwrap();
    assert!(revoked_at.is_some(), "purge=false is the soft delete");
    assert_eq!(items, 1, "soft delete keeps the historical items");

    // Absent param (already covered by revoke_is_idempotent_and_returns_204,
    // asserted here once more to pin the byte-for-byte contract side by
    // side with the false case).
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let absent = created["id"].as_str().unwrap().to_string();
    let (status, _) = delete_share(&app, &session, &format!("/api/shares/{absent}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let revoked_at: Option<String> =
        sqlx::query_scalar("SELECT revoked_at FROM shares WHERE id = ?")
            .bind(&absent)
            .fetch_one(state.pool())
            .await
            .unwrap();
    assert!(revoked_at.is_some());
}

#[tokio::test]
async fn purge_works_on_revoked_and_expired_shares() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;

    // Revoked through the API first (soft delete), then purged.
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let revoked_id = created["id"].as_str().unwrap().to_string();
    let (status, _) = delete_share(&app, &session, &format!("/api/shares/{revoked_id}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Expired seeded straight through the repo (the API refuses to create
    // a past expiry).
    let expired_id = castify_api::shares::ShareRepository::new(state.pool().clone())
        .create_share(&castify_api::shares::NewShare {
            owner_id: &owner_uuid(state.pool()).await,
            token_hash: &hash_share_token("expired-purge-token"),
            password_hash: None,
            title: "Expired",
            expires_at: Some("2000-01-01T00:00:00Z"),
            video_ids: &videos,
        })
        .await
        .unwrap()
        .id;

    for id in [revoked_id, expired_id] {
        let (status, body) =
            delete_share(&app, &session, &format!("/api/shares/{id}?purge=true")).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "id = {id}, body = {body}");
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shares WHERE id = ?")
            .bind(&id)
            .fetch_one(state.pool())
            .await
            .unwrap();
        assert_eq!(rows, 0, "id = {id}: past rows are purgeable too");
    }
}

#[tokio::test]
async fn purge_is_idempotent_and_leaves_foreign_rows_intact() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;

    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    // Purging twice: 204 both times — the second finds nothing and that
    // is still the terminal state the caller asked for.
    let (first, _) = delete_share(&app, &session, &format!("/api/shares/{id}?purge=true")).await;
    assert_eq!(first, StatusCode::NO_CONTENT);
    let (second, _) = delete_share(&app, &session, &format!("/api/shares/{id}?purge=true")).await;
    assert_eq!(second, StatusCode::NO_CONTENT);

    // A stranger's share id: 204 for this owner (no existence leak), row
    // and items intact for the real owner.
    let stranger_id = seed_stranger_share(state.pool(), &videos).await;
    let (status, _) = delete_share(
        &app,
        &session,
        &format!("/api/shares/{stranger_id}?purge=true"),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shares WHERE id = ?")
        .bind(&stranger_id)
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(
        rows, 1,
        "a foreign purge must not delete the stranger's row"
    );
    assert_eq!(
        persisted_items(state.pool(), &stranger_id).await.len(),
        2,
        "a foreign purge must not touch the stranger's items"
    );
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

// ----------------------------------------------------------- append items

/// CSRF-correct `POST /api/shares/{id}/items` with the given video ids.
async fn append_items(
    app: &axum::Router,
    session: &str,
    share_id: &str,
    video_ids: Vec<String>,
) -> (StatusCode, Value) {
    let csrf = fetch_csrf(app, session).await;
    request(
        app.clone(),
        "POST",
        &format!("/api/shares/{share_id}/items"),
        Some(session),
        Some((&csrf, &csrf)),
        Some(json!({"video_ids": video_ids})),
    )
    .await
}

#[tokio::test]
async fn append_items_without_session_is_unauthorized() {
    let (app, _state, _session, _guard) = boot().await;
    let (status, _) = request(
        app,
        "POST",
        "/api/shares/whatever/items",
        None,
        None,
        Some(json!({"video_ids": ["x"]})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn append_items_without_csrf_is_forbidden() {
    let (app, _state, session, _guard) = boot().await;
    let (status, _) = request(
        app,
        "POST",
        "/api/shares/whatever/items",
        Some(&session),
        None,
        Some(json!({"video_ids": ["x"]})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn append_items_appends_new_ids_and_skips_duplicates() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4", "c.mp4", "d.mp4"]).await;
    let (_, created) = create_share(
        &app,
        &session,
        json!({"title": "Trip", "video_ids": [&videos[0], &videos[1]]}),
    )
    .await;
    let id = created["id"].as_str().unwrap().to_string();

    // [c, a, d]: `a` is a member (skipped, keeps its position), c and d
    // append in request order after the existing tail.
    let (status, body) = append_items(
        &app,
        &session,
        &id,
        vec![videos[2].clone(), videos[0].clone(), videos[3].clone()],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "body = {body}");

    assert_eq!(
        persisted_items(state.pool(), &id).await,
        videos,
        "existing members keep their positions; new ids append in request order"
    );

    // The management list reflects the grown list (item_count is
    // server-owned).
    let (_, list) = request(app, "GET", "/api/shares", Some(&session), None, None).await;
    let entry = list
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id.as_str())
        .expect("share listed");
    assert_eq!(entry["item_count"], 4);
}

#[tokio::test]
async fn append_items_with_only_existing_members_is_204_and_writes_nothing() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    // All-duplicate (in-request dupes included) is tolerated: 204, not 400.
    let (status, body) = append_items(
        &app,
        &session,
        &id,
        vec![videos[1].clone(), videos[0].clone(), videos[1].clone()],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "body = {body}");
    assert_eq!(
        persisted_items(state.pool(), &id).await,
        videos,
        "an all-duplicate append must not reorder or duplicate"
    );
}

#[tokio::test]
async fn append_items_rejects_empty_list() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    let (status, body) = append_items(&app, &session, &id, vec![]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");
    assert!(body["message"].as_str().unwrap_or("").contains("item"));
}

#[tokio::test]
async fn append_items_rejects_non_catalog_id_and_keeps_old_list() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    let bogus = vec![videos[0].clone(), "not-a-video".to_string()];
    let (status, body) = append_items(&app, &session, &id, bogus).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");
    assert_eq!(
        persisted_items(state.pool(), &id).await,
        videos,
        "a failed append must leave the old list intact"
    );
}

#[tokio::test]
async fn append_items_on_unknown_or_foreign_share_is_not_found() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;

    // Unknown id: plain 404.
    let (status, _) = append_items(
        &app,
        &session,
        "00000000-0000-0000-0000-000000000000",
        videos.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Foreign id: also plain 404 — no existence leak across owners.
    let stranger_id = seed_stranger_share(state.pool(), &videos).await;
    let (status, _) = append_items(&app, &session, &stranger_id, videos.clone()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        persisted_items(state.pool(), &stranger_id).await,
        videos,
        "a foreign append must not touch the stranger's list"
    );
}

#[tokio::test]
async fn append_items_on_revoked_share_conflicts() {
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

    let (status, body) = append_items(&app, &session, &id, videos.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT, "body = {body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or("")
            .contains("share is revoked"),
        "body = {body}"
    );
    assert_eq!(
        persisted_items(state.pool(), &id).await,
        videos,
        "a rejected append must not touch the old list"
    );
}

#[tokio::test]
async fn append_items_on_expired_share_conflicts() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;

    // The API refuses to create an already-expired share, so seed the row
    // straight through the repository.
    let id = castify_api::shares::ShareRepository::new(state.pool().clone())
        .create_share(&castify_api::shares::NewShare {
            owner_id: &owner_uuid(state.pool()).await,
            token_hash: &hash_share_token("expired-append-token"),
            password_hash: None,
            title: "Expired",
            expires_at: Some("2000-01-01T00:00:00Z"),
            video_ids: &videos[..1],
        })
        .await
        .unwrap()
        .id;

    let (status, body) = append_items(&app, &session, &id, videos[1..].to_vec()).await;
    assert_eq!(status, StatusCode::CONFLICT, "body = {body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or("")
            .contains("share is expired"),
        "body = {body}"
    );
}

// --------------------------------------------------------------- get items

#[tokio::test]
async fn get_items_without_session_is_unauthorized() {
    let (app, _state, _session, _guard) = boot().await;
    let (status, _) = request(app, "GET", "/api/shares/whatever/items", None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn get_items_returns_members_in_curation_order_in_video_summary_shape() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4", "c.mp4"]).await;
    // Curated order deliberately differs from catalog insertion order.
    let curated = vec![videos[1].clone(), videos[2].clone()];

    let (status, created) = create_share(
        &app,
        &session,
        json!({"title": "Trip", "video_ids": curated}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body = {created}");
    let id = created["id"].as_str().unwrap().to_string();

    let (status, body) = request(
        app,
        "GET",
        &format!("/api/shares/{id}/items"),
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");

    let items = body["items"].as_array().expect("items is an array");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["id"], curated[0].as_str());
    assert_eq!(items[1]["id"], curated[1].as_str());
    assert_eq!(items[0]["name"], "b.mp4");

    // Field contract: the catalog's VideoSummary shape plus `folder_id`
    // (null on flat shares) — the wrapped payload adds nothing else per
    // item, and the flat share carries `folders: []`.
    assert_eq!(body["folders"], json!([]));
    assert!(items.iter().all(|i| i["folder_id"].is_null()));
    let mut keys: Vec<&str> = items[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "completed",
            "created_at",
            "duration_ms",
            "folder_id",
            "height",
            "id",
            "is_favorite",
            "mime_type",
            "my_rating",
            "name",
            "path",
            "position_seconds",
            "provider",
            "size_bytes",
            "sources",
            "thumbnail_status",
            "width",
        ]
    );
}

#[tokio::test]
async fn get_items_on_unknown_or_foreign_share_is_not_found() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;

    // Unknown id: plain 404.
    let (status, _) = request(
        app.clone(),
        "GET",
        "/api/shares/00000000-0000-0000-0000-000000000000/items",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Foreign id: also plain 404 — no existence leak across owners.
    let stranger_id = seed_stranger_share(state.pool(), &videos).await;
    let (status, _) = request(
        app,
        "GET",
        &format!("/api/shares/{stranger_id}/items"),
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// This endpoint deliberately stays permissive on terminal shares (unlike
/// the PUT): it is a read feeding the edit dialog's history, not a
/// mutation path — see the handler doc comment for the recorded choice.
#[tokio::test]
async fn get_items_serves_revoked_and_expired_shares() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;

    // Revoked through the API.
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let revoked_id = created["id"].as_str().unwrap().to_string();
    let csrf = fetch_csrf(&app, &session).await;
    let (status, _) = request(
        app.clone(),
        "DELETE",
        &format!("/api/shares/{revoked_id}"),
        Some(&session),
        Some((&csrf, &csrf)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Expired seeded through the repository (the API refuses to create one).
    let expired_id = castify_api::shares::ShareRepository::new(state.pool().clone())
        .create_share(&castify_api::shares::NewShare {
            owner_id: &owner_uuid(state.pool()).await,
            token_hash: &hash_share_token("expired-get-items-token"),
            password_hash: None,
            title: "Expired",
            expires_at: Some("2000-01-01T00:00:00Z"),
            video_ids: &videos,
        })
        .await
        .unwrap()
        .id;

    for id in [revoked_id, expired_id] {
        let (status, body) = request(
            app.clone(),
            "GET",
            &format!("/api/shares/{id}/items"),
            Some(&session),
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "id = {id}, body = {body}");
        assert_eq!(
            body["items"].as_array().unwrap().len(),
            2,
            "the historical list is still readable"
        );
    }
}

// ---------------------------------------------------- folders (0017 + 003)

/// CSRF-correct folder/item mutation helper over the raw `request`.
async fn mutate(
    app: &axum::Router,
    method: &str,
    uri: &str,
    session: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let csrf = fetch_csrf(app, session).await;
    request(
        app.clone(),
        method,
        uri,
        Some(session),
        Some((&csrf, &csrf)),
        body,
    )
    .await
}

/// `SELECT folder_id FROM share_items WHERE ...` straight from the table.
async fn persisted_placement(pool: &SqlitePool, share_id: &str, video_id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT folder_id FROM share_items WHERE share_id = ? AND video_id = ?")
        .bind(share_id)
        .bind(video_id)
        .fetch_optional(pool)
        .await
        .unwrap()
        .flatten()
}

#[tokio::test]
async fn create_folder_answers_201_with_dto_and_nests() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    let (status, body) = mutate(
        &app,
        "POST",
        &format!("/api/shares/{id}/folders"),
        &session,
        Some(json!({"name": "  Day 1  "})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body = {body}");
    assert_eq!(body["name"], "Day 1", "name stored trimmed");
    assert_eq!(body["parent_id"], Value::Null, "root parent is null");
    assert_eq!(body["position"], 0);
    let day1 = body["id"].as_str().unwrap().to_string();

    let (status, body) = mutate(
        &app,
        "POST",
        &format!("/api/shares/{id}/folders"),
        &session,
        Some(json!({"name": "Morning", "parent_id": day1})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body = {body}");
    assert_eq!(body["parent_id"], day1, "nested under Day 1");
    assert_eq!(body["position"], 0, "new scope numbers from 0");
}

#[tokio::test]
async fn patch_folder_renames_reparents_and_leaves_absent_fields_untouched() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();
    let trip = mutate(
        &app,
        "POST",
        &format!("/api/shares/{id}/folders"),
        &session,
        Some(json!({"name": "trip"})),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_string();
    let holder = mutate(
        &app,
        "POST",
        &format!("/api/shares/{id}/folders"),
        &session,
        Some(json!({"name": "holder"})),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Rename only: parent and position untouched.
    let (status, body) = mutate(
        &app,
        "PATCH",
        &format!("/api/shares/{id}/folders/{holder}"),
        &session,
        Some(json!({"name": " Renamed "})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["name"], "Renamed");
    assert_eq!(body["parent_id"], Value::Null);
    assert_eq!(body["position"], 1, "rename does not reorder");

    // Reparent only: appends at the target scope's tail.
    let (status, body) = mutate(
        &app,
        "PATCH",
        &format!("/api/shares/{id}/folders/{holder}"),
        &session,
        Some(json!({"parent_id": trip})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["parent_id"], trip);
    assert_eq!(body["position"], 0);

    // Absent fields are a clean no-op that still echoes the row.
    let (status, body) = mutate(
        &app,
        "PATCH",
        &format!("/api/shares/{id}/folders/{holder}"),
        &session,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["name"], "Renamed");
    assert_eq!(body["parent_id"], trip);

    // Explicit null parent moves back to root.
    let (status, body) = mutate(
        &app,
        "PATCH",
        &format!("/api/shares/{id}/folders/{holder}"),
        &session,
        Some(json!({"parent_id": null})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");
    assert_eq!(body["parent_id"], Value::Null);
}

#[tokio::test]
async fn delete_folder_lifts_items_to_root_and_answers_204() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4", "c.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();
    let day1 = mutate(
        &app,
        "POST",
        &format!("/api/shares/{id}/folders"),
        &session,
        Some(json!({"name": "Day 1"})),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_string();

    for video in &videos {
        let (status, _) = mutate(
            &app,
            "PATCH",
            &format!("/api/shares/{id}/items/{video}"),
            &session,
            Some(json!({"folder_id": day1})),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    let (status, _) = mutate(
        &app,
        "DELETE",
        &format!("/api/shares/{id}/folders/{day1}"),
        &session,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Membership survives; every item sits at root again.
    assert_eq!(persisted_items(state.pool(), &id).await.len(), 3);
    for video in &videos {
        assert_eq!(
            persisted_placement(state.pool(), &id, video).await,
            None,
            "folder deletion lifts items to root — membership intact"
        );
    }
    let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM share_folders WHERE share_id = ?")
        .bind(&id)
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(folders, 0, "folder row is gone");
}

#[tokio::test]
async fn folder_validation_matrix_maps_each_rejection() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    let post = |name: Value| {
        let app = app.clone();
        let session = session.clone();
        let id = id.clone();
        async move {
            mutate(
                &app,
                "POST",
                &format!("/api/shares/{id}/folders"),
                &session,
                Some(name),
            )
            .await
        }
    };

    let (status, body) = post(json!({"name": "   "})).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "whitespace-only name — {body}"
    );
    let (status, body) = post(json!({"name": "x".repeat(201)})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "201 chars — {body}");
    let (status, body) = post(json!({"name": "trip"})).await;
    assert_eq!(status, StatusCode::CREATED, "body = {body}");
    let (status, body) = post(json!({"name": "trip"})).await;
    assert_eq!(status, StatusCode::CONFLICT, "sibling duplicate — {body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("sibling"),
        "duplicate carries the sibling message: {body}"
    );

    // Depth: chain of 8 legal, 9th rejected; cycle: folder under itself.
    let mut parent = mutate(
        &app,
        "POST",
        &format!("/api/shares/{id}/folders"),
        &session,
        Some(json!({"name": "d1"})),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_string();
    for depth in 2..=8 {
        parent = mutate(
            &app,
            "POST",
            &format!("/api/shares/{id}/folders"),
            &session,
            Some(json!({"name": format!("d{depth}"), "parent_id": parent})),
        )
        .await
        .1["id"]
            .as_str()
            .unwrap()
            .to_string();
    }
    let (status, body) = mutate(
        &app,
        "POST",
        &format!("/api/shares/{id}/folders"),
        &session,
        Some(json!({"name": "d9", "parent_id": parent})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "depth cap — {body}");

    let d1_row: String =
        sqlx::query_scalar("SELECT id FROM share_folders WHERE share_id = ? AND name = 'd1'")
            .bind(&id)
            .fetch_one(state.pool())
            .await
            .unwrap();
    let (status, body) = mutate(
        &app,
        "PATCH",
        &format!("/api/shares/{id}/folders/{d1_row}"),
        &session,
        Some(json!({"parent_id": parent})),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "reparent into own subtree — {body}"
    );
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("subtree"),
        "cycle carries the subtree message: {body}"
    );
}

#[tokio::test]
async fn folder_and_item_mutations_gate_session_and_csrf() {
    let (app, _state, _session, _guard) = boot().await;
    let share = "00000000-0000-0000-0000-000000000000";

    for method in ["POST", "PATCH", "DELETE"] {
        let (status, _) = request(
            app.clone(),
            method,
            &format!("/api/shares/{share}/folders"),
            None,
            None,
            Some(json!({"name": "x"})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} folders 401");

        let (status, _) = request(
            app.clone(),
            method,
            &format!("/api/shares/{share}/items/00000000-0000-0000-0000-000000000000"),
            None,
            None,
            Some(json!({"folder_id": null})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} items 401");
    }

    // Session without CSRF is 403 (double-submit, like every owner write).
    let (app2, _state, session, _guard) = boot().await;
    let (status, _) = request(
        app2,
        "POST",
        &format!("/api/shares/{share}/folders"),
        Some(&session),
        None,
        Some(json!({"name": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn folder_and_item_mutations_scope_owner_share_folder_and_video() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;
    let (_, created) =
        create_share(&app, &session, json!({"video_ids": videos[..1].to_vec()})).await;
    let id = created["id"].as_str().unwrap().to_string();
    let stranger_id = seed_stranger_share(state.pool(), &videos).await;
    // A folder that exists — but in the stranger's share (created with
    // the stranger's own owner id so the repo guard accepts it).
    let stranger_owner: String = sqlx::query_scalar("SELECT owner_id FROM shares WHERE id = ?")
        .bind(&stranger_id)
        .fetch_one(state.pool())
        .await
        .unwrap();
    let foreign_folder = castify_api::shares::ShareRepository::new(state.pool().clone())
        .create_folder(&stranger_owner, &stranger_id, None, "theirs")
        .await
        .unwrap()
        .unwrap()
        .id;
    // A revoked share of our own.
    let (_, revoked_created) =
        create_share(&app, &session, json!({"video_ids": videos[..1].to_vec()})).await;
    let revoked_id = revoked_created["id"].as_str().unwrap().to_string();
    let csrf = fetch_csrf(&app, &session).await;
    let (status, _) = request(
        app.clone(),
        "DELETE",
        &format!("/api/shares/{revoked_id}"),
        Some(&session),
        Some((&csrf, &csrf)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Foreign share: plain 404 on every mutation, no existence leak.
    for (method, uri, body) in [
        (
            "POST",
            format!("/api/shares/{stranger_id}/folders"),
            Some(json!({"name": "x"})),
        ),
        (
            "PATCH",
            format!("/api/shares/{stranger_id}/folders/{foreign_folder}"),
            Some(json!({"name": "x"})),
        ),
        (
            "DELETE",
            format!("/api/shares/{stranger_id}/folders/{foreign_folder}"),
            None,
        ),
        (
            "PATCH",
            format!("/api/shares/{stranger_id}/items/{}", videos[0]),
            Some(json!({"folder_id": null})),
        ),
        (
            "DELETE",
            format!("/api/shares/{stranger_id}/items/{}", videos[0]),
            None,
        ),
    ] {
        let (status, body_out) = request(
            app.clone(),
            method,
            &uri,
            Some(&session),
            Some((&csrf, &csrf)),
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri} — {body_out}");
    }

    // Revoked share: 409 naming the state (owner can see it in their list).
    for (method, uri, body) in [
        (
            "POST",
            format!("/api/shares/{revoked_id}/folders"),
            Some(json!({"name": "x"})),
        ),
        (
            "DELETE",
            format!("/api/shares/{revoked_id}/folders/whatever"),
            None,
        ),
        (
            "PATCH",
            format!("/api/shares/{revoked_id}/items/{}", videos[0]),
            Some(json!({"folder_id": null})),
        ),
    ] {
        let (status, body_out) = request(
            app.clone(),
            method,
            &uri,
            Some(&session),
            Some((&csrf, &csrf)),
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{method} {uri} — {body_out}");
    }

    // Our live share, but a foreign folder id and a non-member video: 404.
    for (method, uri, body) in [
        (
            "POST",
            format!("/api/shares/{id}/folders"),
            Some(json!({"name": "x", "parent_id": foreign_folder})),
        ),
        (
            "PATCH",
            format!("/api/shares/{id}/folders/{foreign_folder}"),
            Some(json!({"name": "x"})),
        ),
        (
            "DELETE",
            format!("/api/shares/{id}/folders/{foreign_folder}"),
            None,
        ),
        (
            "PATCH",
            format!("/api/shares/{id}/items/{}", videos[1]),
            Some(json!({"folder_id": foreign_folder})),
        ),
        (
            "DELETE",
            format!("/api/shares/{id}/items/{}", videos[1]),
            None,
        ),
    ] {
        let (status, body_out) = request(
            app.clone(),
            method,
            &uri,
            Some(&session),
            Some((&csrf, &csrf)),
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri} — {body_out}");
    }

    // Unknown share id: plain 404.
    let (status, _) = request(
        app.clone(),
        "POST",
        "/api/shares/00000000-0000-0000-0000-000000000000/folders",
        Some(&session),
        Some((&csrf, &csrf)),
        Some(json!({"name": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // None of the rejected writes touched either share's rows.
    let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM share_folders")
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(folders, 1, "only the stranger's own folder exists");
    assert_eq!(persisted_items(state.pool(), &id).await.len(), 1);
}

#[tokio::test]
async fn patch_item_moves_membership_between_scopes() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();
    let trip = mutate(
        &app,
        "POST",
        &format!("/api/shares/{id}/folders"),
        &session,
        Some(json!({"name": "trip"})),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, _) = mutate(
        &app,
        "PATCH",
        &format!("/api/shares/{id}/items/{}", videos[0]),
        &session,
        Some(json!({"folder_id": trip})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        persisted_placement(state.pool(), &id, &videos[0]).await,
        Some(trip.clone())
    );

    // Null moves back to root.
    let (status, _) = mutate(
        &app,
        "PATCH",
        &format!("/api/shares/{id}/items/{}", videos[0]),
        &session,
        Some(json!({"folder_id": null})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        persisted_placement(state.pool(), &id, &videos[0]).await,
        None
    );

    // Membership never changes through a move.
    assert_eq!(persisted_items(state.pool(), &id).await.len(), 2);
}

#[tokio::test]
async fn remove_item_deletes_and_guards_the_last_item() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    let (status, _) = mutate(
        &app,
        "DELETE",
        &format!("/api/shares/{id}/items/{}", videos[0]),
        &session,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        persisted_items(state.pool(), &id).await,
        vec![videos[1].clone()]
    );

    // The last item cannot leave — a share must keep at least 1 item.
    let (status, body) = mutate(
        &app,
        "DELETE",
        &format!("/api/shares/{id}/items/{}", videos[1]),
        &session,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");
    assert_eq!(persisted_items(state.pool(), &id).await.len(), 1);
}

#[tokio::test]
async fn get_items_carries_the_folder_tree_for_the_owner_too() {
    let (app, state, session, _guard) = boot().await;
    let videos = seed_videos(state.pool(), &["a.mp4", "b.mp4", "c.mp4"]).await;
    let (_, created) = create_share(&app, &session, json!({"video_ids": videos})).await;
    let id = created["id"].as_str().unwrap().to_string();

    // Organize through the owner API itself — the manage page's exact
    // writes.
    let trip = mutate(
        &app,
        "POST",
        &format!("/api/shares/{id}/folders"),
        &session,
        Some(json!({"name": "Trip"})),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, _) = mutate(
        &app,
        "PATCH",
        &format!("/api/shares/{id}/items/{}", videos[1]),
        &session,
        Some(json!({"folder_id": trip})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, body) = request(
        app,
        "GET",
        &format!("/api/shares/{id}/items"),
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");

    // Same DTO, same order rule as the recipient read: folders flat,
    // items root-first then per folder.
    let folders = body["folders"].as_array().unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0]["name"], "Trip");
    let items = body["items"].as_array().unwrap();
    let ids: Vec<&str> = items.iter().map(|v| v["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        vec![videos[0].as_str(), videos[2].as_str(), videos[1].as_str()],
        "root items first, then the folder's"
    );
    assert_eq!(items[2]["folder_id"], trip);
    assert!(items[0]["folder_id"].is_null());
}
