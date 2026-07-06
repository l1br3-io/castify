//! First-run setup via WebAuthn passkey enrollment.
//!
//! Two endpoints, both gated on "no owner exists yet":
//!   * `POST /api/setup/webauthn/register/begin` — issues a `CreationChallengeResponse`.
//!   * `POST /api/setup/webauthn/register/finish` — verifies the
//!     `RegisterPublicKeyCredential` returned by the authenticator, persists
//!     the credential, creates the owner row, and issues a session cookie.
//!
//! Source for the registration lifecycle:
//! <https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.Webauthn.html#method.start_securitykey_registration>

use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::HeaderValue;
use axum::{response::IntoResponse, Json};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use webauthn_rs::prelude::{
    CreationChallengeResponse, RegisterPublicKeyCredential, SecurityKeyRegistration,
};

use castify_auth::webauthn::{finish_security_key_registration, start_security_key_registration};
use castify_auth::{NewOwner, SessionToken};

use crate::error::{ApiError, ApiResult};
use crate::routes::session_cookie::build_session_cookie;
use crate::routes::setup::OwnerDto;
use crate::state::AppState;

const MAX_DISPLAY_NAME_LEN: usize = 80;

/// Request body for `begin`. The display name is optional and only used as a
/// hint to the authenticator UI.
#[derive(Debug, Deserialize)]
pub struct WebauthnBeginRequest {
    pub display_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WebauthnBeginResponse {
    /// Opaque owner id used as the WebAuthn user handle. The browser will
    /// echo this back as `user.id` in the creation options. The client must
    /// send it back unmodified on `finish`.
    pub owner_id: String,
    /// Flattened [`CreationChallengeResponse`]. The flatten lifts CCR's own
    /// `publicKey` field up to the top level so the response is shaped as
    /// `{owner_id, publicKey: {...}}` — the exact shape
    /// `navigator.credentials.create()` expects.
    #[serde(flatten)]
    pub public_key: CreationChallengeResponse,
}

pub async fn setup_webauthn_begin(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<WebauthnBeginRequest>,
) -> ApiResult<impl IntoResponse> {
    let repo = state.repository();

    if repo.owner_exists().await? {
        return Err(ApiError::Conflict(
            "an owner already exists; first-run setup is closed".to_string(),
        ));
    }

    validate_display_name(req.display_name.as_deref())?;

    // The owner id is generated up-front so we can pair it with the WebAuthn
    // user handle. The owner row itself isn't created until `finish` succeeds —
    // if the user abandons the flow, no owner row exists.
    let owner_id = Uuid::new_v4();
    let user_name = req.display_name.as_deref().unwrap_or("owner").to_string();
    let (ccr, registration) =
        start_security_key_registration(state.webauthn(), owner_id, &user_name, &user_name)?;

    state.pending_registrations().insert(owner_id, registration);

    let _ = jar;
    Ok(Json(WebauthnBeginResponse {
        owner_id: owner_id.to_string(),
        public_key: ccr,
    }))
}

/// Request body for `finish`. The `owner_id` must match the value returned by
/// `begin`. The `credential` field is the JSON `RegisterPublicKeyCredential`
/// produced by `navigator.credentials.create`.
#[derive(Debug, Deserialize)]
pub struct WebauthnFinishRequest {
    pub owner_id: String,
    pub credential: RegisterPublicKeyCredential,
}

#[derive(Debug, Serialize)]
pub struct WebauthnFinishResponse {
    pub owner: OwnerDto,
}

pub async fn setup_webauthn_finish(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<WebauthnFinishRequest>,
) -> ApiResult<impl IntoResponse> {
    let repo = state.repository();

    if repo.owner_exists().await? {
        return Err(ApiError::Conflict(
            "an owner already exists; first-run setup is closed".to_string(),
        ));
    }

    let owner_id = Uuid::parse_str(&req.owner_id).map_err(|e| ApiError::Validation {
        detail: format!("owner_id must be a uuid: {e}"),
    })?;

    // Take the registration state out of the map so it can't be replayed.
    let (_, registration) = state
        .pending_registrations()
        .remove(&owner_id)
        .ok_or_else(|| ApiError::Validation {
            detail: "no pending webauthn registration for this owner_id; call begin first"
                .to_string(),
        })?;

    let security_key =
        finish_security_key_registration(state.webauthn(), &req.credential, &registration)?;

    // The owner row is created here, not in `begin`, so an abandoned
    // first-run flow leaves no owner behind. The id is the WebAuthn user
    // handle we committed to in `begin`.
    let new_owner = NewOwner::with_id(owner_id, None);
    let owner = repo.create_owner(&new_owner).await?;
    repo.save_webauthn_credential(&owner.id, &security_key)
        .await?;
    let session_id = repo.create_session(&owner.id, None).await?;
    let token = SessionToken::issue(state.session_secret(), &session_id)?;

    let cookie = build_session_cookie(&token, state.config());
    let mut response = Json(WebauthnFinishResponse {
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

// Silence unused-import warning if `SecurityKeyRegistration` isn't referenced
// directly in some build configurations — the type still documents intent.
#[allow(dead_code)]
type _PendingRegistration = SecurityKeyRegistration;
