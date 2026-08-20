//! Session lifecycle endpoints for the existing (single-owner) instance.
//!
//! Four handlers:
//!   * `POST /api/session` — password login, issues a session cookie.
//!   * `GET  /api/session` — returns the owner for the current session, or 401.
//!   * `DELETE /api/session` — invalidates the current session and clears the cookie.
//!   * `PUT  /api/session/password` — rotates the owner password, revoking
//!     every session (see [`change_password`]).
//!
//! Login is single-owner in M0: there's no per-user lookup, only password
//! verification against the one owner row. `display_name` is accepted for
//! forward-compat but is unused.

use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use castify_auth::password::{hash_password, verify_password};
use castify_auth::{AuthError, SessionToken};

use crate::cookies::{build_session_cookie, clear_session_cookie, extract_session_id};
use crate::dto::OwnerDto;
use crate::error::{ApiError, ApiResult};
use crate::routes::validate_password;
use crate::state::AppState;

const MAX_DISPLAY_NAME_LEN: usize = 80;

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub display_name: Option<String>,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub owner: OwnerDto,
}

pub async fn login_password(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> ApiResult<impl IntoResponse> {
    let repo = state.repository();
    let owner = repo.fetch_owner().await?;
    let stored_phc = repo
        .fetch_password_hash(&owner.id)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    verify_password(&req.password, &stored_phc)?;

    if let Some(name) = req.display_name.as_deref() {
        validate_display_name(name)?;
    }

    let session_id = repo.create_session(&owner.id, None).await?;
    let token = SessionToken::issue(state.session_secret(), &session_id)?;
    let cookie = build_session_cookie(&token, state.config());

    let mut response = Json(LoginResponse {
        owner: OwnerDto::from_owner(&owner),
    })
    .into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    let _ = jar;
    Ok(response)
}

#[derive(Debug, Serialize)]
pub struct GetSessionResponse {
    pub owner: OwnerDto,
}

/// Resolve the current session from the cookie. Returns 401 when there is no
/// cookie, the cookie is tampered, the session row is gone, or the session has
/// expired. On success returns the owner that the session belongs to.
pub async fn get_session(
    State(state): State<AppState>,
    jar: CookieJar,
) -> ApiResult<impl IntoResponse> {
    let session_id = extract_session_id(&jar, state.session_secret())
        .ok_or(ApiError::Auth(AuthError::InvalidSession))?;
    let repo = state.repository();
    let owner_id = repo.validate_session(&session_id).await?;
    let owner = repo.fetch_owner_by_id(&owner_id).await?;
    Ok(Json(GetSessionResponse {
        owner: OwnerDto::from_owner(&owner),
    }))
}

/// Idempotent logout: if a valid session cookie is present, remove the
/// session row; always emit a cleared cookie. Returns 204 regardless of
/// whether a session existed.
pub async fn logout(State(state): State<AppState>, jar: CookieJar) -> ApiResult<Response> {
    if let Some(session_id) = extract_session_id(&jar, state.session_secret()) {
        // Best-effort delete: an expired or already-removed row is not an
        // error at this layer.
        let _ = state.repository().delete_session(&session_id).await;
    }
    let cookie = clear_session_cookie(state.config());
    let mut response = Response::new(axum::body::Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    Ok(response)
}

fn validate_display_name(name: &str) -> ApiResult<()> {
    let len = name.chars().count();
    if len == 0 || len > MAX_DISPLAY_NAME_LEN {
        return Err(ApiError::Validation {
            detail: format!(
                "display_name must be 1..={MAX_DISPLAY_NAME_LEN} characters when present"
            ),
        });
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

/// Replace the owner's password and revoke every session.
///
/// Verifies `current_password` (401 on mismatch with the same generic
/// `InvalidCredentials` error as login failure — no oracle distinguishing a
/// wrong password from any other credential problem), validates the new
/// password with the shared setup rules, then writes the new hash **before**
/// revoking sessions. Response is `204 No Content` with a cleared session
/// cookie: the acting browser lands on the login screen alongside every
/// other device.
///
/// GOTCHA: the hash write must precede the session purge. If the purge ran
/// first and the hash write failed mid-flight, the *old* password would
/// guard zero live sessions — the owner would be locked out of devices with
/// no recovery but the old (unknown-at-that-point) credential. With this
/// ordering, the worst mid-flight failure leaves the new password guarding
/// still-live sessions, which the owner can simply retry.
pub async fn change_password(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<ChangePasswordRequest>,
) -> ApiResult<Response> {
    let session_id = extract_session_id(&jar, state.session_secret())
        .ok_or(ApiError::Auth(AuthError::InvalidSession))?;
    let repo = state.repository();
    let owner_id = repo.validate_session(&session_id).await?;

    let stored_phc = repo
        .fetch_password_hash(&owner_id)
        .await?
        .ok_or(ApiError::Auth(AuthError::InvalidCredentials))?;
    verify_password(&req.current_password, &stored_phc)?;

    validate_password(&req.new_password)?;

    let phc = hash_password(&req.new_password)?;
    repo.set_password(&owner_id, &phc).await?;
    let revoked = repo.delete_all_sessions(&owner_id).await?;
    tracing::info!(owner_id = %owner_id, sessions_revoked = revoked, "password changed; all sessions revoked");

    let cookie = clear_session_cookie(state.config());
    let mut response = Response::new(axum::body::Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    Ok(response)
}
