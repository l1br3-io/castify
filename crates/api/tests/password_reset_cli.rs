mod common;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use castify_api::app::build_app;
use castify_api::cli;
use castify_auth::password::verify_password;
use serde_json::{json, Value};
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery staple";

/// POST a JSON body, return the status code.
async fn post_json(app: axum::Router, uri: &str, body: Value) -> StatusCode {
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
    response.status()
}

/// First-run setup: creates the owner with `PASSWORD` and one session.
async fn setup_owner(state: &castify_api::state::AppState) {
    let app = build_app(state.clone());
    assert_eq!(
        post_json(
            app,
            "/api/setup",
            json!({"display_name":"Jane","password":PASSWORD})
        )
        .await,
        StatusCode::OK,
        "setup must succeed first"
    );
}

/// The happy path: temp password installed, every session revoked, old
/// password dead. Mirrors the acceptance criteria — the CLI logic is
/// exercised through its own DB connection, like the real binary.
#[tokio::test]
async fn reset_password_installs_temp_password_and_revokes_all_sessions() {
    let (state, _guard, _path) = common::fresh_state().await;
    setup_owner(&state).await;
    // A second login = a second session to revoke.
    assert_eq!(
        post_json(
            build_app(state.clone()),
            "/api/session",
            json!({"password":PASSWORD})
        )
        .await,
        StatusCode::OK
    );

    let temp = cli::reset_password(state.config())
        .await
        .expect("reset must succeed with an owner present");
    assert_eq!(temp.chars().count(), 20);
    for ambiguous in ['0', 'O', '1', 'l', 'I'] {
        assert!(!temp.contains(ambiguous));
    }

    // Every session is gone — all devices, including the two above.
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(state.pool())
        .await
        .unwrap();
    assert_eq!(sessions, 0);

    // The temp password verifies against the stored hash...
    let repo = state.repository();
    let owner = repo.fetch_owner().await.unwrap();
    let stored = repo
        .fetch_password_hash(&owner.id)
        .await
        .unwrap()
        .expect("hash must exist after reset");
    verify_password(&temp, &stored).expect("temp password must verify");

    // ...and succeeds at POST /api/session in a follow-up boot; old one 401s.
    let app = build_app(state.clone());
    assert_eq!(
        post_json(app.clone(), "/api/session", json!({"password":temp})).await,
        StatusCode::OK,
        "temp password must log in"
    );
    assert_eq!(
        post_json(app, "/api/session", json!({"password":PASSWORD})).await,
        StatusCode::UNAUTHORIZED,
        "old password must fail"
    );
}

/// Locked-out recovery must not mint credentials for a database with no
/// owner — a clear error, and no password produced.
#[tokio::test]
async fn reset_password_without_owner_is_an_error() {
    let (state, _guard, _path) = common::fresh_state().await;
    let err = cli::reset_password(state.config())
        .await
        .expect_err("must refuse without an owner");
    let chain = format!("{err:#}");
    assert!(
        chain.contains("no owner"),
        "error must say no owner is configured, got: {chain}"
    );
}
