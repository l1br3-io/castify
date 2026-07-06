use axum::http::{header, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../../frontend/dist"]
struct Asset;

pub async fn spa_handler(uri: Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    serve_path(path)
}

fn serve_path(path: &str) -> Response {
    let file_path = path.trim_start_matches('/');
    if let Some(content) = Asset::get(file_path) {
        let mime = mime_guess::from_path(file_path).first_or_octet_stream();
        return (
            [(header::CONTENT_TYPE, mime.as_ref())],
            content.data.into_owned(),
        )
            .into_response();
    }
    if let Some(index) = Asset::get("index.html") {
        return Html(index.data.into_owned()).into_response();
    }
    tracing::error!("embedded frontend dist is missing index.html");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

#[doc(hidden)]
pub fn list_embedded_assets() -> Vec<String> {
    Asset::iter()
        .map(|cow| cow.into_owned())
        .collect::<Vec<_>>()
}
