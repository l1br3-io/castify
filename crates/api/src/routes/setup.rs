use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::HeaderValue;
use axum::{response::IntoResponse, Json};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use castify_auth::password::hash_password;
use castify_auth::{NewOwner, SessionToken};

use crate::error::{ApiError, ApiResult};
use crate::routes::session_cookie::build_session_cookie;
use crate::state::AppState;

const MIN_PASSWORD_LEN: usize = 8;
const MAX_PASSWORD_LEN: usize = 256;
const MAX_DISPLAY_NAME_LEN: usize = 80;

#[derive(Debug, Deserialize)]
pub struct SetupPasswordRequest {
    pub display_name: Option<String>,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct SetupResponse {
    pub owner: OwnerDto,
}

// Re-export so existing internal callers (`crate::routes::setup::OwnerDto`)
// keep resolving after the type moved to `dto`.
pub use crate::routes::dto::OwnerDto;

/// Read-only owner-existence probe used by the SPA's cold-cache router.
///
/// Returns `200 {"status":"open"}` when no owner exists yet (first-run) and
/// `409 Conflict` once first-run setup has closed. Pre-auth allowlisted —
/// see `middleware::is_pre_auth`. Mirrors the gating that `setup_password`
/// performs as a side effect, but without mutating anything; the SPA needs
/// a read-only signal that `/api/session` (which returns 401 either way)
/// can't provide.
pub async fn setup_status(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    let repo = state.repository();
    if repo.owner_exists().await? {
        return Err(ApiError::Conflict(
            "an owner already exists; first-run setup is closed".to_string(),
        ));
    }
    Ok(Json(SetupStatusResponse {
        status: "open".to_string(),
    }))
}

#[derive(Debug, Serialize)]
pub struct SetupStatusResponse {
    pub status: String,
}

pub async fn setup_password(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<SetupPasswordRequest>,
) -> ApiResult<impl IntoResponse> {
    let repo = state.repository();

    if repo.owner_exists().await? {
        return Err(ApiError::Conflict(
            "an owner already exists; first-run setup is closed".to_string(),
        ));
    }

    validate_password(&req.password)?;
    validate_display_name(req.display_name.as_deref())?;

    let new_owner = NewOwner::new(req.display_name.clone());
    let owner = repo.create_owner(&new_owner).await?;
    let phc = hash_password(&req.password)?;
    repo.set_password(&new_owner.id, &phc).await?;
    let session_id = repo.create_session(&new_owner.id, None).await?;
    let token = SessionToken::issue(state.session_secret(), &session_id)?;

    let cookie = build_session_cookie(&token, state.config());
    let mut response = Json(SetupResponse {
        owner: OwnerDto {
            id: owner.id.to_string(),
            display_name: owner.display_name.clone(),
        },
    })
    .into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    let _ = jar;
    Ok(response)
}

fn validate_password(password: &str) -> ApiResult<()> {
    let len = password.chars().count();
    if len < MIN_PASSWORD_LEN {
        return Err(ApiError::Validation {
            detail: format!("password must be at least {MIN_PASSWORD_LEN} characters"),
        });
    }
    if len > MAX_PASSWORD_LEN {
        return Err(ApiError::Validation {
            detail: format!("password must be at most {MAX_PASSWORD_LEN} characters"),
        });
    }
    Ok(())
}

fn validate_display_name(name: Option<&str>) -> ApiResult<()> {
    if let Some(name) = name {
        let len = name.chars().count();
        if len == 0 || len > MAX_DISPLAY_NAME_LEN {
            return Err(ApiError::Validation {
                detail: format!(
                    "display_name must be 1..={MAX_DISPLAY_NAME_LEN} characters when present"
                ),
            });
        }
    }
    Ok(())
}
