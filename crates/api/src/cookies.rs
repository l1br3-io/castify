//! Cookie plumbing for the castify API: the signed session cookie and the
//! double-submit CSRF cookie. Cross-cutting — consumed by [`crate::middleware`]
//! (cookie extraction + name constants) and the session/setup/csrf routes
//! (build/clear).
use axum_extra::extract::CookieJar;
use base64::Engine;
use cookie::{Cookie, SameSite};
use rand::rngs::OsRng;
use rand::RngCore;

use castify_auth::{SessionId, SessionSecret, SessionToken};

pub const SESSION_COOKIE_NAME: &str = "castify_session";
pub const CSRF_COOKIE_NAME: &str = "castify_csrf";
pub const CSRF_HEADER_NAME: &str = "x-csrf-token";
const SESSION_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const CSRF_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const CSRF_TOKEN_BYTES: usize = 32;

/// Build the signed session cookie. The `Secure` flag is controlled by
/// [`castify_core::Config::cookie_secure`] (env: `CASTIFY_COOKIE_SECURE`),
/// which auto-detects from `CASTIFY_APP_BASE_URL` and defaults to `false` for
/// local HTTP dev so browsers don't drop the cookie.
pub fn build_session_cookie(
    token: &SessionToken,
    config: &castify_core::Config,
) -> Cookie<'static> {
    let mut cookie = Cookie::build((SESSION_COOKIE_NAME, token.0.clone()));
    cookie = cookie
        .path("/")
        .same_site(SameSite::Lax)
        .http_only(true)
        .max_age(cookie::time::Duration::seconds(SESSION_TTL_SECONDS));
    if config.cookie_secure {
        cookie = cookie.secure(true);
    }
    cookie.build()
}

/// Build an expiry cookie that overwrites the session cookie with an empty
/// value and zero max-age. Attribute parity with [`build_session_cookie`] is
/// important: browsers will only replace a cookie when the new one has the
/// same domain/path/secure/etc.
pub fn clear_session_cookie(config: &castify_core::Config) -> Cookie<'static> {
    let mut cookie = Cookie::build((SESSION_COOKIE_NAME, ""));
    cookie = cookie
        .path("/")
        .same_site(SameSite::Lax)
        .http_only(true)
        .max_age(cookie::time::Duration::seconds(0));
    if config.cookie_secure {
        cookie = cookie.secure(true);
    }
    cookie.build()
}

/// Read and verify the session cookie, returning the underlying [`SessionId`].
///
/// Returns `None` when the cookie is absent, empty, or fails HMAC verification.
/// A tampered cookie is indistinguishable from a missing cookie at this layer;
/// callers translate `None` into a 401 at the handler level.
pub fn extract_session_id(jar: &CookieJar, secret: &SessionSecret) -> Option<SessionId> {
    let raw = jar.get(SESSION_COOKIE_NAME)?.value();
    if raw.is_empty() {
        return None;
    }
    let token = SessionToken(raw.to_string());
    token.verify(secret).ok()
}

/// Generate a fresh random CSRF token (32 bytes, base64 standard).
pub fn generate_csrf_token() -> String {
    let mut bytes = [0u8; CSRF_TOKEN_BYTES];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Build the CSRF cookie. Unlike the session cookie, this is **not** HttpOnly:
/// the client-side JS must be able to read it and echo its value back as the
/// `X-CSRF-Token` header on mutations (the double-submit pattern).
pub fn build_csrf_cookie(token: &str, config: &castify_core::Config) -> Cookie<'static> {
    let mut cookie = Cookie::build((CSRF_COOKIE_NAME, token.to_string()));
    cookie = cookie
        .path("/")
        .same_site(SameSite::Lax)
        .http_only(false)
        .max_age(cookie::time::Duration::seconds(CSRF_TTL_SECONDS));
    if config.cookie_secure {
        cookie = cookie.secure(true);
    }
    cookie.build()
}

/// Build an expiry cookie that overwrites the CSRF cookie with an empty value.
pub fn clear_csrf_cookie(config: &castify_core::Config) -> Cookie<'static> {
    let mut cookie = Cookie::build((CSRF_COOKIE_NAME, ""));
    cookie = cookie
        .path("/")
        .same_site(SameSite::Lax)
        .http_only(false)
        .max_age(cookie::time::Duration::seconds(0));
    if config.cookie_secure {
        cookie = cookie.secure(true);
    }
    cookie.build()
}
