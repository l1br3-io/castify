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
/// Share unlock cookie (sharing). One name for all shares: the
/// signed payload carries the share id, so a cookie can only ever vouch
/// for the share it was minted for. Written by the unlock endpoint.
pub const SHARE_UNLOCK_COOKIE_NAME: &str = "castify_share_unlock";
const SESSION_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const CSRF_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const CSRF_TOKEN_BYTES: usize = 32;
/// Browser-side lifetime of the unlock cookie. Mirrors the server-side
/// 24h rolling TTL in `shares::token::UNLOCK_TTL_HOURS` — the server
/// re-validates `issued_at` per request anyway, so this attribute is a
/// hint that keeps dead cookies out of later requests.
const SHARE_UNLOCK_TTL_SECONDS: i64 = 24 * 60 * 60;

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

/// Read and verify a share unlock cookie, recovering the share it unlocks
/// (sharing). `None` when absent, empty, or failing HMAC/payload
/// verification — callers treat `None` as "locked", never as an error: a
/// tampered cookie is indistinguishable from no cookie at this layer.
///
/// Like [`extract_session_id`], this verifies the signature only. Whether
/// the unlock is still *meaningful* (share not revoked/expired, cookie
/// within its TTL, share id matches) is re-decided per request by
/// `shares::status::resolve_share_state` — the cookie alone is never
/// authority.
pub fn extract_share_unlock(
    jar: &CookieJar,
    secret: &SessionSecret,
) -> Option<crate::shares::token::VerifiedUnlock> {
    let raw = jar.get(SHARE_UNLOCK_COOKIE_NAME)?.value();
    if raw.is_empty() {
        return None;
    }
    crate::shares::token::verify_unlock_value(secret, raw).ok()
}

/// Build the share unlock cookie (sharing, task 004).
///
/// Attributes mirror [`build_session_cookie`] (HttpOnly, SameSite=Lax,
/// `Secure` in prod) with one deliberate difference: `Path=/api/share/`
/// scopes it to the recipient surface, so the unlock never travels on
/// owner routes or the SPA's session-authenticated API calls. The
/// browser-side max-age is the 24h rolling TTL capped at the share's own
/// `expires_at`, so the cookie dies with the share even client-side.
pub fn build_share_unlock_cookie(
    value: &str,
    share_expires_at: Option<&str>,
    config: &castify_core::Config,
) -> Cookie<'static> {
    let max_age_secs = share_expires_at
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|expiry| (expiry.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_seconds())
        .map(|seconds_left| seconds_left.clamp(1, SHARE_UNLOCK_TTL_SECONDS))
        .unwrap_or(SHARE_UNLOCK_TTL_SECONDS);

    let mut cookie = Cookie::build((SHARE_UNLOCK_COOKIE_NAME, value.to_string()));
    cookie = cookie
        .path("/api/share/")
        .same_site(SameSite::Lax)
        .http_only(true)
        .max_age(cookie::time::Duration::seconds(max_age_secs));
    if config.cookie_secure {
        cookie = cookie.secure(true);
    }
    cookie.build()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn config(cookie_secure: bool) -> castify_core::Config {
        let data_dir = std::env::temp_dir().join("castify-cookie-tests");
        castify_core::Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            log_level: "warn".into(),
            data_dir: data_dir.clone(),
            database_path: data_dir.join("db.sqlite3"),
            app_base_url: None,
            cookie_secure,
            google_oauth: None,
            dropbox_oauth: None,
            microsoft_oauth: None,
            video_cache: castify_core::VideoCacheConfig {
                enabled: false,
                max_bytes: 0,
                dir: data_dir.join("video-cache"),
            },
            probe: castify_core::ProbeConfig::default(),
            transcode: castify_core::TranscodeConfig::default(),
            abr: castify_core::AbrConfig::default(),
            prune: castify_core::PruneConfig::default(),
        }
    }

    #[test]
    fn share_unlock_cookie_mirrors_session_attributes_scoped_to_share_paths() {
        let cookie = build_share_unlock_cookie("signed-value", None, &config(false));
        assert_eq!(cookie.name(), SHARE_UNLOCK_COOKIE_NAME);
        assert_eq!(cookie.value(), "signed-value");
        assert_eq!(cookie.path(), Some("/api/share/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert_eq!(cookie.secure(), None, "no Secure flag in dev");
        assert_eq!(
            cookie.max_age().map(|d| d.whole_seconds()),
            Some(SHARE_UNLOCK_TTL_SECONDS),
            "no share expiry → full 24h"
        );

        let secure = build_share_unlock_cookie("v", None, &config(true));
        assert_eq!(secure.secure(), Some(true), "Secure in prod");
    }

    #[test]
    fn share_unlock_cookie_ttl_is_capped_at_share_expiry() {
        // Share expiring in ~1h: max-age collapses to ~3600s (±2s slack
        // for the wall-clock read between building and asserting).
        let expiry = (chrono::Utc::now() + chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let cookie = build_share_unlock_cookie("v", Some(&expiry), &config(false));
        let secs = cookie.max_age().unwrap().whole_seconds();
        assert!(
            (3598..=3602).contains(&secs),
            "capped at time-to-expiry, got {secs}s"
        );

        // Share expiring far in the future: full 24h.
        let far = (chrono::Utc::now() + chrono::Duration::days(30))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let cookie = build_share_unlock_cookie("v", Some(&far), &config(false));
        assert_eq!(
            cookie.max_age().unwrap().whole_seconds(),
            SHARE_UNLOCK_TTL_SECONDS
        );
    }
}
