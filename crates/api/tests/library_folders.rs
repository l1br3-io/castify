//! Library-folders REST — integration tests (task 003).
//!
//! Drives the full middleware stack (`build_app`) exactly like the
//! browser would: session cookie for auth, double-submit CSRF for
//! mutations. The denial matrix (401 without session, 403 without CSRF)
//! and the 4xx validation ladder only exist at the HTTP boundary, so
//! they live here; deep folder semantics live in the repository tests.

mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use castify_api::state::AppState;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tower::ServiceExt;

const OWNER_PASSWORD: &str = "correct horse battery staple";

/// Boot a fresh app, run first-run setup, and return `(app, state, session
/// cookie, db guard)` — same shape as the shares test harness.
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

/// Minimal catalog seed: one active connection + `names.len()` videos.
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

/// Non-video catalog seed, same connection.
async fn seed_files(pool: &SqlitePool, names: &[&str]) -> Vec<String> {
    let mut ids = Vec::with_capacity(names.len());
    for name in names {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO files (id, connection_id, provider_file_id, name, kind) \
             VALUES (?, 'c1', ?, ?, 'image')",
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

/// One-shot request helper (session + double-submit CSRF, like the SPA).
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

/// Mutation helper with CSRF done right.
async fn mutate(
    app: &axum::Router,
    session: &str,
    method: &str,
    uri: &str,
    body: Value,
) -> (StatusCode, Value) {
    let csrf = fetch_csrf(app, session).await;
    request(
        app.clone(),
        method,
        uri,
        Some(session),
        Some((&csrf, &csrf)),
        Some(body),
    )
    .await
}

async fn create_folder(app: &axum::Router, session: &str, body: Value) -> (StatusCode, Value) {
    mutate(app, session, "POST", "/api/library-folders", body).await
}

async fn placement_of(pool: &SqlitePool, table: &str, id: &str) -> Option<String> {
    sqlx::query_scalar(&format!(
        "SELECT library_folder_id FROM {table} WHERE id = ?"
    ))
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

// ------------------------------------------------------------ 401 / 403

#[tokio::test]
async fn every_endpoint_without_session_is_unauthorized() {
    let (app, _state, _session, _guard) = boot().await;
    for (method, uri) in [
        ("GET", "/api/library-folders/tree"),
        ("GET", "/api/library-folders/contents"),
        ("POST", "/api/library-folders"),
        ("PATCH", "/api/library-folders/x"),
        ("DELETE", "/api/library-folders/x"),
        ("PATCH", "/api/library-folders/items"),
        ("PATCH", "/api/library-folders/items/order"),
        ("PATCH", "/api/library-folders/folders/order"),
    ] {
        let (status, _) = request(app.clone(), method, uri, None, None, Some(json!({}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
}

#[tokio::test]
async fn mutations_without_csrf_are_forbidden() {
    let (app, _state, session, _guard) = boot().await;
    for (method, uri) in [
        ("POST", "/api/library-folders"),
        ("PATCH", "/api/library-folders/x"),
        ("DELETE", "/api/library-folders/x"),
        ("PATCH", "/api/library-folders/items"),
        ("PATCH", "/api/library-folders/items/order"),
        ("PATCH", "/api/library-folders/folders/order"),
    ] {
        let (status, _) = request(
            app.clone(),
            method,
            uri,
            Some(&session),
            None,
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
    }
}

// ------------------------------------------------- CRUD + tree + contents

#[tokio::test]
async fn folder_crud_tree_and_contents_round_trip_over_http() {
    let (app, state, session, _guard) = boot().await;
    let pool = state.pool();
    let videos = seed_videos(pool, &["a-v.mp4", "b-v.mp4", "loose.mp4"]).await;
    let files = seed_files(pool, &["photo.jpg"]).await;

    // Empty tree first run: no folders, unfiled counts everything.
    let (status, tree) = request(
        app.clone(),
        "GET",
        "/api/library-folders/tree",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tree["folders"].as_array().unwrap().len(), 0);
    assert_eq!(tree["unfiled_count"], 4);

    // Create root + nested.
    let (status, trip) = create_folder(&app, &session, json!({"name": "  Trip  "})).await;
    assert_eq!(status, StatusCode::CREATED, "{trip}");
    assert_eq!(trip["name"], "Trip", "names arrive trimmed");
    let trip_id = trip["id"].as_str().unwrap().to_string();

    let (status, day1) = create_folder(
        &app,
        &session,
        json!({"name": "Day 1", "parent_id": trip_id}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let day1_id = day1["id"].as_str().unwrap().to_string();

    // Tree carries cumulative counts.
    let (_, tree) = request(
        app.clone(),
        "GET",
        "/api/library-folders/tree",
        Some(&session),
        None,
        None,
    )
    .await;
    let folders = tree["folders"].as_array().unwrap();
    assert_eq!(folders.len(), 2);
    let trip_node = folders.iter().find(|f| f["id"] == *trip_id).unwrap();
    let day1_node = folders.iter().find(|f| f["id"] == *day1_id).unwrap();
    assert_eq!(trip_node["parent_id"], Value::Null);
    assert_eq!(day1_node["parent_id"], trip_id);

    // Batch-file mixed items into Day 1 over HTTP.
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items",
        json!({
            "items": [
                {"kind": "video", "id": videos[0]},
                {"kind": "video", "id": videos[1]},
                {"kind": "file", "id": files[0]}
            ],
            "folder_id": day1_id
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Counts: Day 1 = 3 direct; Trip = 3 cumulative; unfiled = 1.
    let (_, tree) = request(
        app.clone(),
        "GET",
        "/api/library-folders/tree",
        Some(&session),
        None,
        None,
    )
    .await;
    let folders = tree["folders"].as_array().unwrap();
    let count = |id: &str| {
        folders.iter().find(|f| f["id"] == id).unwrap()["item_count"]
            .as_i64()
            .unwrap()
    };
    assert_eq!(count(&day1_id), 3);
    assert_eq!(count(&trip_id), 3, "cumulative over the subtree");
    assert_eq!(tree["unfiled_count"], 1);

    // Contents: mixed listing, provider wire shape.
    let (_, contents) = request(
        app.clone(),
        "GET",
        &format!("/api/library-folders/contents?folder_id={day1_id}"),
        Some(&session),
        None,
        None,
    )
    .await;
    let entries = contents["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["kind"], "video", "name-ascending: a-v.mp4");
    assert_eq!(entries[1]["kind"], "video", "b-v.mp4");
    assert_eq!(entries[2]["kind"], "image", "photo.jpg");
    assert_eq!(contents["total"], 3);
    assert_eq!(contents["page"], 1);
    assert_eq!(contents["limit"], 50);

    // Unfiled contents (folder_id absent).
    let (_, unfiled) = request(
        app.clone(),
        "GET",
        "/api/library-folders/contents",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(unfiled["total"], 1);
    assert_eq!(unfiled["entries"][0]["name"], "loose.mp4");

    // kind + q filters on the curated contents.
    let (_, imgs) = request(
        app.clone(),
        "GET",
        &format!("/api/library-folders/contents?folder_id={day1_id}&kind=image"),
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(imgs["total"], 1);
    assert_eq!(imgs["entries"][0]["name"], "photo.jpg");
    let (_, q) = request(
        app.clone(),
        "GET",
        &format!("/api/library-folders/contents?folder_id={day1_id}&q=b-v"),
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(q["total"], 1);
    assert_eq!(q["entries"][0]["name"], "b-v.mp4");

    // Rename + reparent in one PATCH.
    let (status, renamed) = mutate(
        &app,
        &session,
        "PATCH",
        &format!("/api/library-folders/{day1_id}"),
        json!({"name": "Day One"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["name"], "Day One");

    // Delete the folder: items return to Unfiled, subfolders flatten.
    let (status, _) = mutate(
        &app,
        &session,
        "DELETE",
        &format!("/api/library-folders/{trip_id}"),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, tree) = request(
        app.clone(),
        "GET",
        "/api/library-folders/tree",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(
        tree["folders"].as_array().unwrap().len(),
        1,
        "Day One flattened to root"
    );
    assert_eq!(tree["unfiled_count"], 4, "everything unfiled again");
    for id in &videos {
        assert_eq!(
            placement_of(pool, "videos", id).await,
            None,
            "video survives folder deletion, unfiled"
        );
    }
    for id in &files {
        assert_eq!(
            placement_of(pool, "files", id).await,
            None,
            "file survives folder deletion, unfiled"
        );
    }
}

// ------------------------------------------------------ validation ladder

#[tokio::test]
async fn the_validation_matrix_maps_to_distinct_4xx() {
    let (app, _state, session, _guard) = boot().await;

    // Empty / whitespace / overlong name → 400.
    for bad in ["", "   ", &"x".repeat(201)] {
        let (status, _) = create_folder(&app, &session, json!({"name": bad})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "name {bad:?}");
    }
    // Exactly 200 chars is fine.
    let (status, _) = create_folder(&app, &session, json!({"name": "x".repeat(200)})).await;
    assert_eq!(status, StatusCode::CREATED);

    // Duplicate sibling name → 409.
    let (status, _) = create_folder(&app, &session, json!({"name": "x".repeat(200)})).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Unknown parent → 404.
    let (status, _) =
        create_folder(&app, &session, json!({"name": "y", "parent_id": "nope"})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Unknown folder on PATCH/DELETE → 404.
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/nope",
        json!({"name": "z"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = mutate(
        &app,
        &session,
        "DELETE",
        "/api/library-folders/nope",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Unknown folder on contents → 404.
    let (status, _) = request(
        app.clone(),
        "GET",
        "/api/library-folders/contents?folder_id=nope",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Depth: a chain of 8 is legal, the 9th → 400.
    let mut parent = String::new();
    for depth in 1..=8 {
        let body = if depth == 1 {
            json!({"name": format!("d{depth}")})
        } else {
            json!({"name": format!("d{depth}"), "parent_id": parent})
        };
        let (status, folder) = create_folder(&app, &session, body).await;
        assert_eq!(status, StatusCode::CREATED, "depth {depth} must be legal");
        parent = folder["id"].as_str().unwrap().to_string();
    }
    let (status, _) =
        create_folder(&app, &session, json!({"name": "d9", "parent_id": parent})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "depth 9 rejected");

    // Cycle: d1 under d2 → 409.
    let (_, tree) = request(
        app.clone(),
        "GET",
        "/api/library-folders/tree",
        Some(&session),
        None,
        None,
    )
    .await;
    let id_of = |name: &str| {
        tree["folders"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let d1 = id_of("d1");
    let d2 = id_of("d2");
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        &format!("/api/library-folders/{d1}"),
        json!({"parent_id": d2}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "cycle rejected");
}

// ------------------------------------------------------------- batch move

#[tokio::test]
async fn batch_move_with_one_bad_id_fails_whole_over_http() {
    let (app, state, session, _guard) = boot().await;
    let pool = state.pool();
    let videos = seed_videos(pool, &["v1.mp4", "v2.mp4"]).await;
    let (status, folder) = create_folder(&app, &session, json!({"name": "Trip"})).await;
    assert_eq!(status, StatusCode::CREATED);
    let fid = folder["id"].as_str().unwrap().to_string();

    // One unknown id inside the batch → 404, nothing moved.
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items",
        json!({
            "items": [
                {"kind": "video", "id": videos[0]},
                {"kind": "video", "id": "not-a-video"}
            ],
            "folder_id": fid
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(placement_of(pool, "videos", &videos[0]).await, None);
    assert_eq!(placement_of(pool, "videos", &videos[1]).await, None);

    // Unknown kind → 400, nothing moved.
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items",
        json!({"items": [{"kind": "playlist", "id": videos[0]}], "folder_id": fid}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(placement_of(pool, "videos", &videos[0]).await, None);

    // Unknown target folder → 404, nothing moved.
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items",
        json!({"items": [{"kind": "video", "id": videos[0]}], "folder_id": "nope"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(placement_of(pool, "videos", &videos[0]).await, None);

    // Empty batch → 400.
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items",
        json!({"items": [], "folder_id": fid}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // folder_id absent/null → Unfiled (the degenerate move-back).
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items",
        json!({"items": [{"kind": "video", "id": videos[0]}], "folder_id": fid}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items",
        json!({"items": [{"kind": "video", "id": videos[0]}], "folder_id": null}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(placement_of(pool, "videos", &videos[0]).await, None);
}

// ------------------------------------------------ reorder routes (task 006)

/// GET one folder's contents names, in served order.
async fn contents_order(app: &axum::Router, session: &str, folder_id: &str) -> Vec<String> {
    let (status, body) = request(
        app.clone(),
        "GET",
        &format!("/api/library-folders/contents?folder_id={folder_id}&limit=100"),
        Some(session),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    body["entries"]
        .as_array()
        .expect("entries array")
        .iter()
        .map(|e| e["name"].as_str().expect("name").to_string())
        .collect()
}

#[tokio::test]
async fn item_reorder_round_trip_and_validation_matrix() {
    let (app, state, session, _guard) = boot().await;
    let pool = state.pool();
    let videos = seed_videos(pool, &["B.mp4", "A.mp4", "C.mp4"]).await;
    let (_, folder) = create_folder(&app, &session, json!({"name": "F"})).await;
    let folder_id = folder["id"].as_str().unwrap().to_string();

    // Place all three via the shipped batch-move endpoint.
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items",
        json!({
            "items": videos.iter().map(|id| json!({"kind": "video", "id": id})).collect::<Vec<_>>(),
            "folder_id": folder_id,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        contents_order(&app, &session, &folder_id).await,
        vec!["A.mp4", "B.mp4", "C.mp4"],
        "unordered folders keep the name-ascending default"
    );

    // Happy path: a full-list reorder lands 204 and contents follow it.
    let (status, body) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items/order",
        json!({
            "folder_id": folder_id,
            "items": [
                {"kind": "video", "id": videos[2]},
                {"kind": "video", "id": videos[1]},
                {"kind": "video", "id": videos[0]},
            ],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "body: {body}");
    assert_eq!(
        contents_order(&app, &session, &folder_id).await,
        vec!["C.mp4", "A.mp4", "B.mp4"],
        "the reorder rewrote the served order"
    );

    // Validation matrix.
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items/order",
        json!({
            "folder_id": folder_id,
            "items": [{"kind": "video", "id": videos[0]}],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "missing ids abort whole");

    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items/order",
        json!({
            "folder_id": folder_id,
            "items": [{"kind": "video", "id": "not-an-id"}],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "foreign id aborts whole");

    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items/order",
        json!({"folder_id": folder_id, "items": []}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "empty list aborts whole");

    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items/order",
        json!({
            "folder_id": "missing-folder",
            "items": [{"kind": "video", "id": videos[0]}],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "unknown folder is a 404");

    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/items/order",
        json!({
            "folder_id": folder_id,
            "items": [{"kind": "clip", "id": videos[0]}],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "unknown kind is a 400");

    // Nothing above moved anything.
    assert_eq!(
        contents_order(&app, &session, &folder_id).await,
        vec!["C.mp4", "A.mp4", "B.mp4"],
        "failed reorders leave the order untouched"
    );
}

#[tokio::test]
async fn folder_reorder_round_trip_and_validation_matrix() {
    let (app, _state, session, _guard) = boot().await;

    let (_, a) = create_folder(&app, &session, json!({"name": "A"})).await;
    let (_, b) = create_folder(&app, &session, json!({"name": "B"})).await;
    let (_, c) = create_folder(&app, &session, json!({"name": "C"})).await;
    let (a, b, c) = (
        a["id"].as_str().unwrap(),
        b["id"].as_str().unwrap(),
        c["id"].as_str().unwrap(),
    );

    // Root reorder: null parent, dense rewrite, tree reflects it.
    let (status, body) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/folders/order",
        json!({"parent_id": null, "folder_ids": [c, a, b]}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "body: {body}");
    let (_, tree) = request(
        app.clone(),
        "GET",
        "/api/library-folders/tree",
        Some(&session),
        None,
        None,
    )
    .await;
    let names: Vec<&str> = tree["folders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["C", "A", "B"]);

    // Matrix.
    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/folders/order",
        json!({"parent_id": null, "folder_ids": [a, b]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "missing id aborts whole");

    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/folders/order",
        json!({"parent_id": null, "folder_ids": []}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "empty list aborts whole");

    let (status, _) = mutate(
        &app,
        &session,
        "PATCH",
        "/api/library-folders/folders/order",
        json!({"parent_id": "missing", "folder_ids": [a]}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "unknown parent is a 404");

    let (_, tree) = request(
        app.clone(),
        "GET",
        "/api/library-folders/tree",
        Some(&session),
        None,
        None,
    )
    .await;
    let names: Vec<&str> = tree["folders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["C", "A", "B"], "failed reorders leave the tree");
}
