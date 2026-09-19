use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::middleware::{from_fn, from_fn_with_state};
use axum::Router;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::{DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::middleware::{auth_middleware, csrf_middleware};
use crate::routes::{
    collections, connections, csrf, files, folders, health, session, settings, setup, share,
    shares, videos,
};
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
        .route(
            "/api/session/password",
            axum::routing::put(session::change_password),
        )
        .route(
            "/api/settings/transcode",
            axum::routing::get(settings::get_transcode_settings)
                .put(settings::put_transcode_settings),
        )
        .route("/api/connections", axum::routing::get(connections::list))
        .route(
            "/api/connections/available",
            axum::routing::get(connections::available),
        )
        .route(
            "/api/connections/s3",
            axum::routing::post(connections::connect_s3),
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
            "/api/videos/{id}",
            axum::routing::get(videos::get_video_detail),
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
            "/api/videos/{id}/progress",
            axum::routing::post(videos::set_progress).get(videos::get_progress),
        )
        .route(
            "/api/videos/{id}/thumbnail",
            axum::routing::get(videos::get_thumbnail),
        )
        .route(
            "/api/videos/{id}/stream",
            axum::routing::get(videos::get_stream),
        )
        .route(
            "/api/videos/{id}/stream-url",
            axum::routing::get(videos::get_stream_url),
        )
        .route(
            "/api/videos/{id}/cached-stream",
            axum::routing::get(videos::get_cached_stream),
        )
        .route(
            "/api/videos/{id}/download",
            axum::routing::get(videos::get_download),
        )
        .route("/api/folders/tree", axum::routing::get(folders::tree))
        .route(
            "/api/folders/contents",
            axum::routing::get(folders::contents),
        )
        .route(
            "/api/collections",
            axum::routing::get(collections::list_collections).post(collections::create_collection),
        )
        .route(
            "/api/collections/{id}",
            axum::routing::get(collections::get_collection)
                .patch(collections::rename_collection)
                .delete(collections::delete_collection),
        )
        .route(
            "/api/collections/{id}/items/{video_id}",
            axum::routing::post(collections::add_collection_item)
                .delete(collections::remove_collection_item),
        )
        .route(
            "/api/collections/{id}/items",
            axum::routing::put(collections::replace_collection_items),
        )
        .route(
            "/api/files/{id}/download",
            axum::routing::get(files::download),
        )
        .route(
            "/api/videos/{id}/subtitles",
            axum::routing::get(videos::list_subtitles),
        )
        .route(
            "/api/videos/{id}/subtitles/{subtitle_id}",
            axum::routing::get(videos::get_subtitle_track),
        )
        .route(
            "/api/videos/{id}/cache",
            axum::routing::post(videos::set_cache_pinned).delete(videos::delete_cache_entry),
        )
        .route(
            "/api/admin/cache",
            axum::routing::get(videos::get_cache_admin),
        )
        .route(
            "/api/admin/transcode",
            axum::routing::get(videos::get_transcode_admin),
        )
        .route(
            "/api/admin/probe",
            axum::routing::get(videos::get_probe_admin),
        )
        .route(
            "/api/admin/reprobe/{video_id}",
            axum::routing::post(videos::reprobe_one),
        )
        .route(
            "/api/admin/reprobe-all",
            axum::routing::post(videos::reprobe_all),
        )
        .route(
            "/api/videos/{id}/transcode/master.m3u8",
            axum::routing::get(videos::get_transcode_master),
        )
        .route(
            "/api/videos/{id}/transcode/{variant}/playlist.m3u8",
            axum::routing::get(videos::get_transcode_playlist),
        )
        .route(
            "/api/videos/{id}/transcode/{variant}/{segment}",
            axum::routing::get(videos::get_transcode_segment),
        )
        .route(
            "/api/videos/{id}/transcode",
            axum::routing::delete(videos::cancel_transcode),
        )
        .route(
            "/api/shares",
            axum::routing::post(shares::create).get(shares::list),
        )
        .route("/api/shares/{id}", axum::routing::delete(shares::revoke))
        .route(
            "/api/shares/{id}/items",
            axum::routing::get(shares::list_items)
                .put(shares::replace_items)
                .post(shares::append_items),
        )
        .route("/api/share/{token}", axum::routing::get(share::resolve))
        .route("/api/share/{token}/items", axum::routing::get(share::items))
        .route(
            "/api/share/{token}/unlock",
            axum::routing::post(share::unlock),
        )
        .route(
            "/api/share/{token}/videos/{id}/stream",
            axum::routing::get(share::stream),
        )
        .route(
            "/api/share/{token}/videos/{id}/stream-url",
            axum::routing::get(share::stream_url),
        )
        .route(
            "/api/share/{token}/videos/{id}/thumbnail",
            axum::routing::get(share::thumbnail),
        )
        .route(
            "/api/share/{token}/videos/{id}/subtitles",
            axum::routing::get(share::subtitles),
        )
        .route(
            "/api/share/{token}/videos/{id}/subtitles/{subtitle_id}",
            axum::routing::get(share::subtitle_track),
        )
        .route(
            "/api/share/{token}/videos/{id}/transcode/master.m3u8",
            axum::routing::get(share::transcode_master),
        )
        .route(
            "/api/share/{token}/videos/{id}/transcode/{variant}/playlist.m3u8",
            axum::routing::get(share::transcode_playlist),
        )
        .route(
            "/api/share/{token}/videos/{id}/transcode/{variant}/{segment}",
            axum::routing::get(share::transcode_segment),
        )
        .route(
            "/api/share/{token}/videos/{id}/cached-stream",
            axum::routing::get(share::cached_stream),
        );

    #[cfg(feature = "e2e")]
    let router = router
        .route(
            "/api/__e2e/seed-connection",
            axum::routing::post(crate::e2e::seed_connection),
        )
        .route(
            "/api/__e2e/mock-cdn/{file_id}",
            axum::routing::get(crate::e2e::mock_cdn),
        )
        .route(
            "/api/__e2e/s3-presign",
            axum::routing::post(crate::e2e::set_s3_presign),
        )
        .route(
            "/api/__e2e/s3-delete",
            axum::routing::post(crate::e2e::delete_s3_object),
        )
        .route(
            "/api/__e2e/s3-put",
            axum::routing::post(crate::e2e::put_s3_object),
        )
        .route(
            "/api/__e2e/prune-grace",
            axum::routing::post(crate::e2e::set_prune_grace),
        );

    router
        .fallback(spa_handler)
        .with_state(state.clone())
        // Defense-in-depth against MIME confusion on provider-proxied bytes:
        // browsers must not sniff a content type the response doesn't declare
        // (`if_not_present` keeps any explicitly-set header authoritative).
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
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
