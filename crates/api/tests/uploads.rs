//! `POST /api/uploads` — integration tests (drag-and-drop task 011).
//!
//! Drives the full middleware stack exactly like the browser would
//! (session cookie, double-submit CSRF, Content-Length'd body). The
//! happy path runs the REAL S3 provider against a local wiremock S3
//! endpoint: the connection is created through the public credentials
//! form (verify included), then the upload streams through route →
//! provider → SDK to the mock.

mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use castify_api::state::AppState;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const OWNER_PASSWORD: &str = "correct horse battery staple";

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

/// One-shot upload request: session + CSRF + Content-Length'd raw body.
async fn upload_request(
    app: axum::Router,
    session: &str,
    uri: &str,
    length: Option<usize>,
    body: Vec<u8>,
) -> (StatusCode, Value) {
    let csrf = fetch_csrf(&app, session).await;
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header("cookie", format!("{session}; castify_csrf={csrf}"))
        .header("x-csrf-token", &csrf)
        .header("content-type", "application/octet-stream");
    if let Some(len) = length {
        builder = builder.header("content-length", len.to_string());
    }
    let response = app
        .oneshot(builder.body(Body::from(Bytes::from(body))).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

/// The wiremock S3 endpoint: verify (HeadBucket + one list page), the
/// upload PUT, and the post-upload scan listing.
async fn s3_mocks(server: &MockServer) {
    // One mock serves HeadBucket (200) and ListObjectsV2 (the empty XML
    // page). Regex because the SDK addresses the bucket with a trailing
    // slash on some calls ("/media/") and wiremock's path matcher is
    // exact.
    Mock::given(wiremock::matchers::path_regex(r"^/media/?$"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"<?xml version="1.0" encoding="UTF-8"?>
               <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
                 <IsTruncated>false</IsTruncated>
                 <Contents></Contents>
               </ListBucketResult>"#,
        ))
        .mount(server)
        .await;
}

/// Connect an S3 connection whose endpoint is the wiremock server;
/// returns the connection id.
async fn connect_s3(app: &axum::Router, session: &str, server: &MockServer) -> String {
    let csrf = fetch_csrf(app, session).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/connections/s3")
                .header("cookie", format!("{session}; castify_csrf={csrf}"))
                .header("x-csrf-token", &csrf)
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    json!({
                        "endpoint": server.uri(),
                        "region": "us-east-1",
                        "bucket": "media",
                        "access_key_id": "minioadmin",
                        "secret_access_key": "minioadmin",
                    })
                    .to_string(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    if status != StatusCode::CREATED {
        println!("CONNECT FAILED: {}", String::from_utf8_lossy(&bytes));
        for r in server.received_requests().await.unwrap() {
            println!("RECEIVED {} {}{:?}", r.method, r.url.path(), r.url.query());
        }
    }
    assert_eq!(status, StatusCode::CREATED);
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    body["id"].as_str().expect("connection id").to_string()
}

/// Poll the connection's scan status until it leaves "scanning" — the
/// upload's kick must not be swallowed by the connect-time initial
/// scan still holding the slot.
async fn wait_for_scan_idle(app: &axum::Router, session: &str, connection_id: &str) {
    for _ in 0..100 {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/connections/{connection_id}/scan"))
                    .header("cookie", session)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        if body["status"] != json!("scanning") {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("initial scan never settled");
}

/// Decode the SDK's aws-chunked stream signing (the S3 upload test
/// twin) — the wire body's payload framing.
fn decode_aws_chunked(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let Some(line_end) = rest.windows(2).position(|w| w == b"\r\n") else {
            return body.to_vec();
        };
        let size_str = rest[..line_end]
            .split(|b| *b == b';')
            .next()
            .unwrap_or(b"0");
        let Ok(size) = std::str::from_utf8(size_str)
            .map_err(|_| ())
            .and_then(|s| usize::from_str_radix(s.trim(), 16).map_err(|_| ()))
        else {
            return body.to_vec();
        };
        rest = &rest[line_end + 2..];
        if size == 0 {
            return out;
        }
        if rest.len() < size {
            return body.to_vec();
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[(size + 2).min(rest.len())..];
    }
}

// ------------------------------------------------------------ 401 / 403

#[tokio::test]
async fn upload_without_session_is_unauthorized() {
    let (app, _state, _session, _guard) = boot().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/uploads?connection_id=x&filename=a.mp4")
                .header("content-length", "1")
                .body(Body::from(Bytes::from_static(b"x")))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn upload_without_csrf_is_forbidden() {
    let (app, _state, session, _guard) = boot().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/uploads?connection_id=x&filename=a.mp4")
                .header("cookie", &session)
                .header("content-length", "1")
                .body(Body::from(Bytes::from_static(b"x")))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

// ------------------------------------------------------------ the ladder

#[tokio::test]
async fn upload_without_content_length_is_411() {
    let (app, _state, session, _guard) = boot().await;
    let (status, _) = upload_request(
        app,
        &session,
        "/api/uploads?connection_id=missing&filename=a.mp4",
        None,
        b"xx".to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::LENGTH_REQUIRED);
}

#[tokio::test]
async fn upload_with_a_path_separator_filename_is_400() {
    let (app, _state, session, _guard) = boot().await;
    for filename in ["a/b.mp4", "..", "a\\b.mp4"] {
        let (status, _) = upload_request(
            app.clone(),
            &session,
            &format!("/api/uploads?connection_id=x&filename={filename}"),
            Some(1),
            b"x".to_vec(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "filename {filename}");
    }
}

#[tokio::test]
async fn upload_for_an_unknown_connection_is_404() {
    let (app, _state, session, _guard) = boot().await;
    let (status, _) = upload_request(
        app,
        &session,
        "/api/uploads?connection_id=missing&filename=a.mp4",
        Some(1),
        b"x".to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ------------------------------------------------------------ happy path

#[tokio::test]
async fn upload_streams_to_the_provider_and_kicks_the_scan() {
    let (app, _state, session, _guard) = boot().await;
    let server = MockServer::start().await;
    s3_mocks(&server).await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"deadbeef\""))
        .mount(&server)
        .await;
    let connection_id = connect_s3(&app, &session, &server).await;
    wait_for_scan_idle(&app, &session, &connection_id).await;
    // Snapshot BEFORE the upload: the kick's listing must land as a NEW
    // GET after the 201 (run_scan races the response, so counting after
    // would miss it).
    let list_calls_before = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.method == "GET" && r.url.path().starts_with("/media"))
        .count();

    // A body larger than one client chunk so a buffering regression
    // still passes — the byte-equality check is the contract.
    let data: Vec<u8> = (0..300 * 1024).map(|i| (i % 251) as u8).collect();
    let (status, body) = upload_request(
        app.clone(),
        &session,
        &format!("/api/uploads?connection_id={connection_id}&dir=/Movies/Sci-fi&filename=clip.mp4"),
        Some(data.len()),
        data.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    assert_eq!(body["file_id"], json!("Movies/Sci-fi/clip.mp4"));

    // The PUT landed at the object key with the exact payload.
    let requests = server.received_requests().await.unwrap();
    let put = requests
        .iter()
        .find(|r| r.method == "PUT")
        .expect("the upload PUT");
    assert_eq!(put.url.path(), "/media/Movies/Sci-fi/clip.mp4");
    assert_eq!(decode_aws_chunked(&put.body), data);

    // The scan kick: the connection's listing ran again after the
    // upload — at least one more GET than the pre-upload snapshot.
    let mut scan_list_calls = 0;
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let current = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.method == "GET" && r.url.path().starts_with("/media"))
            .count();
        if current > list_calls_before {
            scan_list_calls = current - list_calls_before;
            break;
        }
    }
    assert!(
        scan_list_calls >= 1,
        "the scan kick must list the connection again after a successful upload"
    );
}

#[tokio::test]
async fn upload_surfaces_a_provider_failure_without_scan_kick() {
    let (app, _state, session, _guard) = boot().await;
    let server = MockServer::start().await;
    s3_mocks(&server).await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;
    let connection_id = connect_s3(&app, &session, &server).await;

    let data = b"tiny".to_vec();
    let (status, _) = upload_request(
        app,
        &session,
        &format!("/api/uploads?connection_id={connection_id}&filename=a.mp4"),
        Some(data.len()),
        data,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_GATEWAY,
        "provider failures ride the ApiError::Provider mapping"
    );
}
