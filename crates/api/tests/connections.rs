mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use castify_catalog::{Credential, NewConnection, Provider, TokenBundle};

const PASSWORD: &str = "correct horse battery staple";

async fn boot_and_setup() -> (
    axum::Router,
    String,
    castify_catalog::CatalogRepository,
    tempfile::TempPath,
) {
    let (state, guard, _path) = common::fresh_state().await;
    let repo = state.catalog_repository().clone();
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
    (app, cookie, repo, guard)
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
async fn available_lists_all_providers_with_auth_mode() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, body) = get_json(app, "/api/connections/available", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let entries = body.as_array().expect("available returns a list");
    assert_eq!(entries.len(), 4);

    let by_id: std::collections::HashMap<&str, &serde_json::Value> = entries
        .iter()
        .map(|e| (e["id"].as_str().unwrap(), e))
        .collect();

    // OAuth providers report their flow + configured flag (false in the
    // fresh test state — no env credentials).
    for id in ["google_drive", "dropbox", "onedrive"] {
        let e = by_id.get(id).unwrap_or_else(|| panic!("missing {id}"));
        assert_eq!(e["authMode"], "oauth", "{id} authMode");
        assert_eq!(e["configured"], false, "{id} configured");
    }

    // S3 reports credentials mode and is always configured (OQ-3: no
    // server-level credentials, no kill-switch).
    let s3 = by_id.get("s3").expect("missing s3");
    assert_eq!(s3["authMode"], "credentials");
    assert_eq!(s3["configured"], true);
}

#[tokio::test]
async fn available_includes_credentials_schema_for_s3() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, body) = get_json(app, "/api/connections/available", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let entries = body.as_array().expect("available returns a list");
    let by_id: std::collections::HashMap<&str, &serde_json::Value> = entries
        .iter()
        .map(|e| (e["id"].as_str().unwrap(), e))
        .collect();

    // OAuth entries carry no form schema at all — the key is skipped, not
    // nulled, so their wire shape is byte-identical to pre-schema responses.
    for id in ["google_drive", "dropbox", "onedrive"] {
        assert!(
            by_id.get(id).unwrap().get("credentials").is_none(),
            "{id} should not carry a credentials schema"
        );
    }

    // The S3 entry carries the renderable form: the six schema fields in
    // form order, with exactly the two key fields flagged secret.
    let fields = by_id["s3"]["credentials"]["fields"]
        .as_array()
        .expect("s3 credentials.fields");
    let keys: Vec<&str> = fields.iter().map(|f| f["key"].as_str().unwrap()).collect();
    assert_eq!(
        keys,
        vec![
            "endpoint",
            "region",
            "bucket",
            "access_key_id",
            "secret_access_key",
            "prefix"
        ]
    );
    for field in fields {
        let key = field["key"].as_str().unwrap();
        let secret = field["secret"].as_bool().unwrap();
        let expected = key == "access_key_id" || key == "secret_access_key";
        assert_eq!(secret, expected, "{key} secret flag");
        assert!(
            field["label"].as_str().is_some_and(|l| !l.is_empty()),
            "{key} label"
        );
    }
}

#[tokio::test]
async fn list_returns_empty_array() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, body) = get_json(app, "/api/connections", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.is_array());
    assert_eq!(body.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn start_returns_503_when_not_configured() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
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
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
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
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
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
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
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

/// FR-1.1 / FR-1.3 / FR-1.4 — `DELETE /api/connections/{id}` is a soft-delete:
/// it sets `disconnected_at` (204) but leaves the connection row, its videos,
/// and all dependent `playback_progress` / `video_favorites` / `video_ratings`
/// rows in place. The connection is hidden from `GET /api/connections` and
/// `fetch_connection` (both filter `disconnected_at IS NULL`).
#[tokio::test]
async fn disconnect_soft_deletes_preserving_dependent_rows() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let conn = seed_connection(&repo).await;

    // Seed a video + progress + favorite + rating for that connection.
    repo.upsert_video(
        &conn.id,
        Provider::GoogleDrive,
        &castify_catalog::NewVideo {
            provider_file_id: "file-1".into(),
            name: "movie.mp4".into(),
            path: Some("/Videos".into()),
            size_bytes: 1000,
            mime_type: Some("video/mp4".into()),
            duration_ms: Some(120_000),
            width: None,
            height: None,
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        },
    )
    .await
    .unwrap();
    let video_id: String = sqlx::query_scalar(
        "SELECT id FROM videos WHERE connection_id = ? AND provider_file_id = ?",
    )
    .bind(&conn.id)
    .bind("file-1")
    .fetch_one(repo.pool())
    .await
    .unwrap();

    // Owner id is a random UUID minted by setup; resolve it from the DB.
    let owner_id: String = sqlx::query_scalar("SELECT id FROM owners LIMIT 1")
        .fetch_one(repo.pool())
        .await
        .unwrap();
    repo.upsert_progress(owner_id.as_str(), &video_id, 42.0, Some(120.0), false)
        .await
        .unwrap();
    repo.set_favorite(owner_id.as_str(), &video_id)
        .await
        .unwrap();
    repo.upsert_rating(owner_id.as_str(), &video_id, 4)
        .await
        .unwrap();

    // Sanity: everything is present pre-disconnect.
    assert_eq!(
        repo.video_count_by_connection(&conn.id).await.unwrap(),
        1,
        "video seeded"
    );
    assert!(
        repo.is_connection_active(&conn.id).await.unwrap(),
        "connection is active before disconnect"
    );

    // ── Disconnect via the route. ──
    let status = delete(
        app.clone(),
        &format!("/api/connections/{}", conn.id),
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "disconnect returns 204");

    // FR-1.4: hidden from the active-connection views.
    assert!(
        repo.fetch_connection(&conn.id).await.unwrap().is_none(),
        "fetch_connection hides soft-deleted connections"
    );
    let (list_status, list_body) = get_json(app, "/api/connections", Some(&cookie)).await;
    assert_eq!(list_status, StatusCode::OK);
    assert!(
        list_body.as_array().unwrap().is_empty(),
        "GET /api/connections omits soft-deleted connections"
    );
    assert!(
        !repo.is_connection_active(&conn.id).await.unwrap(),
        "connection is inactive after disconnect"
    );

    // FR-1.3: dependent rows survive the soft-delete (no CASCADE).
    assert_eq!(
        repo.video_count_by_connection(&conn.id).await.unwrap(),
        1,
        "video row survives soft-delete"
    );
    let progress_kept: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM playback_progress WHERE video_id = ?")
            .bind(&video_id)
            .fetch_one(repo.pool())
            .await
            .unwrap();
    assert_eq!(progress_kept, 1, "playback_progress row survives");
    let favs_kept: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM video_favorites WHERE video_id = ?")
            .bind(&video_id)
            .fetch_one(repo.pool())
            .await
            .unwrap();
    assert_eq!(favs_kept, 1, "video_favorites row survives");
    let ratings_kept: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM video_ratings WHERE video_id = ?")
            .bind(&video_id)
            .fetch_one(repo.pool())
            .await
            .unwrap();
    assert_eq!(ratings_kept, 1, "video_ratings row survives");

    // The connection row itself is still in the table, now soft-deleted.
    let disconnected_at: Option<String> =
        sqlx::query_scalar("SELECT disconnected_at FROM provider_connections WHERE id = ?")
            .bind(&conn.id)
            .fetch_one(repo.pool())
            .await
            .unwrap();
    assert!(
        disconnected_at.is_some(),
        "disconnected_at is set after disconnect"
    );
}

#[tokio::test]
async fn list_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = get_json(app, "/api/connections", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

fn sample_credential() -> Credential {
    Credential::OAuth(sample_bundle())
}

fn sample_bundle() -> TokenBundle {
    TokenBundle {
        access_token: "ya29.test".into(),
        refresh_token: Some("refresh".into()),
        expires_at: None,
        token_type: "Bearer".into(),
        scope: None,
    }
}

async fn seed_connection(
    repo: &castify_catalog::CatalogRepository,
) -> castify_catalog::ProviderConnection {
    repo.create_connection(&NewConnection {
        provider: Provider::GoogleDrive,
        credential: sample_credential(),
        provider_account_id: Some("acct-1".into()),
        provider_account_email: Some("user@example.com".into()),
    })
    .await
    .unwrap()
}

// --- Scan status ---

#[tokio::test]
async fn scan_status_returns_default_idle_for_unscanned_connection() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo).await;

    let (status, body) = get_json(
        app,
        &format!("/api/connections/{}/scan", conn.id),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "idle");
    assert_eq!(body["videos_found"], 0);
}

#[tokio::test]
async fn scan_status_404_for_nonexistent_connection() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, _body) = get_json(app, "/api/connections/nonexistent/scan", Some(&cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn scan_status_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = get_json(app, "/api/connections/x/scan", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// --- Rescan trigger ---

#[tokio::test]
async fn rescan_returns_202_for_idle_connection() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let conn = seed_connection(&repo).await;

    let (status, _body) = post_json(
        app,
        &format!("/api/connections/{}/scan", conn.id),
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
}

#[tokio::test]
async fn rescan_returns_409_when_already_scanning() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let conn = seed_connection(&repo).await;

    // Manually set scan state to "scanning" to simulate an in-progress scan.
    repo.upsert_scan_state(&castify_catalog::ScanState {
        connection_id: conn.id.clone(),
        status: castify_catalog::ScanStatus::Scanning,
        cursor: None,
        started_at: Some("2026-01-01T00:00:00Z".into()),
        completed_at: None,
        error_message: None,
        videos_found: 5,
    })
    .await
    .unwrap();

    let (status, body) = post_json(
        app,
        &format!("/api/connections/{}/scan", conn.id),
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body["message"]
        .as_str()
        .unwrap_or("")
        .contains("already in progress"));
}

#[tokio::test]
async fn rescan_404_for_nonexistent_connection() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;

    let (status, _body) = post_json(
        app,
        "/api/connections/nonexistent/scan",
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rescan_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = post_json(app, "/api/connections/x/scan", None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// --- Reconnect lookup (used by OAuth callback to detect token-rotation
// reconnects vs fresh connects) ---
//
// `find_active_connection_by_account` is what lets the callback UPDATE the
// token on an existing row (preserving the library + connection_id) instead
// of INSERTing a duplicate and violating UNIQUE(provider, provider_account_id).
// Without it, the watch page's inline Reconnect button would 500 on callback.

#[tokio::test]
async fn find_active_connection_by_account_returns_existing_row() {
    let (_app, _cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo).await;

    let found = repo
        .find_active_connection_by_account(Provider::GoogleDrive, "acct-1")
        .await
        .unwrap()
        .expect("expected the seeded connection to be findable");
    assert_eq!(found.id, conn.id);
    assert_eq!(found.provider, Provider::GoogleDrive);
}

#[tokio::test]
async fn find_active_connection_by_account_returns_none_for_unknown_account() {
    let (_app, _cookie, repo, _guard) = boot_and_setup().await;
    // No connection seeded — lookup must return None rather than erroring,
    // so the callback can fall through to the create-new-connection path.
    let found = repo
        .find_active_connection_by_account(Provider::GoogleDrive, "acct-1")
        .await
        .unwrap();
    assert!(found.is_none());
}

#[tokio::test]
async fn find_active_connection_by_account_returns_none_for_mismatched_account() {
    let (_app, _cookie, repo, _guard) = boot_and_setup().await;
    seed_connection(&repo).await; // account_id = "acct-1"
                                  // Different account_id — must NOT match. (Maps the "user reconnected
                                  // with a different account at the same provider" case, which is a
                                  // legitimate new-connection path, not a token rotation on the existing row.)
    let found = repo
        .find_active_connection_by_account(Provider::GoogleDrive, "different-acct")
        .await
        .unwrap();
    assert!(found.is_none());
}

/// A connection seeded with `provider_account_id = NULL` cannot be matched
/// by the upsert lookup (which keys on a non-null account_id). This is the
/// core reason `callback_inner` refuses to proceed when a reconnect's
/// `fetch_user_info` returns `None` for the account_id: the lookup would
/// miss, the fresh-insert path would create a duplicate row (SQLite UNIQUE
/// allows multiple NULLs), and the user's library would stay orphaned on
/// the dead-token row. Proving the lookup miss here documents why the
/// guard in `callback_inner` is the only defense.
#[tokio::test]
async fn find_active_connection_by_account_returns_none_when_seeded_account_id_is_null() {
    let (_app, _cookie, repo, _guard) = boot_and_setup().await;
    repo.create_connection(&NewConnection {
        provider: Provider::GoogleDrive,
        credential: sample_credential(),
        provider_account_id: None,
        provider_account_email: Some("user@example.com".into()),
    })
    .await
    .unwrap();

    // Any non-null lookup misses the NULL-account row — including the
    // realistic "the user just re-granted and the provider returned the
    // same email but a different (or null) account_id" case.
    let found = repo
        .find_active_connection_by_account(Provider::GoogleDrive, "user@example.com")
        .await
        .unwrap();
    assert!(
        found.is_none(),
        "NULL-account rows must not be reachable via account-based upsert lookup"
    );
}

// --- FR-2.1 / FR-2.2: Reconnect revives a soft-deleted connection in place ---

/// A helper that builds a minimal `NewVideo` so the identity-preservation
/// test can pass the same descriptor to both upserts (the rescan must see
/// the same `provider_file_id` to hit the ON CONFLICT path).
fn sample_video(file_id: &str) -> castify_catalog::NewVideo {
    castify_catalog::NewVideo {
        provider_file_id: file_id.into(),
        name: "movie.mp4".into(),
        path: Some("/Videos".into()),
        size_bytes: 1000,
        mime_type: Some("video/mp4".into()),
        duration_ms: Some(120_000),
        width: None,
        height: None,
        native_hash: None,
        native_hash_algo: None,
        provider_modified_at: None,
    }
}

/// FR-2.1 / FR-2.2 — disconnect→reconnect of the same provider account is
/// lossless: the connection `id` and every video UUID survive. This drives
/// the exact sequence of repository operations the OAuth callback performs
/// on revive: `find_connection_by_account` (finds the soft-deleted row) →
/// `revive_connection` (clears `disconnected_at`) → `update_token_bundle`
/// (rotates the token) → `upsert_video` (the rescan re-lists the same
/// file). Because `upsert_video` hits `ON CONFLICT(connection_id,
/// provider_file_id) DO UPDATE` — which omits `id` — the video keeps its
/// original UUID. The `UNIQUE(provider, provider_account_id)` constraint
/// means revive is the *only* viable path while the soft-deleted row exists
/// (a fresh insert would violate it), so the test also confirms no
/// constraint error and no duplicate rows.
#[tokio::test]
async fn reconnect_revives_soft_deleted_connection_preserving_identity() {
    let (_app, _cookie, repo, _guard) = boot_and_setup().await;

    // ── Seed an active connection with two videos; record every UUID. ──
    let conn = repo
        .create_connection(&NewConnection {
            provider: Provider::GoogleDrive,
            credential: sample_credential(),
            provider_account_id: Some("acct-revive".into()),
            provider_account_email: Some("user@example.com".into()),
        })
        .await
        .unwrap();

    repo.upsert_video(&conn.id, Provider::GoogleDrive, &sample_video("file-1"))
        .await
        .unwrap();
    repo.upsert_video(&conn.id, Provider::GoogleDrive, &sample_video("file-2"))
        .await
        .unwrap();

    let original_conn_id = conn.id.clone();
    let original_video_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM videos WHERE connection_id = ? ORDER BY provider_file_id",
    )
    .bind(&conn.id)
    .fetch_all(repo.pool())
    .await
    .unwrap();
    assert_eq!(original_video_ids.len(), 2, "two videos seeded");

    // ── Disconnect (Task 3 soft-delete). ──
    assert!(repo.disconnect(&conn.id).await.unwrap());

    // While disconnected: active lookup misses, but the inclusive lookup
    // finds the soft-deleted row (this is the callback's new revive trigger).
    assert!(
        repo.find_active_connection_by_account(Provider::GoogleDrive, "acct-revive")
            .await
            .unwrap()
            .is_none(),
        "active lookup misses soft-deleted connection"
    );
    let found = repo
        .find_connection_by_account(Provider::GoogleDrive, "acct-revive")
        .await
        .unwrap()
        .expect("inclusive lookup finds the soft-deleted row for revive");
    assert!(
        found.disconnected_at.is_some(),
        "found row is the soft-deleted one"
    );
    assert_eq!(found.id, original_conn_id);

    // ── Simulate the callback's revive path. ──
    assert!(
        repo.revive_connection(&found.id).await.unwrap(),
        "revive_connection reports a soft-deleted row was revived"
    );
    repo.update_credential(&found.id, &sample_credential())
        .await
        .unwrap();
    // Rescan: the provider lists the same files again. ON CONFLICT DO
    // UPDATE keeps `id` stable.
    repo.upsert_video(&found.id, Provider::GoogleDrive, &sample_video("file-1"))
        .await
        .unwrap();
    repo.upsert_video(&found.id, Provider::GoogleDrive, &sample_video("file-2"))
        .await
        .unwrap();

    // ── FR-2.2: identity is preserved. ──
    assert!(
        repo.is_connection_active(&original_conn_id).await.unwrap(),
        "connection is active again after revive"
    );
    let revived = repo
        .find_active_connection_by_account(Provider::GoogleDrive, "acct-revive")
        .await
        .unwrap()
        .expect("revived connection is now visible to the active lookup");
    assert_eq!(
        revived.id, original_conn_id,
        "connection id preserved across disconnect→revive"
    );

    let revived_video_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM videos WHERE connection_id = ? ORDER BY provider_file_id",
    )
    .bind(&original_conn_id)
    .fetch_all(repo.pool())
    .await
    .unwrap();
    assert_eq!(
        revived_video_ids, original_video_ids,
        "every video UUID preserved across disconnect→revive→rescan"
    );
    assert_eq!(
        revived_video_ids.len(),
        2,
        "no duplicate video rows after revive rescan"
    );
}

// ── Task 007: POST /api/connections/s3 (credentials connect) ──────────

/// `post_json`, but with a JSON body — the credentials form posts one.
async fn post_json_body(
    app: axum::Router,
    uri: &str,
    cookie: Option<&str>,
    csrf_header: Option<&str>,
    csrf_cookie: Option<&str>,
    body: Value,
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
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

fn s3_connect_body(endpoint: &str) -> Value {
    serde_json::json!({
        "endpoint": endpoint,
        "region": "us-east-1",
        "bucket": "media",
        "access_key_id": "minioadmin",
        "secret_access_key": "minioadmin"
    })
}

#[tokio::test]
async fn s3_connect_rejects_unauthenticated() {
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);
    let (status, _) = post_json_body(
        app,
        "/api/connections/s3",
        None,
        None,
        None,
        s3_connect_body("http://127.0.0.1:9000"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn s3_connect_requires_csrf_token() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (status, _) = post_json_body(
        app,
        "/api/connections/s3",
        Some(&cookie),
        None,
        None,
        s3_connect_body("http://127.0.0.1:9000"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

/// Endpoint validation runs before any S3 request is signed — an http
/// endpoint for a non-loopback host is a 400 naming the rule, not a
/// network error.
#[tokio::test]
async fn s3_connect_rejects_http_non_loopback_endpoint() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let (status, body) = post_json_body(
        app,
        "/api/connections/s3",
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
        s3_connect_body("http://minio.internal.example:9000"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let message = body["message"].as_str().unwrap_or("").to_lowercase();
    assert!(
        message.contains("https") || message.contains("loopback"),
        "message should name the http/loopback rule: {body}"
    );
}

/// SSRF hardening at the route level: https to a private-range literal is
/// rejected with a 400 before verify.
#[tokio::test]
async fn s3_connect_rejects_private_range_endpoint() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let (status, body) = post_json_body(
        app,
        "/api/connections/s3",
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
        s3_connect_body("https://10.9.8.7:9000"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let message = body["message"].as_str().unwrap_or("").to_lowercase();
    assert!(
        message.contains("private") || message.contains("loopback"),
        "message should name the range problem: {body}"
    );
}

/// A payload missing a required field is a 4xx (serde rejection or the
/// handler's blank-field validation — either way, no connection).
#[tokio::test]
async fn s3_connect_rejects_missing_secret_field() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let (csrf_token, csrf_cookie) = get_csrf(&app, &cookie).await;
    let mut body = s3_connect_body("http://127.0.0.1:9000");
    body.as_object_mut().unwrap().remove("secret_access_key");
    let (status, _) = post_json_body(
        app,
        "/api/connections/s3",
        Some(&cookie),
        Some(&csrf_token),
        Some(&csrf_cookie),
        body,
    )
    .await;
    assert!(status.is_client_error(), "expected 4xx, got {status}");
}

// ── Task 009: streaming through the credentials-flow path ────────────

/// An S3-credential connection's video resolves a stream URL WITHOUT the
/// OAuth scaffolding: before the credential-kind fix, every streaming
/// route hard-required an OAuth bundle and rejected `Credential::S3` with
/// a 422 ("connection does not use OAuth credentials"). `stream-url` must
/// return the direct strategy — a presigned URL from the real S3 factory
/// (presigning is local SigV4 computation, no network), or the mock-cdn
/// URL under the `e2e` feature.
#[tokio::test]
async fn stream_url_resolves_for_s3_credential_connection() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;

    let conn = repo
        .create_connection(&NewConnection {
            provider: Provider::S3Compatible,
            credential: Credential::S3(castify_catalog::S3Credentials {
                endpoint: "http://127.0.0.1:9000".into(),
                region: "us-east-1".into(),
                bucket: "media".into(),
                access_key_id: "minioadmin".into(),
                secret_access_key: "minioadmin".into(),
                prefix: None,
            }),
            provider_account_id: Some("s3-stream-test".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();

    repo.upsert_video(
        &conn.id,
        Provider::S3Compatible,
        &castify_catalog::NewVideo {
            provider_file_id: "Movies/holiday.mp4".into(),
            name: "holiday.mp4".into(),
            path: Some("/Movies/holiday.mp4".into()),
            size_bytes: 129_201,
            mime_type: Some("video/mp4".into()),
            duration_ms: Some(8_000),
            width: Some(160),
            height: Some(120),
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        },
    )
    .await
    .unwrap();

    let video_id: String = sqlx::query_scalar(
        "SELECT id FROM videos WHERE connection_id = ? AND provider_file_id = ?",
    )
    .bind(&conn.id)
    .bind("Movies/holiday.mp4")
    .fetch_one(repo.pool())
    .await
    .unwrap();

    let (status, body) = get_json(
        app,
        &format!("/api/videos/{video_id}/stream-url"),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["strategy"], "direct", "body: {body}");
    let url = body["url"].as_str().unwrap();
    assert!(
        url.starts_with("http://127.0.0.1:9000/media/Movies/holiday.mp4")
            || url.starts_with("/api/__e2e/mock-cdn/"),
        "unexpected stream url: {url}"
    );
}
