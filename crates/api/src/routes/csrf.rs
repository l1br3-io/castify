//! CSRF token endpoint.
//!
//! `GET /api/csrf` is the single authenticated source of a double-submit CSRF
//! token. It mints a fresh random token, sets it on the `castify_csrf` cookie
//! (readable by JavaScript — see [`crate::cookies::build_csrf_cookie`]),
//! and returns it in the response body so the client knows what to send as
//! `X-CSRF-Token` on subsequent mutations.

use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::HeaderValue;
use axum::response::IntoResponse;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::Serialize;

use crate::cookies::{build_csrf_cookie, generate_csrf_token};
use crate::error::ApiResult;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct CsrfResponse {
    pub token: String,
}

pub async fn get_csrf(
    State(state): State<AppState>,
    jar: CookieJar,
) -> ApiResult<impl IntoResponse> {
    let token = generate_csrf_token();
    let cookie = build_csrf_cookie(&token, state.config());

    let mut response = Json(CsrfResponse { token }).into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    let _ = jar;
    Ok(response)
}
