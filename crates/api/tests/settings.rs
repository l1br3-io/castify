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

/// Issue a PUT /api/settings/transcode with the given cookie/header pair
/// (`None` sends no CSRF token) and raw body. Returns status + parsed body
/// (body parse is best-effort; non-JSON rejections yield `Value::Null`).
async fn put_transcode(
    app: &axum::Router,
    cookies: &str,
    csrf_token: Option<&str>,
    body: &str,
) -> StatusCode {
    let mut builder = Request::builder()
        .method("PUT")
        .uri("/api/settings/transcode")
        .header("cookie", cookies)
        .header("content-type", "application/json");
    if let Some(token) = csrf_token {
        builder = builder.header("x-csrf-token", token);
    }
    let response = app
        .clone()
        .oneshot(
            builder
                .body(Body::from(Bytes::from(body.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    response.status()
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

#[tokio::test]
async fn settings_transcode_requires_a_session() {
    let (state, guard, _path) = common::fresh_state().await;
    let app = build_app(state);

    // No session cookie → the auth middleware rejects before the handler.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/settings/transcode")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    drop(guard);
}

#[tokio::test]
async fn put_transcode_without_csrf_or_with_invalid_body_is_rejected() {
    let (state, guard, _path) = common::fresh_state().await;
    let pool = state.pool().clone();
    let app = build_app(state);

    let cookie = setup_owner(&app).await;
    let (token, cookies) = csrf_request_parts(&app, &cookie).await;

    // Authenticated mutation without the CSRF pair → 403, nothing persisted.
    let status = put_transcode(&app, &cookie, None, r#"{"enabled": true}"#).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // With CSRF but a syntactically invalid body → 400 (extractor
    // rejection), nothing persisted.
    let status = put_transcode(&app, &cookies, Some(&token), r#"{"enabled": "yes"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The failed PUTs must not have flipped the toggle or written a row.
    let (status, body) = get_json(&app, &cookie, "/api/settings/transcode").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], false);
    let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM settings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 0, "rejected PUTs must not persist anything");
    drop(guard);
}

#[tokio::test]
async fn stream_url_strategy_flips_with_the_runtime_toggle() {
    use castify_catalog::{Credential, NewConnection, NewVideo, Provider, S3Credentials};

    // Codec-incompatible video (mpeg2video is an unconditional No in the
    // codec map) on an S3-credential connection: stream-url resolves a
    // presigned URL locally (SigV4, no network, no e2e feature needed).
    let (state, guard, _path) = common::fresh_state_with(|c| c.transcode.enabled = false).await;
    let repo = state.catalog_repository().clone();
    let app = build_app(state);

    let cookie = setup_owner(&app).await;

    let conn = repo
        .create_connection(&NewConnection {
            provider: Provider::S3Compatible,
            credential: Credential::S3(S3Credentials {
                endpoint: "http://127.0.0.1:9000".into(),
                region: "us-east-1".into(),
                bucket: "media".into(),
                access_key_id: "minioadmin".into(),
                secret_access_key: "minioadmin".into(),
                prefix: None,
            }),
            provider_account_id: Some("settings-toggle-test".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();
    repo.upsert_video(
        &conn.id,
        Provider::S3Compatible,
        &NewVideo {
            provider_file_id: "Movies/holiday.mkv".into(),
            name: "holiday.mkv".into(),
            path: Some("/Movies/holiday.mkv".into()),
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
    let video_id: String =
        sqlx::query_scalar("SELECT id FROM videos WHERE provider_file_id = 'Movies/holiday.mkv'")
            .fetch_one(repo.pool())
            .await
            .unwrap();
    sqlx::query("UPDATE videos SET video_codec = 'mpeg2video', audio_codec = 'aac' WHERE id = ?")
        .bind(&video_id)
        .execute(repo.pool())
        .await
        .unwrap();

    // Toggle off → exactly today's behavior: direct/proxy URL, never a
    // transcode strategy (FR-2).
    let (status, body) =
        get_json(&app, &cookie, &format!("/api/videos/{video_id}/stream-url")).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_ne!(body["strategy"], "transcode", "body: {body}");

    // Flip the toggle through the API…
    let (token, cookies) = csrf_request_parts(&app, &cookie).await;
    let status = put_transcode(&app, &cookies, Some(&token), r#"{"enabled": true}"#).await;
    assert_eq!(status, StatusCode::OK);

    // …and the very next stream-url request overrides to transcode.
    let (status, body) =
        get_json(&app, &cookie, &format!("/api/videos/{video_id}/stream-url")).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["strategy"], "transcode", "body: {body}");
    let url = body["url"].as_str().expect("url present");
    assert!(
        url.ends_with(&format!("/api/videos/{video_id}/transcode/master.m3u8")),
        "unexpected transcode url: {url}"
    );
    drop(guard);
}

#[tokio::test]
async fn transcode_toggle_db_value_wins_over_env_default_on_restart() {
    use castify_api::state::AppState;
    use castify_core::Config;

    // Own db + pool (mirrors the session-restart test): PUT a value, then
    // simulate a restart by rebuilding the app over the same on-disk db
    // with the env default still saying "disabled". The persisted value
    // must win (spec AC-3).
    let named = tempfile::NamedTempFile::new().unwrap().into_temp_path();
    let path = named.to_path_buf();
    let pool = castify_storage::connect(&path).await.unwrap();
    castify_storage::run_migrations(&pool).await.unwrap();
    let secret = castify_auth::SessionSecret::resolve(&pool, None)
        .await
        .unwrap();
    let token_key = castify_catalog::TokenKey::resolve(&pool, None)
        .await
        .unwrap();
    let data_dir = std::env::temp_dir().join("castify-settings-restart-test");
    std::fs::create_dir_all(&data_dir).ok();
    let base_config = Config {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        log_level: "warn".to_string(),
        data_dir: data_dir.clone(),
        database_path: path.clone(),
        app_base_url: None,
        cookie_secure: false,
        google_oauth: None,
        dropbox_oauth: None,
        microsoft_oauth: None,
        video_cache: castify_core::VideoCacheConfig {
            enabled: false,
            max_bytes: 0,
            dir: data_dir.join("video-cache"),
        },
        probe: castify_core::ProbeConfig::default(),
        transcode: castify_core::TranscodeConfig {
            enabled: false,
            ..Default::default()
        },
        abr: castify_core::AbrConfig::default(),
    };

    // First boot: env default false. Owner flips the toggle to on.
    let state = AppState::new(
        base_config.clone(),
        pool.clone(),
        secret.clone(),
        token_key.clone(),
    )
    .await;
    let app = build_app(state);
    let cookie = setup_owner(&app).await;
    let (token, cookies) = csrf_request_parts(&app, &cookie).await;
    let status = put_transcode(&app, &cookies, Some(&token), r#"{"enabled": true}"#).await;
    assert_eq!(status, StatusCode::OK);

    // Restart: fresh pool over the same db file, env default still false.
    pool.close().await;
    let pool = castify_storage::connect(&path).await.unwrap();
    let state = AppState::new(base_config, pool, secret, token_key).await;
    let app = build_app(state);

    let (status, body) = get_json(&app, &cookie, "/api/settings/transcode").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["enabled"], true,
        "persisted settings value must win over the env-config default"
    );
    drop(named);
}

/// The container decision matrix (FR-1/FR-2): browser-compatible codecs
/// (h264/aac) in a container no browser demuxes route to transcode when
/// the toggle is on, and stay exactly on today's direct behavior when it's
/// off. Direct containers and unknown mimes are never overridden.
#[tokio::test]
async fn container_mime_matrix_routes_to_transcode_only_when_toggle_on() {
    use castify_catalog::{Credential, NewConnection, NewVideo, Provider, S3Credentials};

    let (state, guard, _path) = common::fresh_state_with(|c| c.transcode.enabled = false).await;
    let repo = state.catalog_repository().clone();
    let app = build_app(state);

    let cookie = setup_owner(&app).await;

    let conn = repo
        .create_connection(&NewConnection {
            provider: Provider::S3Compatible,
            credential: Credential::S3(S3Credentials {
                endpoint: "http://127.0.0.1:9000".into(),
                region: "us-east-1".into(),
                bucket: "media".into(),
                access_key_id: "minioadmin".into(),
                secret_access_key: "minioadmin".into(),
                prefix: None,
            }),
            provider_account_id: Some("container-matrix-test".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();

    let undemuxable = [
        "video/x-matroska",
        "video/x-msvideo",
        "video/x-ms-wmv",
        "video/x-flv",
        "video/mp2t",
    ];
    let direct = ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"];

    async fn seed_matrix_video(
        repo: &castify_catalog::CatalogRepository,
        conn_id: &str,
        mime: Option<&str>,
    ) -> String {
        let provider_file_id = format!("matrix/{}", mime.unwrap_or("no-mime").replace('/', "_"));
        repo.upsert_video(
            conn_id,
            Provider::S3Compatible,
            &NewVideo {
                provider_file_id: provider_file_id.clone(),
                name: format!("{provider_file_id}.bin"),
                path: Some(format!("/{provider_file_id}")),
                size_bytes: 1000,
                mime_type: mime.map(str::to_string),
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
        let id: String = sqlx::query_scalar("SELECT id FROM videos WHERE provider_file_id = ?")
            .bind(&provider_file_id)
            .fetch_one(repo.pool())
            .await
            .unwrap();
        // Browser-compatible codecs: only the container can trigger the
        // override (spec AC-1's seeded-MKV shape).
        sqlx::query("UPDATE videos SET video_codec = 'h264', audio_codec = 'aac' WHERE id = ?")
            .bind(&id)
            .execute(repo.pool())
            .await
            .unwrap();
        id
    }

    let mut undemuxable_ids = Vec::new();
    for mime in undemuxable {
        undemuxable_ids.push(seed_matrix_video(&repo, &conn.id, Some(mime)).await);
    }
    let mut direct_ids = Vec::new();
    for mime in direct {
        direct_ids.push(seed_matrix_video(&repo, &conn.id, Some(mime)).await);
    }
    let unknown_mime_id =
        seed_matrix_video(&repo, &conn.id, Some("application/octet-stream")).await;
    let no_mime_id = seed_matrix_video(&repo, &conn.id, None).await;

    async fn strategy(app: &axum::Router, cookie: &str, id: &str) -> String {
        let (status, body) = get_json(app, cookie, &format!("/api/videos/{id}/stream-url")).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        body["strategy"].as_str().expect("strategy").to_string()
    }

    // Toggle off → FR-2: exactly today's behavior. Every seeded video
    // resolves a presigned direct URL (S3 presign is local SigV4).
    for id in undemuxable_ids
        .iter()
        .chain(direct_ids.iter())
        .chain([&unknown_mime_id, &no_mime_id])
    {
        assert_eq!(
            strategy(&app, &cookie, id).await,
            "direct",
            "toggle off must keep direct for {id}"
        );
    }

    // Flip the toggle on through the API.
    let (token, cookies) = csrf_request_parts(&app, &cookie).await;
    let status = put_transcode(&app, &cookies, Some(&token), r#"{"enabled": true}"#).await;
    assert_eq!(status, StatusCode::OK);

    // Undemuxable containers → transcode even though codecs are compatible.
    for id in &undemuxable_ids {
        assert_eq!(
            strategy(&app, &cookie, id).await,
            "transcode",
            "container-incompatible {id} must transcode with toggle on"
        );
    }
    // Direct containers and unknown/null mimes stay direct.
    for id in direct_ids.iter().chain([&unknown_mime_id, &no_mime_id]) {
        assert_eq!(
            strategy(&app, &cookie, id).await,
            "direct",
            "direct-play container {id} must stay direct"
        );
    }
    drop(guard);
}

/// FR-1's share-flow requirement: shares delegate to the same
/// `serve_stream_url`, so a container-incompatible video inside a share
/// also overrides to transcode — recipient-side, no session needed.
#[tokio::test]
async fn share_stream_url_inherits_container_override() {
    use castify_api::shares::token::{generate_share_token, hash_share_token};
    use castify_catalog::{Credential, NewConnection, NewVideo, Provider, S3Credentials};

    let (state, guard, _path) = common::fresh_state_with(|c| c.transcode.enabled = true).await;
    let repo = state.catalog_repository().clone();
    let app = build_app(state.clone());

    // Owner row must exist for the share to reference.
    let cookie = setup_owner(&app).await;

    let conn = repo
        .create_connection(&NewConnection {
            provider: Provider::S3Compatible,
            credential: Credential::S3(S3Credentials {
                endpoint: "http://127.0.0.1:9000".into(),
                region: "us-east-1".into(),
                bucket: "media".into(),
                access_key_id: "minioadmin".into(),
                secret_access_key: "minioadmin".into(),
                prefix: None,
            }),
            provider_account_id: Some("share-container-test".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();
    repo.upsert_video(
        &conn.id,
        Provider::S3Compatible,
        &NewVideo {
            provider_file_id: "Movies/vacation.mkv".into(),
            name: "vacation.mkv".into(),
            path: Some("/Movies/vacation.mkv".into()),
            size_bytes: 129_201,
            mime_type: Some("video/x-matroska".into()),
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
    let video_id: String =
        sqlx::query_scalar("SELECT id FROM videos WHERE provider_file_id = 'Movies/vacation.mkv'")
            .fetch_one(repo.pool())
            .await
            .unwrap();
    sqlx::query("UPDATE videos SET video_codec = 'h264', audio_codec = 'aac' WHERE id = ?")
        .bind(&video_id)
        .execute(repo.pool())
        .await
        .unwrap();

    let owner: String = sqlx::query_scalar("SELECT id FROM owners LIMIT 1")
        .fetch_one(state.pool())
        .await
        .unwrap();
    let token = generate_share_token();
    castify_api::shares::ShareRepository::new(state.pool().clone())
        .create_share(&castify_api::shares::NewShare {
            owner_id: &uuid::Uuid::parse_str(&owner).unwrap(),
            token_hash: &hash_share_token(&token),
            password_hash: None,
            title: "Trip footage",
            expires_at: None,
            video_ids: std::slice::from_ref(&video_id),
        })
        .await
        .unwrap();

    // Recipient request: no session cookie, share token only.
    let (status, body) = get_json(
        &app,
        &cookie,
        &format!("/api/share/{token}/videos/{video_id}/stream-url"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["strategy"], "transcode", "body: {body}");
    let url = body["url"].as_str().expect("url present");
    assert!(
        url.ends_with(&format!(
            "/api/share/{token}/videos/{video_id}/transcode/master.m3u8"
        )),
        "share transcode URL must be share-scoped: {url}"
    );
    drop(guard);
}
