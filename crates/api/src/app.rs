use axum::extract::Request;
use axum::middleware::{from_fn, from_fn_with_state};
use axum::Router;
use tower_http::trace::{DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::middleware::{auth_middleware, csrf_middleware};
use crate::routes::{csrf, health, session, session_webauthn, setup, setup_webauthn};
use crate::spa::spa_handler;
use crate::state::AppState;

pub fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/api/health", axum::routing::get(health::health))
        .route("/api/csrf", axum::routing::get(csrf::get_csrf))
        .route(
            "/api/setup",
            axum::routing::get(setup::setup_status).post(setup::setup_password),
        )
        .route(
            "/api/setup/webauthn/register/begin",
            axum::routing::post(setup_webauthn::setup_webauthn_begin),
        )
        .route(
            "/api/setup/webauthn/register/finish",
            axum::routing::post(setup_webauthn::setup_webauthn_finish),
        )
        .route(
            "/api/session",
            axum::routing::post(session::login_password)
                .get(session::get_session)
                .delete(session::logout),
        )
        .route(
            "/api/session/webauthn/begin",
            axum::routing::post(session_webauthn::session_webauthn_begin),
        )
        .route(
            "/api/session/webauthn/finish",
            axum::routing::post(session_webauthn::session_webauthn_finish),
        )
        .fallback(spa_handler)
        .with_state(state.clone())
        // Layer order is outermost-first: trace logs every request, CSRF runs
        // only on authenticated mutations, auth gates non-allowlisted `/api/*`.
        // `from_fn_with_state` is needed for `auth_middleware` which reads the
        // AppState to access the session secret; csrf_middleware has no state.
        .layer(from_fn(csrf_middleware))
        .layer(from_fn_with_state(state, auth_middleware))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &Request<_>| {
                    tracing::info_span!(
                        "http.request",
                        method = %request.method(),
                        path = %request.uri().path(),
                    )
                })
                // Default OnResponse level is DEBUG, which the INFO filter
                // drops. Bump to INFO so `status` + `latency` land on every
                // request log (PRD FR-7.2).
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        )
}
