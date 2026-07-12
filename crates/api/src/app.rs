use axum::extract::Request;
use axum::middleware::{from_fn, from_fn_with_state};
use axum::Router;
use tower_http::trace::{DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::middleware::{auth_middleware, csrf_middleware};
use crate::routes::{connections, csrf, health, session, setup, videos};
use crate::spa::spa_handler;
use crate::state::AppState;

pub fn build_app(state: AppState) -> Router {
    let router = Router::new()
        .route("/api/health", axum::routing::get(health::health))
        .route("/api/csrf", axum::routing::get(csrf::get_csrf))
        .route(
            "/api/setup",
            axum::routing::get(setup::setup_status).post(setup::setup_password),
        )
        .route(
            "/api/session",
            axum::routing::post(session::login_password)
                .get(session::get_session)
                .delete(session::logout),
        )
        .route("/api/connections", axum::routing::get(connections::list))
        .route(
            "/api/connections/available",
            axum::routing::get(connections::available),
        )
        .route(
            "/api/connections/{provider}/start",
            axum::routing::post(connections::start),
        )
        .route(
            "/api/connections/{provider}/callback",
            axum::routing::get(connections::callback),
        )
        .route(
            "/api/connections/{id}",
            axum::routing::delete(connections::disconnect),
        )
        .route(
            "/api/connections/{id}/scan",
            axum::routing::post(connections::trigger_rescan).get(connections::scan_status),
        )
        .route("/api/videos", axum::routing::get(videos::list_videos))
        .route(
            "/api/videos/folders",
            axum::routing::get(videos::list_folders),
        )
        .route(
            "/api/videos/{id}/favorite",
            axum::routing::post(videos::set_favorite).delete(videos::delete_favorite),
        )
        .route(
            "/api/videos/{id}/rating",
            axum::routing::put(videos::set_rating).delete(videos::delete_rating),
        )
        .route(
            "/api/videos/{id}/thumbnail",
            axum::routing::get(videos::get_thumbnail),
        );

    #[cfg(feature = "e2e")]
    let router = router.route(
        "/api/__e2e/seed-connection",
        axum::routing::post(crate::e2e::seed_connection),
    );

    router
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
