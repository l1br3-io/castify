//! Shared auth helpers used across route handlers.

use axum_extra::extract::CookieJar;
use castify_auth::AuthError;

use crate::cookies::extract_session_id;
use crate::dto::OwnerDto;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Resolve the authenticated owner from the session cookie. Validates the
/// signed session id against the database and returns the owner DTO. Returns
/// `ApiError::Auth(InvalidSession)` if the cookie is absent, tampered, or
/// refers to a revoked/expired session.
pub(crate) async fn resolve_owner(state: &AppState, jar: &CookieJar) -> ApiResult<OwnerDto> {
    let session_id = extract_session_id(jar, state.session_secret())
        .ok_or(ApiError::Auth(AuthError::InvalidSession))?;
    let owner_id = state.repository().validate_session(&session_id).await?;
    let owner = state.repository().fetch_owner_by_id(&owner_id).await?;
    Ok(OwnerDto::from_owner(&owner))
}
