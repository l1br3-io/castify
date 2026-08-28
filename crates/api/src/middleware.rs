//! Auth and CSRF middleware.
//!
//! Two `axum::middleware::from_fn` layers gate the `/api/*` surface:
//!
//!   * [`auth_middleware`] — every non-allowlisted `/api/*` route must carry a
//!     signed, valid session cookie. Signature check only (no DB lookup);
//!     handlers retain responsibility for full session-row validation.
//!   * [`csrf_middleware`] — authenticated mutations (`POST`/`PUT`/`PATCH`/
//!     `DELETE`) must send an `X-CSRF-Token` header whose value matches the
//!     `castify_csrf` cookie (double-submit pattern).
//!
//! Layer order in [`crate::app::build_app`] is: Trace outermost, then CSRF,
//! then Auth. Allowlist predicate is shared so the two layers agree on which
//! routes are pre-auth (and therefore CSRF-exempt).

use axum::extract::{Request, State};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::Response;
use axum_extra::extract::CookieJar;

use castify_auth::SessionId;

use crate::cookies::{extract_session_id, CSRF_COOKIE_NAME, CSRF_HEADER_NAME};
use crate::error::ApiError;
use crate::state::AppState;

/// Predicates for the pre-auth (CSRF- and auth-exempt) `/api/*` routes.
///
/// Order doesn't matter; this is consulted by both middlewares so they agree
/// on which routes are exempt. Non-`/api/` paths are also exempt — they're
/// served by the SPA fallback and have nothing to do with auth.
///
/// Recipient share routes (docs/specs/sharing) are pre-auth by prefix:
/// every GET under `/api/share/` plus the unlock POST. Share handlers do
/// their own per-request validation (token hash, expiry, revocation,
/// unlock) — the prefix rule only decides *session* gating. Note the
/// prefix is `/api/share/` with the trailing slash, so the owner-facing
/// `/api/shares` routes stay session-gated.
pub fn is_pre_auth(method: &Method, path: &str) -> bool {
    if !path.starts_with("/api/") {
        return true;
    }
    if path.starts_with("/api/share/") {
        return matches!(method, &Method::GET) || is_share_unlock_post(method, path);
    }
    matches!(
        (method, path),
        (&Method::GET, "/api/health")
            | (&Method::GET, "/api/setup")
            | (&Method::POST, "/api/setup")
            | (&Method::POST, "/api/session")
    )
}

/// `POST /api/share/{token}/unlock` — the one recipient mutation. Exempt
/// like the `/api/session` login POST: it is itself the credential check
/// (argon2id + rate limit in the handler) and a pre-login CSRF token is
/// unobtainable for a recipient with no session. Any other POST under
/// `/api/share/` fails the predicate and keeps CSRF protection.
fn is_share_unlock_post(method: &Method, path: &str) -> bool {
    matches!(method, &Method::POST)
        && path.starts_with("/api/share/")
        && path.ends_with("/unlock")
        // "/api/share//unlock" would match the prefix/suffix pair with an
        // empty token; a real token is always non-empty (22 chars).
        && path.len() > "/api/share//unlock".len()
}

fn is_mutation(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// Gate `/api/*` on a valid signed session cookie.
///
/// Verifies the cookie's HMAC signature only; it does not check the session
/// row against the database. Handlers needing the resolved owner still call
/// `validate_session` themselves. Revoked or expired sessions are therefore
/// still rejected at the handler layer.
pub async fn auth_middleware(
    State(state): State<AppState>,
    jar: CookieJar,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let path = request.uri().path();
    let method = request.method();
    if is_pre_auth(method, path) {
        return Ok(next.run(request).await);
    }

    require_session(&jar, state.session_secret())?;
    Ok(next.run(request).await)
}

/// Require a matching CSRF token header on authenticated mutations.
///
/// Runs *after* [`auth_middleware`] in the request pipeline, so any request
/// reaching us here on a non-allowlisted path already has a valid session.
pub async fn csrf_middleware(
    jar: CookieJar,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let path = request.uri().path();
    let method = request.method();
    if is_pre_auth(method, path) || !is_mutation(method) {
        return Ok(next.run(request).await);
    }

    let cookie_value = jar
        .get(CSRF_COOKIE_NAME)
        .map(|c| c.value().to_string())
        .unwrap_or_default();
    let header_value = request
        .headers()
        .get(CSRF_HEADER_NAME)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    if cookie_value.is_empty() || header_value.is_empty() || cookie_value != header_value {
        return Err(ApiError::ForbiddenCsrf);
    }
    Ok(next.run(request).await)
}

fn require_session(
    jar: &CookieJar,
    secret: &castify_auth::SessionSecret,
) -> Result<SessionId, ApiError> {
    extract_session_id(jar, secret).ok_or(ApiError::Unauthorized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_auth_covers_setup_status_probe() {
        // GET /api/setup is the read-only owner-existence probe used by the
        // SPA's cold-cache router; must be reachable without a session.
        assert!(is_pre_auth(&Method::GET, "/api/setup"));
        // POST /api/setup (first-run setup) stays allowlisted too.
        assert!(is_pre_auth(&Method::POST, "/api/setup"));
    }

    #[test]
    fn pre_auth_excludes_logout() {
        assert!(!is_pre_auth(&Method::DELETE, "/api/session"));
    }

    #[test]
    fn pre_auth_excludes_csrf_endpoint() {
        assert!(!is_pre_auth(&Method::GET, "/api/csrf"));
    }

    #[test]
    fn pre_auth_passes_non_api_paths() {
        assert!(is_pre_auth(&Method::GET, "/"));
        assert!(is_pre_auth(&Method::GET, "/login"));
    }

    #[test]
    fn pre_auth_covers_recipient_share_gets_by_prefix() {
        // Resolve/items/mirrors (and any deeper GET under the prefix, like
        // transcode segments) are reachable without a session.
        assert!(is_pre_auth(&Method::GET, "/api/share/abc123"));
        assert!(is_pre_auth(&Method::GET, "/api/share/abc123/items"));
        assert!(is_pre_auth(
            &Method::GET,
            "/api/share/abc123/transcode/720p/segment1.ts"
        ));
    }

    #[test]
    fn pre_auth_covers_only_the_unlock_post_on_shares() {
        assert!(is_pre_auth(
            &Method::POST,
            "/api/share/abc123/unlock"
        ));
        // Any other recipient POST stays gated...
        assert!(!is_pre_auth(&Method::POST, "/api/share/abc123/items"));
        assert!(!is_pre_auth(&Method::POST, "/api/share/abc123"));
        // ...including the degenerate empty-token form.
        assert!(!is_pre_auth(&Method::POST, "/api/share//unlock"));
    }

    #[test]
    fn pre_auth_keeps_owner_shares_routes_session_gated() {
        // `/api/share/` (trailing slash) must not swallow `/api/shares`.
        assert!(!is_pre_auth(&Method::GET, "/api/shares"));
        assert!(!is_pre_auth(&Method::POST, "/api/shares"));
        assert!(!is_pre_auth(&Method::DELETE, "/api/shares/42"));
    }
}
