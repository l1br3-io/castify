//! Provider connection lifecycle endpoints.
//!
//!   * `GET  /api/connections`              — list active connections
//!   * `GET  /api/connections/available`     — which providers are configured
//!   * `POST /api/connections/{provider}/start`    — initiate OAuth flow
//!   * `GET  /api/connections/{provider}/callback` — OAuth callback
//!   * `DELETE /api/connections/{id}`        — disconnect a provider (soft-delete)
//!   * `POST /api/connections/{id}/scan`     — trigger a rescan (202/409)
//!   * `GET  /api/connections/{id}/scan`     — scan status JSON

use std::time::Instant;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use castify_catalog::{redirect_uri, NewConnection, OAuthStateEntry, PkceChallenge, Provider};

use crate::auth::resolve_owner;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CallbackParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Query params for `POST /api/connections/{provider}/start`.
///
/// `return_to` is an optional relative path the browser should land on after
/// the OAuth round-trip (e.g. `/watch/v1` when the user kicked off a reconnect
/// from the watch page's "Try again" button). Validated to a server-relative
/// path (starts with `/`, no scheme/host) to prevent open-redirect abuse —
/// anything failing validation is silently dropped, falling back to the
/// default `/connections?connected={provider}` redirect.
#[derive(Debug, Default, Deserialize)]
pub struct StartParams {
    pub return_to: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartResponse {
    pub auth_url: String,
}

#[derive(Debug, Serialize)]
pub struct ConnectionDto {
    pub id: String,
    pub provider: String,
    pub provider_account_email: Option<String>,
    pub connected_at: String,
    pub scan_status: String,
    pub last_scan_at: Option<String>,
    pub video_count: i64,
}

#[derive(Debug, Serialize)]
pub struct AvailableProviders {
    pub google_drive: bool,
    pub dropbox: bool,
    pub onedrive: bool,
}

/// Scan status returned by `GET /api/connections/{id}/scan` (FR-7.3).
#[derive(Debug, Serialize)]
pub struct ScanStatusDto {
    pub status: String,
    pub videos_found: i64,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error_message: Option<String>,
}

impl ScanStatusDto {
    fn from_scan_state(state: Option<castify_catalog::ScanState>) -> Self {
        match state {
            Some(s) => Self {
                status: s.status.as_str().to_string(),
                videos_found: s.videos_found,
                started_at: s.started_at,
                completed_at: s.completed_at,
                error_message: s.error_message,
            },
            None => Self {
                status: "idle".into(),
                videos_found: 0,
                started_at: None,
                completed_at: None,
                error_message: None,
            },
        }
    }
}

pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Vec<ConnectionDto>>> {
    let repo = state.catalog_repository();
    let connections = repo.list_active_connections().await?;
    let mut dtos = Vec::with_capacity(connections.len());
    for conn in connections {
        let scan = repo.fetch_scan_state(&conn.id).await?;
        let video_count = repo.video_count_by_connection(&conn.id).await?;
        dtos.push(ConnectionDto {
            id: conn.id,
            provider: conn.provider.to_string(),
            provider_account_email: conn.provider_account_email,
            connected_at: conn.connected_at,
            scan_status: scan
                .as_ref()
                .map(|s| s.status.as_str().to_string())
                .unwrap_or_else(|| "idle".into()),
            last_scan_at: scan.and_then(|s| s.completed_at),
            video_count,
        });
    }
    Ok(Json(dtos))
}

pub async fn available(State(state): State<AppState>) -> Json<AvailableProviders> {
    let reg = state.provider_registry();
    Json(AvailableProviders {
        google_drive: reg.is_configured(Provider::GoogleDrive),
        dropbox: reg.is_configured(Provider::Dropbox),
        onedrive: reg.is_configured(Provider::OneDrive),
    })
}

pub async fn start(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(provider_str): Path<String>,
    Query(params): Query<StartParams>,
) -> ApiResult<Json<StartResponse>> {
    let provider = parse_provider(&provider_str)?;
    let factory = state
        .provider_registry()
        .factory_for(provider)
        .ok_or_else(|| not_configured(provider))?;
    let base_url = state.config().app_base_url.as_deref().ok_or_else(|| {
        ApiError::ServiceUnavailable("CASTIFY_APP_BASE_URL is required for OAuth".into())
    })?;

    let owner = resolve_owner(&state, &jar).await?;

    let pkce = PkceChallenge::generate();
    let state_param = castify_catalog::oauth::generate_state();
    let redir = redirect_uri(base_url, &provider);

    let auth_url = factory.authorization_url(&redir, &state_param, &pkce.challenge);

    let return_to = sanitize_return_to(params.return_to);

    state.oauth_store().insert(
        state_param,
        OAuthStateEntry {
            provider,
            owner_id: owner.id.clone(),
            pkce_verifier: pkce.verifier,
            created_at: Instant::now(),
            return_to,
        },
    );

    Ok(Json(StartResponse { auth_url }))
}

/// Validate that `return_to` is a safe server-relative path. Rejects
/// anything that isn't `/`-prefixed (so `//evil.com/...` and
/// `https://evil.com/` can't be smuggled into a redirect), and strips any
/// `?`/`#` so callers can't forge provider banners via query strings.
/// Returns `None` when the input is missing or fails validation.
fn sanitize_return_to(raw: Option<String>) -> Option<String> {
    let path = raw?;
    if !path.starts_with('/') || path.starts_with("//") {
        tracing::warn!(return_to = %path, "rejecting open-redirect return_to");
        return None;
    }
    // Strip query/fragment — the callback appends its own success/error
    // indicators, and an attacker-supplied `?connected=...` could spoof the
    // Connections-page banner.
    let stripped = path.split(['?', '#']).next().unwrap_or(&path);
    if stripped.is_empty() || stripped == "/" {
        // "/" alone is fine for a generic "back to app" landing, but offers
        // no recovery context — treat as "no preference, use default".
        return None;
    }
    Some(stripped.to_string())
}

pub async fn callback(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(provider_str): Path<String>,
    Query(params): Query<CallbackParams>,
) -> Response {
    match callback_inner(&state, &jar, &provider_str, &params).await {
        Ok((provider, return_to)) => {
            // Honor a caller-supplied return path (e.g. the watch page's
            // "Try again" → reconnect flow). Tag it with a success banner
            // param so the landing route can surface "Reconnected" UX.
            let dest = match return_to {
                Some(path) => format!("{path}?reconnected={provider}"),
                None => format!("/connections?connected={provider}"),
            };
            Redirect::to(&dest).into_response()
        }
        Err(msg) => {
            tracing::warn!(error = %msg, "OAuth callback failed");
            Redirect::to(callback_error_redirect(&msg)).into_response()
        }
    }
}

/// Build the redirect target for a failed OAuth callback. Most failures
/// collapse to the generic `oauth_failed` banner; the structured
/// `account_id_missing` sentinel gets its own code so the Connections page
/// can surface a more specific message ("provider did not return an
/// account identifier — reconnect refused to avoid orphaning the library").
///
/// Extracted as a pure helper so the redirect-code contract is testable
/// without driving the full async callback flow.
fn callback_error_redirect(msg: &str) -> &'static str {
    if msg == ACCOUNT_ID_MISSING {
        "/connections?error=account_id_missing"
    } else {
        "/connections?error=oauth_failed"
    }
}

/// Sentinel `callback_inner` returns when `fetch_user_info` yields no
/// `account_id`. Kept as a constant so `callback_error_redirect` and the
/// guard stay in sync without magic-string drift.
const ACCOUNT_ID_MISSING: &str = "account_id_missing";

async fn callback_inner(
    state: &AppState,
    jar: &CookieJar,
    provider_str: &str,
    params: &CallbackParams,
) -> Result<(Provider, Option<String>), String> {
    let provider = parse_provider(provider_str).map_err(|e| e.to_string())?;

    if let Some(err) = &params.error {
        return Err(format!("provider returned error: {err}"));
    }

    let code = params.code.as_deref().ok_or("missing code parameter")?;
    let state_param = params.state.as_deref().ok_or("missing state parameter")?;

    let entry = state
        .oauth_store()
        .take(state_param)
        .ok_or("invalid or expired OAuth state")?;

    if entry.provider != provider {
        return Err("provider mismatch in OAuth state".into());
    }

    let owner = resolve_owner(state, jar)
        .await
        .map_err(|_| "session expired during OAuth flow".to_string())?;

    if entry.owner_id != owner.id {
        return Err("owner mismatch in OAuth state".into());
    }

    let base_url = state
        .config()
        .app_base_url
        .as_deref()
        .ok_or("CASTIFY_APP_BASE_URL not set")?;

    let redir = redirect_uri(base_url, &provider);
    let factory = state
        .provider_registry()
        .factory_for(provider)
        .ok_or_else(|| format!("{provider} credentials no longer configured"))?;
    let token_bundle = factory
        .exchange_code(code, &entry.pkce_verifier, &redir)
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;
    let (account_id, account_email) = factory
        .fetch_user_info(&token_bundle)
        .await
        .map_err(|e| format!("failed to fetch user info: {e}"))?;

    // If the provider returned no account_id, the upsert lookup below is
    // skipped (it requires a non-null account_id) and the fresh-insert
    // path would create a duplicate active row — SQLite's UNIQUE allows
    // multiple NULLs, so the insert succeeds but the user's library
    // stays orphaned on the dead-token connection. Refuse rather than
    // silently split the library. Cannot happen with the current Google
    // Drive / Dropbox / OneDrive factories (all guarantee Some), but
    // guards against future regressions and direct DB edits.
    if account_id.is_none() {
        return Err(ACCOUNT_ID_MISSING.into());
    }

    let repo = state.catalog_repository();

    // Reconnect path: if the same `(provider, account_id)` is already
    // connected, treat this as a token rotation on the existing row rather
    // than a brand-new connection. This preserves the video library +
    // stable connection_id, which matters for the watch page's "Try again"
    // flow (the cached `reauth_required` error is invalidated client-side,
    // the live token rotates server-side, playback resumes on the same URL
    // without the user losing their place in the catalog).
    if let Some(account_id) = account_id.as_deref() {
        if let Some(existing) = repo
            .find_active_connection_by_account(provider, account_id)
            .await
            .map_err(|e| format!("failed to look up existing connection: {e}"))?
        {
            tracing::info!(
                connection_id = %existing.id,
                %provider,
                %account_id,
                "reconnect: rotating token on existing connection"
            );
            repo.update_token_bundle(&existing.id, &token_bundle)
                .await
                .map_err(|e| format!("failed to update token: {e}"))?;
            // A reconnect invalidates any cached provider-side metadata
            // (Drive file IDs are stable, but the user might have
            // re-granted after shrinking scope). Kick off a fresh scan so
            // the catalog reflects the current grant.
            spawn_scan(state, &existing.id, provider);
            return Ok((provider, entry.return_to));
        }

        // Revive path (FR-2.1): no active connection, but a soft-deleted row
        // for the same (provider, account_id) exists. Revive it in place —
        // clear `disconnected_at`, rotate the token, rescan. The connection
        // id and every video UUID are preserved because the row was never
        // hard-deleted, so rescans hit `ON CONFLICT DO UPDATE` which omits
        // `id`. The `UNIQUE(provider, provider_account_id)` constraint makes
        // revive mandatory here: a fresh insert would violate it while the
        // soft-deleted row exists. The `disconnected_at` guard documents the
        // invariant — after the active-lookup miss above, any row found here
        // must be soft-deleted (UNIQUE ensures at most one row per pair).
        if let Some(existing) = repo
            .find_connection_by_account(provider, account_id)
            .await
            .map_err(|e| format!("failed to look up connection for revive: {e}"))?
        {
            if existing.disconnected_at.is_some() {
                tracing::info!(
                    connection_id = %existing.id,
                    %provider,
                    %account_id,
                    "reconnect: reviving soft-deleted connection"
                );
                repo.revive_connection(&existing.id)
                    .await
                    .map_err(|e| format!("failed to revive connection: {e}"))?;
                repo.update_token_bundle(&existing.id, &token_bundle)
                    .await
                    .map_err(|e| format!("failed to update token: {e}"))?;
                spawn_scan(state, &existing.id, provider);
                return Ok((provider, entry.return_to));
            }
        }
    }

    // Fresh-connect path: insert a new row, spawn the initial scan.
    let conn = state
        .catalog_repository()
        .create_connection(&NewConnection {
            provider,
            token_bundle,
            provider_account_id: account_id,
            provider_account_email: account_email,
        })
        .await
        .map_err(|e| format!("failed to store connection: {e}"))?;

    spawn_scan(state, &conn.id, provider);

    Ok((provider, entry.return_to))
}

pub async fn disconnect(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let repo = state.catalog_repository();

    let conn = repo
        .fetch_connection(&id)
        .await?
        .ok_or(ApiError::NotFound)?;

    if let Some(bundle) = repo.fetch_token_bundle(&id).await? {
        if let Some(factory) = state.provider_registry().factory_for(conn.provider) {
            let _ = factory.revoke(&bundle).await;
        }
    }

    // Soft-delete (FR-1.1): set `disconnected_at`, revoke the token best-effort
    // (above), but keep the row, its videos, and all dependent data so a
    // same-account reconnect revives the connection in place (lossless). The
    // catalog visibility layer (Task 2) hides the videos while disconnected.
    repo.disconnect(&conn.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/connections/{id}/scan` — trigger a manual rescan.
///
/// Returns 202 Accepted if the scan was started, or 409 Conflict if a scan is
/// already in progress. The scan runs in a background task; progress is visible
/// via `GET /api/connections/{id}/scan` or the `scan_status` field on
/// `GET /api/connections`.
pub async fn trigger_rescan(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let repo = state.catalog_repository();

    let conn = repo
        .fetch_connection(&id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let scan = repo.fetch_scan_state(&id).await?;
    if let Some(ref s) = scan {
        if s.status == castify_catalog::ScanStatus::Scanning {
            return Err(ApiError::Conflict(
                "a scan is already in progress for this connection".into(),
            ));
        }
    }

    spawn_scan(&state, &conn.id, conn.provider);
    Ok(StatusCode::ACCEPTED)
}

/// `GET /api/connections/{id}/scan` — current scan status for a connection.
///
/// Returns the scan state: status (`idle`/`scanning`/`error`), videos found,
/// timestamps, and error message if any. If no scan has been run yet, returns
/// a default `idle` status.
pub async fn scan_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<ScanStatusDto>> {
    let repo = state.catalog_repository();

    repo.fetch_connection(&id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let scan = repo.fetch_scan_state(&id).await?;
    Ok(Json(ScanStatusDto::from_scan_state(scan)))
}

fn parse_provider(s: &str) -> ApiResult<Provider> {
    Provider::parse(s).map_err(|e| ApiError::Validation { detail: e })
}

fn not_configured(provider: Provider) -> ApiError {
    ApiError::ServiceUnavailable(format!("{provider} not configured"))
}

fn spawn_scan(state: &AppState, connection_id: &str, provider: Provider) {
    let repo = state.catalog_repository().clone();
    let conn_id = connection_id.to_string();

    let factory = match state.factory_for(provider) {
        Some(f) => f,
        None => {
            tracing::warn!("{provider} not configured, skipping scan");
            return;
        }
    };

    tokio::spawn(async move {
        castify_catalog::scanner::run_scan(repo, conn_id, provider, factory).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Relative path inside the app passes the sanitizer unchanged (minus any
    /// query/fragment — those get appended by the callback).
    #[test]
    fn sanitize_return_to_accepts_relative_path() {
        assert_eq!(
            sanitize_return_to(Some("/watch/v1".into())).as_deref(),
            Some("/watch/v1")
        );
        assert_eq!(
            sanitize_return_to(Some("/watch/v1?connected=google_drive".into())).as_deref(),
            Some("/watch/v1"),
            "caller-supplied query must be stripped (callback appends its own)"
        );
        assert_eq!(
            sanitize_return_to(Some("/watch/v1#frag".into())).as_deref(),
            Some("/watch/v1"),
            "fragments stripped for the same reason"
        );
    }

    /// `None` and empty inputs pass through as `None` (caller falls back to
    /// the default `/connections?connected=...` redirect).
    #[test]
    fn sanitize_return_to_passes_none_through() {
        assert!(sanitize_return_to(None).is_none());
        assert!(
            sanitize_return_to(Some("".into())).is_none(),
            "empty string is not a usable destination"
        );
    }

    /// Bare `/` is rejected — it offers no recovery context (the user lands
    /// on the home page with no indication of what just happened), so fall
    /// back to the default `/connections?connected=...` which surfaces the
    /// success banner.
    #[test]
    fn sanitize_return_to_rejects_bare_root() {
        assert!(sanitize_return_to(Some("/".into())).is_none());
    }

    /// Open-redirect hardening: anything that could be interpreted by the
    /// browser as a cross-origin URL must be rejected. Covers the standard
    /// evasion patterns (`//host`, `/\host`, scheme-relative, absolute URL).
    #[test]
    fn sanitize_return_to_rejects_open_redirect_attempts() {
        let rejects = [
            "//evil.com/path",       // scheme-relative
            "https://evil.com/path", // absolute URL
            "http://evil.com",       // absolute URL, http
            "javascript:alert(1)",   // harmless here (no leading /) but
            // documented as rejected
            "watch/v1", // relative, no leading slash
        ];
        for raw in rejects {
            assert!(
                sanitize_return_to(Some(raw.into())).is_none(),
                "should reject open-redirect attempt: {raw:?}"
            );
        }
    }

    /// The structured `account_id_missing` sentinel maps to a distinct
    /// redirect target so the Connections page can surface a specific
    /// "the provider returned no account_id" banner rather than the generic
    /// "OAuth failed" message.
    #[test]
    fn callback_error_redirect_distinguishes_account_id_missing() {
        assert_eq!(
            callback_error_redirect("account_id_missing"),
            "/connections?error=account_id_missing"
        );
    }

    /// Any other error string collapses to the generic `oauth_failed`
    /// redirect — preserving the existing behavior for malformed codes,
    /// token-exchange failures, state mismatch, etc.
    #[test]
    fn callback_error_redirect_collapses_unknown_errors_to_oauth_failed() {
        assert_eq!(
            callback_error_redirect("token exchange failed: invalid_grant"),
            "/connections?error=oauth_failed"
        );
        assert_eq!(
            callback_error_redirect("invalid or expired OAuth state"),
            "/connections?error=oauth_failed"
        );
        assert_eq!(
            callback_error_redirect("provider returned error: access_denied"),
            "/connections?error=oauth_failed"
        );
    }
}
