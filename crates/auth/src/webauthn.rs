//! WebAuthn glue: wraps [`webauthn_rs::Webauthn`] in Castify's error type and
//! exposes the subset of types the API layer needs.
//!
//! Source for the construction pattern:
//! <https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.WebauthnBuilder.html>
//! and
//! <https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.Webauthn.html#method.start_securitykey_registration>.

use castify_core::Config;
use url::Url;
use webauthn_rs::prelude::{
    AuthenticationResult, CreationChallengeResponse, PublicKeyCredential,
    RegisterPublicKeyCredential, RequestChallengeResponse, SecurityKey, SecurityKeyAuthentication,
    SecurityKeyRegistration, Webauthn, WebauthnBuilder,
};

use crate::error::{AuthError, AuthResult};

/// Construct the [`Webauthn`] relying party from Castify's [`Config`].
///
/// The relying party id is derived from the public URL's host (e.g. localhost
/// in dev, `castify.example.com` in prod). The relying party origin is the
/// public URL itself. The rp name is the host string; webauthn-rs only uses it
/// for display, and changing it later does not invalidate credentials.
///
/// `allow_any_port(true)` is set so dev origins like `http://localhost:3000`
/// don't fail verification just for having a port. Production deployments on
/// standard ports are unaffected.
///
/// Source: <https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.WebauthnBuilder.html>
pub fn build_webauthn(config: &Config) -> AuthResult<Webauthn> {
    let origin: &Url = &config.public_url;
    let rp_id = origin.host_str().ok_or_else(|| {
        AuthError::Validation(format!(
            "CASTIFY_PUBLIC_URL must have a host; got {}",
            config.public_url
        ))
    })?;
    let mut builder = WebauthnBuilder::new(rp_id, origin)
        .map_err(|e| AuthError::Webauthn(format!("webauthn builder rejected rp config: {e}")))?;
    // rp_name defaults to rp_id if not set — that's a safe display value.
    if origin.port().is_some() {
        builder = builder.allow_any_port(true);
    }
    builder
        .build()
        .map_err(|e| AuthError::Webauthn(format!("webauthn builder failed: {e}")))
}

/// Begin registering a security key (a.k.a. passkey). Returns the challenge to
/// send to the browser plus the server-side state that must be paired with the
/// eventual `finish_securitykey_registration` call.
///
/// Source: <https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.Webauthn.html#method.start_securitykey_registration>
pub fn start_security_key_registration(
    webauthn: &Webauthn,
    owner_id: uuid::Uuid,
    user_name: &str,
    user_display_name: &str,
) -> AuthResult<(CreationChallengeResponse, SecurityKeyRegistration)> {
    webauthn
        .start_securitykey_registration(owner_id, user_name, user_display_name, None, None, None)
        .map_err(map_webauthn_error)
}

/// Complete the registration of a security key, returning the verified
/// [`SecurityKey`] to persist.
///
/// Source: <https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.Webauthn.html#method.finish_securitykey_registration>
pub fn finish_security_key_registration(
    webauthn: &Webauthn,
    reg: &RegisterPublicKeyCredential,
    state: &SecurityKeyRegistration,
) -> AuthResult<SecurityKey> {
    webauthn
        .finish_securitykey_registration(reg, state)
        .map_err(map_webauthn_error)
}

/// `webauthn_rs_core::error::WebauthnError` is not exposed outside the prelude,
/// so stringify it (matches the deviation noted in `tasks/plan.md`).
fn map_webauthn_error(e: webauthn_rs::prelude::WebauthnError) -> AuthError {
    AuthError::Webauthn(e.to_string())
}

// ---------------------------------------------------------------------------
// Authentication (login) wrappers — symmetric with the registration pair.
// ---------------------------------------------------------------------------

/// Begin authentication with one or more previously-registered security keys.
/// Returns the challenge to send to the browser plus the server-side state
/// that must be paired with the eventual `finish_securitykey_authentication`
/// call. The caller is responsible for storing the state server-side keyed by
/// a fresh `auth_request_id` and removing it (single-use) on finish.
///
/// Source: <https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.Webauthn.html#method.start_securitykey_authentication>
pub fn start_security_key_authentication(
    webauthn: &Webauthn,
    allow_credentials: &[SecurityKey],
) -> AuthResult<(RequestChallengeResponse, SecurityKeyAuthentication)> {
    webauthn
        .start_securitykey_authentication(allow_credentials)
        .map_err(map_webauthn_error)
}

/// Complete authentication, returning the verified [`AuthenticationResult`].
/// On success the caller issues a session for the owner the credential
/// belongs to. The `state` must be the value returned by the matching
/// [`start_security_key_authentication`] call.
///
/// Source: <https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.Webauthn.html#method.finish_securitykey_authentication>
pub fn finish_security_key_authentication(
    webauthn: &Webauthn,
    credential: &PublicKeyCredential,
    state: &SecurityKeyAuthentication,
) -> AuthResult<AuthenticationResult> {
    webauthn
        .finish_securitykey_authentication(credential, state)
        .map_err(map_webauthn_error)
}
