mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

async fn post(uri: &str, body: &str) -> (StatusCode, Value, Option<String>) {
    let app = common::fresh_app().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(body.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value, cookie)
}

#[tokio::test]
async fn webauthn_begin_returns_creation_challenge() {
    let (status, body, _) = post(
        "/api/setup/webauthn/register/begin",
        r#"{"display_name":"Jane"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body = {body}");

    // The challenge lives under publicKey.challenge and is a base64url string.
    // (CreationChallengeResponse uses #[serde(rename_all = "camelCase)].)
    let challenge = body["publicKey"]["challenge"]
        .as_str()
        .expect("publicKey.challenge must be a string");
    assert!(!challenge.is_empty(), "challenge must not be empty");

    // We return a fresh owner id (uuid) the client must echo back on finish.
    let owner_id = body["owner_id"].as_str().expect("owner_id must be present");
    assert!(
        uuid::Uuid::parse_str(owner_id).is_ok(),
        "owner_id not a uuid"
    );

    // rp.id should match the configured public_url host.
    let rp_id = body["publicKey"]["rp"]["id"]
        .as_str()
        .expect("rp.id must be present");
    assert_eq!(rp_id, "localhost");
}

#[tokio::test]
async fn webauthn_begin_rejects_when_owner_exists() {
    // Run setup first to create the owner, then start a new app on a fresh db
    // to make the test self-contained.
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state.clone());

    // Create the owner via the password path.
    let r = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    r#"{"display_name":"Jane","password":"correct horse"}"#,
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);

    let r = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup/webauthn/register/begin")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(r#"{"display_name":"Jane"}"#)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn webauthn_finish_rejects_garbage_with_400() {
    // Begin to get a valid owner_id, then post garbage as the credential.
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);

    let begin = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup/webauthn/register/begin")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(r#"{"display_name":"Jane"}"#)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(begin.status(), StatusCode::OK);
    let begin_bytes = begin.into_body().collect().await.unwrap().to_bytes();
    let begin_value: Value = serde_json::from_slice(&begin_bytes).unwrap();
    let owner_id = begin_value["owner_id"].as_str().unwrap().to_string();

    // Garbage credential: valid JSON shape, nonsense contents.
    let garbage = json!({
        "owner_id": owner_id,
        "credential": {
            "id": "AAAA",
            "rawId": "AAAA",
            "response": {
                "attestationObject": "AAAA",
                "clientDataJSON": "AAAA"
            },
            "type": "public-key"
        }
    });
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup/webauthn/register/finish")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(garbage.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();

    // The ApiError mapping treats AuthError::Webauthn as BAD_REQUEST because
    // verification failures are always caused by client-supplied data.
    let status = response.status();
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "expected 400 for garbage credential, got {status}"
    );
}

#[tokio::test]
async fn webauthn_finish_rejects_when_no_pending_registration() {
    // A finish call without a prior begin must be rejected as bad input.
    let (status, body, _) = post(
        "/api/setup/webauthn/register/finish",
        r#"{"owner_id":"00000000-0000-0000-0000-000000000000","credential":{"id":"AA","rawId":"AA","response":{"attestationObject":"AA","clientDataJSON":"AA"},"type":"public-key"}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");
}

#[tokio::test]
async fn webauthn_begin_rejects_empty_display_name() {
    let (status, _, _) = post(
        "/api/setup/webauthn/register/begin",
        r#"{"display_name":""}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn webauthn_finish_rejects_when_owner_already_exists() {
    // Password setup completes; calling begin→finish on a fresh app must 409.
    // We exercise it on a single shared app instance.
    let (state, _guard, _path) = common::fresh_state().await;
    let app = castify_api::app::build_app(state);

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    r#"{"display_name":"Jane","password":"correct horse"}"#,
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);

    let finish = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup/webauthn/register/finish")
                .header("content-type", "application/json")
                .body(Body::from(Bytes::from(
                    r#"{"owner_id":"00000000-0000-0000-0000-000000000000","credential":{"id":"AA","rawId":"AA","response":{"attestationObject":"AA","clientDataJSON":"AA"},"type":"public-key"}}"#,
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(finish.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn webauthn_finish_rejects_invalid_owner_id() {
    let (status, body, _) = post(
        "/api/setup/webauthn/register/finish",
        r#"{"owner_id":"not-a-uuid","credential":{"id":"AA","rawId":"AA","response":{"attestationObject":"AA","clientDataJSON":"AA"},"type":"public-key"}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body = {body}");
}
