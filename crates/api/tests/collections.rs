// Library-collections suggestion API tests (spec F2): list / accept /
// dismiss. Seeds staging via the repository (what the post-scan hook
// writes) and verifies wire shapes + side effects. Same conventions as
// folders.rs / shares.rs.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use castify_catalog::{
    CatalogRepository, CollectionKind, Credential, NewCollectionSuggestion, NewConnection,
    NewVideo, Provider, TokenBundle,
};

mod common;

fn sample_credential() -> Credential {
    Credential::OAuth(TokenBundle {
        access_token: "ya29.test".into(),
        refresh_token: Some("refresh".into()),
        expires_at: None,
        token_type: "Bearer".into(),
        scope: None,
    })
}

async fn boot_and_setup() -> (axum::Router, String, CatalogRepository, tempfile::TempPath) {
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
                .body(Body::from(
                    r#"{"display_name":"Jane","password":"correct horse battery staple"}"#
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .expect("session cookie")
        .to_string();
    (app, cookie, repo, guard)
}

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

async fn request(
    app: axum::Router,
    method: &str,
    uri: &str,
    session: Option<&str>,
    csrf: Option<(&str, &str)>,
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
    let response = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

async fn seed_connection(repo: &CatalogRepository) -> String {
    let conn = repo
        .create_connection(&NewConnection {
            provider: Provider::GoogleDrive,
            credential: sample_credential(),
            provider_account_id: Some("acct".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();
    conn.id
}

async fn seed_video(repo: &CatalogRepository, conn: &str, key: &str, name: &str) -> String {
    repo.upsert_video(
        conn,
        Provider::GoogleDrive,
        &NewVideo {
            provider_file_id: key.into(),
            name: name.into(),
            path: None,
            size_bytes: 1000,
            mime_type: Some("video/mp4".into()),
            duration_ms: None,
            width: None,
            height: None,
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        },
    )
    .await
    .unwrap();
    sqlx::query_scalar("SELECT id FROM videos WHERE provider_file_id = ?")
        .bind(key)
        .fetch_one(repo.pool())
        .await
        .unwrap()
}

fn suggestion(kind: CollectionKind, title: &str, signature: &str, ids: Vec<String>) -> NewCollectionSuggestion {
    NewCollectionSuggestion {
        kind,
        title: title.into(),
        signature: signature.into(),
        video_ids: ids,
    }
}

// ── GET /api/collections/suggestions ─────────────────────────────────

#[tokio::test]
async fn suggestions_requires_auth() {
    let (app, _cookie, _repo, _guard) = boot_and_setup().await;
    let (status, _) = request(app, "GET", "/api/collections/suggestions", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn suggestions_list_orders_by_member_count_with_preview() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo).await;

    let bb1 = seed_video(&repo, &conn, "bb-1", "breaking.bad.s01e01.mkv").await;
    let bb2 = seed_video(&repo, &conn, "bb-2", "Breaking.Bad.S01E02.mkv").await;
    let mx = seed_video(&repo, &conn, "mx-1", "The.Matrix.(1999).mkv").await;
    let c1 = seed_video(&repo, &conn, "c-1", "clip1.mp4").await;
    let c2 = seed_video(&repo, &conn, "c-2", "clip2.mp4").await;

    repo.replace_collection_suggestions(
        &conn,
        &[
            suggestion(CollectionKind::Movie, "The Matrix (1999)", "movie:thematrix1999", vec![mx]),
            suggestion(CollectionKind::Show, "Breaking Bad", "show:breakingbad", vec![bb1.clone(), bb2.clone()]),
            suggestion(CollectionKind::Time, "June 2026", "time:2026-06", vec![c1, c2]),
        ],
    )
    .await
    .unwrap();

    let (status, body) = request(
        app.clone(),
        "GET",
        "/api/collections/suggestions",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let groups = body.as_array().expect("array of groups");
    assert_eq!(groups.len(), 3);
    // Ties (2,2) broken deterministically by signature asc.
    assert_eq!(groups[0]["kind"], "show");
    assert_eq!(groups[0]["title"], "Breaking Bad");
    assert_eq!(groups[0]["member_count"], 2);
    assert_eq!(groups[0]["signature"], "show:breakingbad");
    assert_eq!(groups[1]["kind"], "time");
    assert_eq!(groups[2]["kind"], "movie");

    // Member preview carries full VideoSummary entries.
    let members = groups[0]["members"].as_array().expect("members");
    assert_eq!(members.len(), 2);
    assert_eq!(members[0]["name"], "breaking.bad.s01e01.mkv");
    assert_eq!(members[0]["thumbnail_status"], "pending");

    // limit param truncates.
    let (status, limited) = request(
        app,
        "GET",
        "/api/collections/suggestions?limit=2",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(limited.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn suggestions_default_limit_is_twenty() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo).await;

    let mut staged = Vec::new();
    for i in 0..25 {
        let vid = seed_video(&repo, &conn, &format!("v{i}"), &format!("clip {i}.mp4")).await;
        staged.push(suggestion(
            CollectionKind::Time,
            &format!("Group {i}"),
            &format!("time:2026-{i:02}"),
            vec![vid],
        ));
    }
    repo.replace_collection_suggestions(&conn, &staged)
        .await
        .unwrap();

    let (status, body) = request(
        app.clone(),
        "GET",
        "/api/collections/suggestions",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 20, "default cap is 20");

    let (status, more) = request(
        app,
        "GET",
        "/api/collections/suggestions?limit=25",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(more.as_array().unwrap().len(), 25, "explicit limit widens");
}

// ── POST /api/collections/suggestions/{id}/accept ────────────────────

#[tokio::test]
async fn accept_creates_collection_and_consumes_group() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo).await;

    let bb1 = seed_video(&repo, &conn, "bb-1", "breaking.bad.s01e01.mkv").await;
    let bb2 = seed_video(&repo, &conn, "bb-2", "Breaking.Bad.S01E02.mkv").await;
    repo.replace_collection_suggestions(
        &conn,
        &[suggestion(
            CollectionKind::Show,
            "Breaking Bad",
            "show:breakingbad",
            vec![bb1, bb2],
        )],
    )
    .await
    .unwrap();
    let staged = repo.fetch_collection_suggestions(&conn).await.unwrap();
    assert_eq!(staged.len(), 1);
    let sug_id = staged[0].id.clone();

    let csrf = fetch_csrf(&app, &cookie).await;
    let (status, body) = request(
        app.clone(),
        "POST",
        &format!("/api/collections/suggestions/{sug_id}/accept"),
        Some(&cookie),
        Some((&csrf, &csrf)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["name"], "Breaking Bad");
    assert_eq!(body["kind"], "show");
    assert_eq!(body["member_count"], 2);

    // Collection + items exist with staged positions.
    let item_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT video_id, position FROM collection_items ci \
         JOIN collections c ON c.id = ci.collection_id WHERE c.name = 'Breaking Bad' \
         ORDER BY position",
    )
    .fetch_all(repo.pool())
    .await
    .unwrap();
    assert_eq!(item_rows.len(), 2);

    // Staging consumed.
    assert!(
        repo.fetch_collection_suggestions(&conn)
            .await
            .unwrap()
            .is_empty()
    );

    // Second accept → 404, no partial writes.
    let (status, _) = request(
        app,
        "POST",
        &format!("/api/collections/suggestions/{sug_id}/accept"),
        Some(&cookie),
        Some((&csrf, &csrf)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let collections: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM collections WHERE name = 'Breaking Bad'")
            .fetch_one(repo.pool())
            .await
            .unwrap();
    assert_eq!(collections, 1, "no duplicate collection on re-accept");
}

// ── POST /api/collections/suggestions/{id}/dismiss ───────────────────

#[tokio::test]
async fn dismiss_persists_signature_and_never_restages() {
    let (app, cookie, repo, _guard) = boot_and_setup().await;
    let conn = seed_connection(&repo).await;

    let mx = seed_video(&repo, &conn, "mx-1", "The.Matrix.(1999).mkv").await;
    repo.replace_collection_suggestions(
        &conn,
        &[suggestion(
            CollectionKind::Movie,
            "The Matrix (1999)",
            "movie:thematrix1999",
            vec![mx],
        )],
    )
    .await
    .unwrap();
    let staged = repo.fetch_collection_suggestions(&conn).await.unwrap();
    let sug_id = staged[0].id.clone();

    let csrf = fetch_csrf(&app, &cookie).await;
    let (status, _) = request(
        app.clone(),
        "POST",
        &format!("/api/collections/suggestions/{sug_id}/dismiss"),
        Some(&cookie),
        Some((&csrf, &csrf)),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Staging consumed + dismissal persisted.
    assert!(repo.fetch_collection_suggestions(&conn).await.unwrap().is_empty());
    let dismissed = repo.fetch_dismissed_signatures(&conn).await.unwrap();
    assert!(dismissed.contains("movie:thematrix1999"));

    // A rescan (simulated: staging rewrite with same signature) must not
    // resurrect the dismissed group — task 003's filter.
    repo.replace_collection_suggestions(
        &conn,
        &[suggestion(
            CollectionKind::Movie,
            "The Matrix (1999)",
            "movie:thematrix1999",
            vec!["whatever".to_string()],
        )],
    )
    .await
    .unwrap();
    assert!(
        repo.fetch_collection_suggestions(&conn)
            .await
            .unwrap()
            .is_empty(),
        "dismissed signature must never restage"
    );

    // Second dismiss → 404.
    let (status, _) = request(
        app,
        "POST",
        &format!("/api/collections/suggestions/{sug_id}/dismiss"),
        Some(&cookie),
        Some((&csrf, &csrf)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn accept_and_dismiss_unknown_ids_are_404() {
    let (app, cookie, _repo, _guard) = boot_and_setup().await;
    let csrf = fetch_csrf(&app, &cookie).await;

    let (status, _) = request(
        app.clone(),
        "POST",
        "/api/collections/suggestions/nope/accept",
        Some(&cookie),
        Some((&csrf, &csrf)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = request(
        app,
        "POST",
        "/api/collections/suggestions/nope/dismiss",
        Some(&cookie),
        Some((&csrf, &csrf)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
