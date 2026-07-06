//! WebAuthn login (a.k.a. passkey authentication) endpoints.
//!
//! Two endpoints, symmetric with the setup-webauthn pair:
//!   * `POST /api/session/webauthn/begin` — single-owner implicit, issues a
//!     `RequestChallengeResponse` keyed by a fresh `auth_request_id`.
//!   * `POST /api/session/webauthn/finish` — verifies the `PublicKeyCredential`
//!     returned by the authenticator, then issues a session cookie for the
//!     owner that owns the matched credential.
//!
//! Source for the authentication lifecycle:
//! <https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.Webauthn.html#method.start_securitykey_authentication>

use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::HeaderValue;
use axum::{response::IntoResponse, Json};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use webauthn_rs::prelude::{PublicKeyCredential, RequestChallengeResponse};

use castify_auth::webauthn::{
    finish_security_key_authentication, start_security_key_authentication,
};
use castify_auth::SessionToken;

use crate::error::{ApiError, ApiResult};
use crate::routes::dto::OwnerDto;
use crate::routes::session::LoginResponse;
use crate::routes::session_cookie::build_session_cookie;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct WebauthnAuthBeginResponse {
    /// Opaque id the client must echo back on `finish`. The pending
    /// authentication state on the server is keyed by this value, and is
    /// removed after the finish call (success or failure).
    pub auth_request_id: String,
    /// Flattened [`RequestChallengeResponse`]. Same flattening rationale as
    /// the setup begin endpoint: lifts RCR's `publicKey` field up so the
    /// response shape is `{auth_request_id, publicKey: {...}}` — exactly what
    /// `navigator.credentials.get()` expects.
    #[serde(flatten)]
    pub public_key: RequestChallengeResponse,
}

/// Single-owner implicit begin. No request body: the server knows which owner
/// exists and which credentials they have registered. Returns 404 when no
/// owner exists yet or the owner has no registered passkeys.
pub async fn session_webauthn_begin(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    let repo = state.repository();
    let owner = repo.fetch_owner().await?;
    let creds = repo.list_webauthn_credentials(&owner.id).await?;
    if creds.is_empty() {
        // No passkey registered → nothing to authenticate against.
        return Err(ApiError::NotFound);
    }
    let (rcr, auth_state) = start_security_key_authentication(state.webauthn(), &creds)?;
    let auth_request_id = Uuid::new_v4();
    state
        .pending_authentications()
        .insert(auth_request_id, auth_state);
    Ok(Json(WebauthnAuthBeginResponse {
        auth_request_id: auth_request_id.to_string(),
        public_key: rcr,
    }))
}

/// Request body for `finish`. `auth_request_id` must match the value returned
/// by `begin`; `credential` is the JSON `PublicKeyCredential` produced by
/// `navigator.credentials.get`.
#[derive(Debug, Deserialize)]
pub struct WebauthnAuthFinishRequest {
    pub auth_request_id: String,
    pub credential: PublicKeyCredential,
}

pub async fn session_webauthn_finish(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<WebauthnAuthFinishRequest>,
) -> ApiResult<impl IntoResponse> {
    let auth_request_id =
        Uuid::parse_str(&req.auth_request_id).map_err(|e| ApiError::Validation {
            detail: format!("auth_request_id must be a uuid: {e}"),
        })?;

    // Take the authentication state out of the map so it can't be replayed.
    let (_, auth_state) = state
        .pending_authentications()
        .remove(&auth_request_id)
        .ok_or_else(|| ApiError::Validation {
            detail: "no pending webauthn authentication for this auth_request_id; call begin first"
                .to_string(),
        })?;

    // finish_securitykey_authentication verifies the signature against the
    // allowed credentials that were baked into the challenge at begin time.
    // On success the credential belongs to the single M0 owner, so we resolve
    // the owner row directly. (A multi-owner future would map
    // AuthenticationResult.credential_id → owner_id via webauthn_credentials.)
    finish_security_key_authentication(state.webauthn(), &req.credential, &auth_state)?;

    let repo = state.repository();
    let owner = repo.fetch_owner().await?;
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
