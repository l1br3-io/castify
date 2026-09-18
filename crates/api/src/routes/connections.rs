//! Provider connection lifecycle endpoints.
//!
//!   * `GET  /api/connections`              — list active connections
//!   * `GET  /api/connections/available`     — which providers are configured
//!   * `POST /api/connections/s3`            — credentials-form connect (S3)
//!   * `POST /api/connections/{provider}/start`    — initiate OAuth flow
//!   * `GET  /api/connections/{provider}/callback` — OAuth callback
//!   * `DELETE /api/connections/{id}`        — disconnect a provider (soft-delete)
//!   * `POST /api/connections/{id}/scan`     — trigger a rescan (202/409)
//!   * `GET  /api/connections/{id}/scan`     — scan status JSON

use std::net::{IpAddr, Ipv6Addr};
use std::time::Instant;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use castify_catalog::{
    redirect_uri, CatalogRepository, ConnectFlow, Credential, NewConnection, OAuthStateEntry,
    PkceChallenge, Provider, ProviderConnection, S3Credentials,
};

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

/// Body of `POST /api/connections/s3` — the credentials form. Keys mirror
/// the S3 `CredentialsSchema` field keys (the frontend renders the schema
/// and submits exactly these names). `prefix` is optional; everything
/// else is required and non-blank.
#[derive(Debug, Deserialize)]
pub struct S3ConnectRequest {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub prefix: Option<String>,
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
    /// Rows the last completed scan pruned — the connections-page rescan
    /// toast reports these ("Rescanned — 3 videos removed").
    pub videos_pruned: i64,
    pub files_pruned: i64,
}

/// One entry in the `GET /api/connections/available` listing. `authMode` is
/// camelCase — the one non-snake_case key in the API, pinned by the
/// s3-compatible-storage spec's wire contract. `configured` reports
/// server-level setup (OAuth env vars); credential-based providers are
/// always configured. `credentials` carries the renderable form schema and
/// is present only on credentials-mode entries (skipped, not nulled, so
/// OAuth entries keep their pre-schema wire shape).
#[derive(Debug, Serialize)]
pub struct AvailableProviderDto {
    pub id: &'static str,
    #[serde(rename = "authMode")]
    pub auth_mode: castify_catalog::AuthMode,
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<castify_catalog::CredentialsSchema>,
}

/// Scan status returned by `GET /api/connections/{id}/scan` (FR-7.3).
#[derive(Debug, Serialize)]
pub struct ScanStatusDto {
    pub status: String,
    pub videos_found: i64,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error_message: Option<String>,
    /// Rows the last completed scan pruned (catalog-prune reconcile).
    pub videos_pruned: i64,
    pub files_pruned: i64,
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
                videos_pruned: s.videos_pruned,
                files_pruned: s.files_pruned,
            },
            None => Self {
                status: "idle".into(),
                videos_found: 0,
                started_at: None,
                completed_at: None,
                error_message: None,
                videos_pruned: 0,
                files_pruned: 0,
            },
        }
    }
}

pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Vec<ConnectionDto>>> {
    let repo = state.catalog_repository();
    let connections = repo.list_active_connections().await?;
    let mut dtos = Vec::with_capacity(connections.len());
    for conn in connections {
        dtos.push(connection_dto(repo, conn).await?);
    }
    Ok(Json(dtos))
}

/// Build the wire DTO for one connection row — scan status + video count
/// alongside the identity fields. Shared by `list` and the S3 connect
/// endpoint's 201 response.
async fn connection_dto(
    repo: &CatalogRepository,
    conn: ProviderConnection,
) -> ApiResult<ConnectionDto> {
    let scan = repo.fetch_scan_state(&conn.id).await?;
    let video_count = repo.video_count_by_connection(&conn.id).await?;
    Ok(ConnectionDto {
        id: conn.id,
        provider: conn.provider.to_string(),
        provider_account_email: conn.provider_account_email,
        connected_at: conn.connected_at,
        scan_status: scan
            .as_ref()
            .map(|s| s.status.as_str().to_string())
            .unwrap_or_else(|| "idle".into()),
        last_scan_at: scan.as_ref().and_then(|s| s.completed_at.clone()),
        video_count,
        videos_pruned: scan.as_ref().map(|s| s.videos_pruned).unwrap_or(0),
        files_pruned: scan.as_ref().map(|s| s.files_pruned).unwrap_or(0),
    })
}

/// `GET /api/connections/available` — one entry per supported provider
/// with its connect-flow kind (`authMode`), server-level configured flag,
/// and — for credentials-flow providers — the schema the frontend renders
/// as a generic form. Credential-based providers (S3) are always
/// configured; OAuth providers depend on env credentials. The frontend
/// uses `authMode` to pick the connect UX (OAuth redirect vs credentials
/// form) and `configured` to hide unconfigured OAuth providers.
pub async fn available(State(state): State<AppState>) -> Json<Vec<AvailableProviderDto>> {
    let reg = state.provider_registry();
    Json(
        Provider::ALL
            .iter()
            .map(|&provider| AvailableProviderDto {
                id: provider.as_str(),
                auth_mode: reg.auth_mode(provider),
                configured: reg.is_configured(provider),
                credentials: reg.credentials_schema(provider),
            })
            .collect(),
    )
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

    // OAuth round-trips only exist for OAuth providers; a credentials-flow
    // provider hitting `/start` is a client bug (the frontend submits the
    // credentials form endpoint instead).
    let flow = match factory.connect_flow() {
        ConnectFlow::OAuth(flow) => flow,
        ConnectFlow::Credentials(_) => {
            return Err(ApiError::Validation {
                detail: format!("{provider} connects via a credentials form, not OAuth"),
            });
        }
    };

    let pkce = PkceChallenge::generate();
    let state_param = castify_catalog::oauth::generate_state();
    let redir = redirect_uri(base_url, &provider);

    let auth_url = flow.authorization_url(&redir, &state_param, &pkce.challenge);

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
    let flow = match factory.connect_flow() {
        ConnectFlow::OAuth(flow) => flow,
        ConnectFlow::Credentials(_) => {
            return Err(format!(
                "{provider} connects via a credentials form, not OAuth"
            ));
        }
    };
    let token_bundle = flow
        .exchange_code(code, &entry.pkce_verifier, &redir)
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;
    let credential = Credential::OAuth(token_bundle);
    // `verify` resolves the account identity through the provider's OAuth
    // flow — the same entry point the credentials-form endpoint uses for
    // static credentials (docs/specs/s3-compatible-storage, task 007).
    let (account_id, account_email) = factory
        .verify(&credential)
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
    let Some(account_id) = account_id else {
        return Err(ACCOUNT_ID_MISSING.into());
    };

    let _conn_id = upsert_connection(state, provider, &account_id, account_email, &credential)
        .await
        .map_err(|e| e.to_string())?;

    Ok((provider, entry.return_to))
}

/// Shared connect tail for both flows (OAuth callback + credentials
/// form): rotate-on-reconnect, revive-on-soft-deleted, else fresh
/// insert — then spawn the initial scan. Keyed on `(provider,
/// account_id)`; returns the connection id.
///
/// Reconnect path: if the same `(provider, account_id)` is already
/// connected, treat this as a credential rotation on the existing row
/// rather than a brand-new connection. This preserves the video library
/// and the stable connection_id, which matters for the watch page's
/// "Try again" flow (the cached `reauth_required` error is invalidated
/// client-side, the live token rotates server-side, playback resumes on
/// the same URL without the user losing their place in the catalog).
///
/// Revive path (FR-2.1): no active connection, but a soft-deleted row
/// for the same (provider, account_id) exists. Revive it in place —
/// clear `disconnected_at`, rotate the credential, rescan. The
/// connection id and every video UUID are preserved because the row was
/// never hard-deleted, so rescans hit `ON CONFLICT DO UPDATE` which
/// omits `id`. The `UNIQUE(provider, provider_account_id)` constraint
/// makes revive mandatory here: a fresh insert would violate it while
/// the soft-deleted row exists. The `disconnected_at` guard documents
/// the invariant — after the active-lookup miss above, any row found
/// here must be soft-deleted (UNIQUE ensures at most one row per pair).
async fn upsert_connection(
    state: &AppState,
    provider: Provider,
    account_id: &str,
    account_email: Option<String>,
    credential: &Credential,
) -> ApiResult<String> {
    let repo = state.catalog_repository();

    if let Some(existing) = repo
        .find_active_connection_by_account(provider, account_id)
        .await?
    {
        tracing::info!(
            connection_id = %existing.id,
            %provider,
            %account_id,
            "reconnect: rotating credentials on existing connection"
        );
        repo.update_credential(&existing.id, credential).await?;
        // A reconnect invalidates any cached provider-side metadata
        // (Drive file IDs are stable, but the user might have re-granted
        // after shrinking scope). Kick off a fresh scan so the catalog
        // reflects the current grant.
        spawn_scan(state, &existing.id, provider);
        return Ok(existing.id);
    }

    if let Some(existing) = repo
        .find_connection_by_account(provider, account_id)
        .await?
    {
        if existing.disconnected_at.is_some() {
            tracing::info!(
                connection_id = %existing.id,
                %provider,
                %account_id,
                "reconnect: reviving soft-deleted connection"
            );
            repo.revive_connection(&existing.id).await?;
            repo.update_credential(&existing.id, credential).await?;
            spawn_scan(state, &existing.id, provider);
            return Ok(existing.id);
        }
    }

    // Fresh-connect path: insert a new row, spawn the initial scan.
    let conn = repo
        .create_connection(&NewConnection {
            provider,
            credential: credential.clone(),
            provider_account_id: Some(account_id.to_string()),
            provider_account_email: account_email,
        })
        .await?;

    spawn_scan(state, &conn.id, provider);

    Ok(conn.id)
}

// ── Credentials-form connect (POST /api/connections/s3) ─────────────

/// A parsed S3 endpoint — scheme + host (+ optional port) with the host
/// normalized (IPv6 brackets stripped). Pure parsing result; range and
/// DNS checks happen in [`validate_s3_endpoint`].
struct ParsedS3Endpoint {
    scheme: &'static str,
    host: String,
    port: Option<u16>,
}

/// Parse `scheme://host[:port]` and nothing else: no path, query,
/// fragment, or userinfo (each is an SSRF vector or an SDK misfeed).
/// IPv6 literals must be bracketed. Pure — unit-testable without DNS.
fn parse_s3_endpoint(raw: &str) -> Result<ParsedS3Endpoint, String> {
    let raw = raw.trim();
    let (scheme, rest) = raw.split_once("://").ok_or_else(|| {
        "endpoint must be scheme://host[:port] (e.g. https://acct.r2.cloudflarestorage.com)"
            .to_string()
    })?;
    let scheme = match scheme.to_ascii_lowercase().as_str() {
        "https" => "https",
        "http" => "http",
        other => {
            return Err(format!(
                "unsupported endpoint scheme {other:?}; use https://"
            ))
        }
    };

    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.len() != rest.len() {
        return Err(
            "endpoint must be scheme://host[:port] with no path, query, or fragment".into(),
        );
    }
    if authority.is_empty() {
        return Err("endpoint host is missing".into());
    }
    if authority.contains('@') {
        return Err("endpoint must not contain userinfo (user:pass@host)".into());
    }

    let host = if let Some(bracketed) = authority.strip_prefix('[') {
        let (v6, after) = bracketed
            .split_once(']')
            .ok_or_else(|| "IPv6 endpoint hosts must be bracketed ([::1])".to_string())?;
        v6.parse::<Ipv6Addr>()
            .map_err(|_| "invalid IPv6 endpoint host".to_string())?
            .to_string();
        if !after.is_empty() {
            let port = after
                .strip_prefix(':')
                .ok_or_else(|| "invalid characters after the IPv6 host".to_string())?;
            port.parse::<u16>()
                .map_err(|_| format!("invalid endpoint port {port:?}"))?;
        }
        v6.to_string()
    } else {
        match authority.rsplit_once(':') {
            Some((h, port)) if !h.contains(':') => {
                port.parse::<u16>()
                    .map_err(|_| format!("invalid endpoint port {port:?}"))?;
                h.to_string()
            }
            Some(_) => {
                return Err(
                    "IPv6 endpoint hosts must be bracketed (https://[2001:db8::1]:9000)".into(),
                )
            }
            None => authority.to_string(),
        }
    };
    if host.is_empty() {
        return Err("endpoint host is missing".into());
    }
    let port = authority
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse::<u16>().ok());

    Ok(ParsedS3Endpoint {
        scheme,
        host: host.to_ascii_lowercase(),
        port,
    })
}

/// Loopback hosts are the local-MinIO allowance: they may use `http://`
/// and are exempt from the private-range rejection (`127/8` and `::1`
/// are loopback literals; `localhost` by name). IPv4-mapped IPv6
/// canonicalizes to its embedded v4 address first — `::ffff:127.0.0.1`
/// is loopback exactly like `127.0.0.1`.
fn host_is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .is_ok_and(|ip| canonical_ip(ip).is_loopback())
}

/// Whether an IP is in globally routable space. Drives the SSRF check:
/// endpoints resolving to private/link-local/loopback/unspecified
/// ranges are rejected (link-local includes 169.254.169.254, the cloud
/// metadata address).
///
/// IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) canonicalize to their
/// embedded v4 address — otherwise the mapped private/metadata forms
/// bypass the range checks (std's v6 predicates don't see through the
/// mapping).
fn is_public_ip(ip: IpAddr) -> bool {
    let ip = canonical_ip(ip);
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast())
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            // fe80::/10 link-local, fc00::/7 unique-local, ::/128, ::1
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xffc0) == 0xfe80
                || (first & 0xfe00) == 0xfc00)
        }
    }
}

/// Canonicalize an IP for range checks: IPv4-mapped IPv6 collapses to
/// plain IPv4 so both spellings of a host land in the same bucket.
fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        IpAddr::V4(_) => ip,
    }
}

/// Validate a user-supplied S3 endpoint (SSRF hardening, spec §5):
/// `https://` required, `http://` only for loopback hosts, and
/// non-loopback hosts — literal or via DNS — must land in public ranges.
/// Returns the trimmed endpoint to store. Connect-time only: this is
/// owner-supplied config for a single-user app, not a per-request proxy
/// target.
async fn validate_s3_endpoint(raw: &str) -> Result<String, ApiError> {
    let parsed = parse_s3_endpoint(raw).map_err(|detail| ApiError::Validation { detail })?;
    let loopback = host_is_loopback(&parsed.host);

    if parsed.scheme == "http" && !loopback {
        return Err(ApiError::Validation {
            detail: "http:// endpoints are only allowed for loopback hosts \
                     (localhost, 127.0.0.1, [::1]); use https://"
                .into(),
        });
    }

    if !loopback {
        if let Ok(ip) = parsed.host.parse::<IpAddr>() {
            if !is_public_ip(ip) {
                return Err(ApiError::Validation {
                    detail: format!(
                        "endpoint host {ip} is in a private or link-local range; \
                         only public hosts are allowed (loopback is the exception)"
                    ),
                });
            }
        } else {
            // DNS name: every resolved address must be public — a single
            // private/link-local record means a rebinding or split-horizon
            // host, which we refuse.
            let addrs = tokio::net::lookup_host((parsed.host.as_str(), parsed.port.unwrap_or(443)))
                .await
                .map_err(|_| ApiError::Validation {
                    detail: format!(
                        "could not resolve endpoint host {:?}; check the endpoint URL",
                        parsed.host
                    ),
                })?;
            for addr in addrs {
                if !is_public_ip(addr.ip()) {
                    return Err(ApiError::Validation {
                        detail: format!(
                            "endpoint host {:?} resolves to private or link-local address {}; \
                             only public hosts are allowed",
                            parsed.host,
                            addr.ip()
                        ),
                    });
                }
            }
        }
    }

    Ok(raw.trim().to_string())
}

/// `POST /api/connections/s3` — credentials-form connect. Auth-required
/// (owner session) like every connections route; the SPA posts the
/// schema-rendered form. Mirrors the OAuth callback's semantics on the
/// shared [`upsert_connection`] tail: fresh insert, rotate-on-reconnect,
/// revive-on-soft-deleted — then a background initial scan.
pub async fn connect_s3(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(payload): Json<S3ConnectRequest>,
) -> ApiResult<(StatusCode, Json<ConnectionDto>)> {
    resolve_owner(&state, &jar).await?;
    let factory = resolve_s3_factory(&state)?;
    connect_s3_inner(&state, payload, factory.as_ref()).await
}

/// The registry always hands out the S3 factory (OQ-3: no server-level
/// config); the `None` arm exists only for symmetry with the OAuth routes.
fn resolve_s3_factory(state: &AppState) -> ApiResult<Box<dyn castify_catalog::ProviderFactory>> {
    state
        .provider_registry()
        .factory_for(Provider::S3Compatible)
        .ok_or_else(|| not_configured(Provider::S3Compatible))
}

/// Credentials-connect core, split from the axum wrapper so tests can
/// drive it with a mock factory against a real repository. Validates the
/// payload and endpoint, verifies via the factory, persists through the
/// encrypted-blob path, and spawns the initial scan. Never echoes
/// secrets — the returned [`ConnectionDto`] carries none by construction.
async fn connect_s3_inner(
    state: &AppState,
    payload: S3ConnectRequest,
    factory: &dyn castify_catalog::ProviderFactory,
) -> ApiResult<(StatusCode, Json<ConnectionDto>)> {
    let required = |raw: String, field: &str| -> ApiResult<String> {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            Err(ApiError::Validation {
                detail: format!("{field} must not be blank"),
            })
        } else {
            Ok(trimmed)
        }
    };

    let endpoint = required(payload.endpoint, "endpoint")?;
    let region = required(payload.region, "region")?;
    let bucket = required(payload.bucket, "bucket")?;
    let access_key_id = required(payload.access_key_id, "access_key_id")?;
    let secret_access_key = required(payload.secret_access_key, "secret_access_key")?;
    let prefix = payload
        .prefix
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());

    let endpoint = validate_s3_endpoint(&endpoint).await?;

    let credential = Credential::S3(S3Credentials {
        endpoint,
        region,
        bucket,
        access_key_id,
        secret_access_key,
        prefix,
    });

    // Verify (HeadBucket + one list page) before anything is persisted —
    // a failure here leaves no connection row behind.
    let (account_id, account_email) = factory
        .verify(&credential)
        .await
        .map_err(map_verify_error)?;
    let account_id = account_id.ok_or_else(|| ApiError::Validation {
        detail: "the provider returned no account identity; connection refused to \
                 avoid orphaning the library"
            .into(),
    })?;

    let conn_id = upsert_connection(
        state,
        Provider::S3Compatible,
        &account_id,
        account_email,
        &credential,
    )
    .await?;

    let conn = state
        .catalog_repository()
        .fetch_connection(&conn_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let dto = connection_dto(state.catalog_repository(), conn).await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

/// Map a verify failure to an actionable 4xx. Bad keys surface as S3
/// 401/403 → `Unauthorized`; a missing bucket as `NotFound`; anything
/// else (unreachable endpoint, throttling, malformed response) keeps the
/// provider's message so the owner can act on it. The default 502
/// mapping would make form mistakes look like server faults.
fn map_verify_error(err: castify_catalog::ProviderError) -> ApiError {
    use castify_catalog::ProviderError;
    let detail = match err {
        ProviderError::Unauthorized => {
            "the object store rejected these credentials — check the access key ID and secret access key".to_string()
        }
        ProviderError::NotFound(what) => format!("bucket not reachable — {what}"),
        other => format!("could not verify the S3 endpoint: {other}"),
    };
    ApiError::Validation { detail }
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

    if let Some(credential) = repo.fetch_credential(&id).await? {
        // Only OAuth credentials carry a revocable grant. Static
        // credentials (S3-compatible storage) have nothing to revoke —
        // keys rotate at the provider's console — and `Provider::revoke`'s
        // default is a documented no-op for exactly that case.
        if let (Some(bundle), Some(factory)) = (
            credential.as_oauth(),
            state.provider_registry().factory_for(conn.provider),
        ) {
            if let Ok(provider) = factory.create(&credential).await {
                let _ = provider.revoke(bundle).await;
            }
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

    let prune_grace = state.config().prune.effective_grace_scans();
    let state = state.clone();

    tokio::spawn(async move {
        let pruned = castify_catalog::scanner::run_scan(
            repo,
            conn_id,
            provider,
            factory,
            castify_catalog::scanner::PrunePolicy {
                effective_grace_scans: prune_grace,
            },
        )
        .await;
        if !pruned.is_empty() {
            cleanup_pruned_video_artifacts(&state, &pruned).await;
        }
    });
}

/// Remove the on-disk artifacts of videos pruned by a completed scan.
/// The catalog rows (and their cascade dependents) are already gone when
/// this runs — this sweeps the bytes the database can't see: transcode
/// output dirs (captured pre-cascade by the repo's prune, since the
/// manifest rows that name them die with the video) and hot-cache files
/// (path derived from the video id). Plan decision: repo owns rows, the
/// api layer owns bytes.
///
/// Best-effort, matching upsert-failure tolerance: a failed removal
/// warns and the scan is never failed by cleanup.
pub async fn cleanup_pruned_video_artifacts(
    state: &AppState,
    pruned: &castify_catalog::PruneResult,
) {
    for dir in &pruned.transcode_output_dirs {
        // GOTCHA: the manifest rows behind these dirs already cascaded
        // away with the video — this is the only remaining record of the
        // bytes. Mirrors evict_transcode_to_target's dir handling.
        let dir = std::path::PathBuf::from(dir);
        if let Err(e) = tokio::fs::remove_dir_all(&dir).await {
            tracing::debug!(
                error = %e,
                dir = %dir.display(),
                "prune cleanup: output_dir removal failed (already gone?)"
            );
        }
    }

    let repo = state.catalog_repository();
    if let Some(cache) = state.video_cache() {
        for video_id in &pruned.video_ids {
            if let Err(e) = repo.delete_video_cache_entry(video_id).await {
                tracing::warn!(
                    error = %e,
                    video_id = video_id,
                    "prune cleanup: cache manifest delete failed"
                );
            }
            if let Err(e) = cache.delete(video_id).await {
                tracing::debug!(
                    error = %e,
                    video_id = video_id,
                    "prune cleanup: cached bytes delete failed (already gone?)"
                );
            }
        }
    }
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

    // ── Task 007: endpoint validator + credentials-connect inner ──────

    use std::net::IpAddr;

    use castify_catalog::{
        CatalogRepository, ListPage, ProviderConnection, ProviderFactory, ProviderResult,
        StreamResponse, ThumbnailData,
    };

    /// `parse_s3_endpoint` accepts https hosts with and without ports.
    #[test]
    fn parse_s3_endpoint_accepts_https() {
        let e = parse_s3_endpoint("https://acct.r2.cloudflarestorage.com").unwrap();
        assert_eq!(e.scheme, "https");
        assert_eq!(e.host, "acct.r2.cloudflarestorage.com");
        assert_eq!(e.port, None);

        let e = parse_s3_endpoint("https://minio.example.com:9000").unwrap();
        assert_eq!(e.host, "minio.example.com");
        assert_eq!(e.port, Some(9000));
    }

    /// Scheme-less endpoints, unknown schemes, paths, query strings, and
    /// userinfo are all rejected — the endpoint is scheme://host[:port]
    /// and nothing else.
    #[test]
    fn parse_s3_endpoint_rejects_malformed_input() {
        for raw in [
            "",
            "acct.r2.cloudflarestorage.com",
            "ftp://example.com",
            "https://",
            "https://example.com/path",
            "https://example.com/?q=1",
            "https://user:pass@example.com",
        ] {
            assert!(
                parse_s3_endpoint(raw).is_err(),
                "should reject endpoint: {raw:?}"
            );
        }
    }

    /// Bracketed IPv6 hosts parse (brackets stripped) and reject a missing
    /// bracket; unbracketed IPv6 is rejected (ambiguous with host:port).
    #[test]
    fn parse_s3_endpoint_handles_ipv6() {
        let e = parse_s3_endpoint("https://[2001:db8::1]:9000").unwrap();
        assert_eq!(e.host, "2001:db8::1");
        assert_eq!(e.port, Some(9000));
        assert!(parse_s3_endpoint("http://[::1]").is_ok());
        assert!(parse_s3_endpoint("http://2001:db8::1").is_err());
        assert!(parse_s3_endpoint("http://[not-an-ip]").is_err());
    }

    /// Ports must be valid u16.
    #[test]
    fn parse_s3_endpoint_rejects_bad_ports() {
        assert!(parse_s3_endpoint("https://example.com:0").is_ok());
        assert!(parse_s3_endpoint("https://example.com:99999").is_err());
        assert!(parse_s3_endpoint("https://example.com:abc").is_err());
    }

    /// Loopback detection drives both the http allowance and the private-
    /// range exemption: `localhost` (case-insensitive), 127.0.0.0/8, ::1.
    /// IPv4-mapped IPv6 (`::ffff:127.0.0.1`) canonicalizes to its v4 form.
    #[test]
    fn host_is_loopback_table() {
        assert!(host_is_loopback("localhost"));
        assert!(host_is_loopback("LOCALHOST"));
        assert!(host_is_loopback("127.0.0.1"));
        assert!(host_is_loopback("127.99.200.1"));
        assert!(host_is_loopback("::1"));
        assert!(host_is_loopback("::ffff:127.0.0.1"));
        assert!(!host_is_loopback("example.com"));
        assert!(!host_is_loopback("10.0.0.1"));
        assert!(!host_is_loopback("169.254.169.254"));
        assert!(!host_is_loopback("localhost.example.com"));
    }

    /// Public-range table: RFC1918 private, link-local (incl. the cloud
    /// metadata address), loopback, unspecified, broadcast, IPv6 ULA and
    /// link-local are all non-public; global v4/v6 literals are public.
    /// IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) canonicalize to their
    /// embedded v4 address — otherwise the mapped private/metadata forms
    /// sail through as "public".
    #[test]
    fn is_public_ip_table() {
        let public = [
            "8.8.8.8",
            "203.0.113.7",
            "1.1.1.1",
            "2001:db8::1",
            "2606:4700::1111",
        ];
        let private = [
            "10.0.0.1",
            "192.168.1.10",
            "172.16.0.1",
            "172.31.255.255",
            "169.254.169.254",
            "127.0.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "fe80::1",
            "fd00::1",
            "fc00::1",
            "::1",
            "::",
            "::ffff:10.0.0.5",
            "::ffff:192.168.1.4",
            "::ffff:169.254.169.254",
            "::ffff:127.0.0.1",
            "::ffff:0.0.0.0",
        ];
        for ip in public {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(is_public_ip(ip), "{ip} should be public");
        }
        for ip in private {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(!is_public_ip(ip), "{ip} should be private/link-local");
        }
    }

    /// `http://` is only allowed for loopback hosts (local MinIO); any other
    /// host must use https.
    #[tokio::test]
    async fn validate_s3_endpoint_http_requires_loopback() {
        assert!(validate_s3_endpoint("http://localhost:9000").await.is_ok());
        assert!(validate_s3_endpoint("http://127.0.0.1:9000").await.is_ok());
        assert!(validate_s3_endpoint("http://[::1]:9000").await.is_ok());
        for raw in [
            "http://example.com",
            "http://minio.internal:9000",
            "http://192.168.1.4:9000",
        ] {
            let err = validate_s3_endpoint(raw).await.unwrap_err();
            let detail = match err {
                ApiError::Validation { detail } => detail,
                other => panic!("expected Validation, got {other:?}"),
            };
            assert!(
                detail.to_lowercase().contains("https")
                    || detail.to_lowercase().contains("loopback"),
                "message should say why http was rejected: {detail}"
            );
        }
    }

    /// SSRF hardening: non-loopback hosts given as IP literals must be in
    /// public ranges; loopback literals are exempt (that's the local-MinIO
    /// allowance).
    #[tokio::test]
    async fn validate_s3_endpoint_rejects_private_literals() {
        for raw in [
            "https://10.0.0.5:9000",
            "https://192.168.1.10",
            "https://172.16.0.1",
            "https://169.254.169.254",
            "https://[fd00::1]",
            "https://[fe80::1]",
            // IPv4-mapped IPv6: the classic SSRF filter bypass — must land
            // in the same rejection bucket as the embedded v4 address.
            "https://[::ffff:10.0.0.5]:9000",
            "https://[::ffff:169.254.169.254]",
            "https://[::ffff:192.168.1.4]",
        ] {
            let err = validate_s3_endpoint(raw).await.unwrap_err();
            match err {
                ApiError::Validation { detail } => {
                    assert!(
                        detail.contains("private") || detail.contains("loopback"),
                        "message should name the range problem: {detail}"
                    );
                }
                other => panic!("expected Validation for {raw}, got {other:?}"),
            }
        }
        assert!(validate_s3_endpoint("https://127.0.0.1:9000").await.is_ok());
        assert!(validate_s3_endpoint("https://[::1]:9000").await.is_ok());
        // Mapped loopback keeps the local-MinIO allowance (http allowed,
        // private-range exempt) exactly like its v4 spelling.
        assert!(validate_s3_endpoint("http://[::ffff:127.0.0.1]:9000")
            .await
            .is_ok());
        assert!(validate_s3_endpoint("https://[::ffff:127.0.0.1]:9000")
            .await
            .is_ok());
    }

    /// A non-loopback DNS name that cannot resolve is a validation error —
    /// actionable at the form, before any S3 request is signed. `.invalid`
    /// is RFC-2606-guaranteed to never resolve, so this makes no network
    /// assumptions beyond "DNS answers".
    #[tokio::test]
    async fn validate_s3_endpoint_rejects_unresolvable_host() {
        let err = validate_s3_endpoint("https://castify-no-such-host.invalid")
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::Validation { .. }));
    }

    // ── connect_s3_inner: mock-factory + real-repository tests ─────────

    /// DB-backed AppState for the inner-handler tests (mirrors
    /// tests/common, kept local so the private inner fn is reachable).
    async fn test_state() -> (AppState, tempfile::TempPath) {
        let named = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let path = named.to_path_buf();
        let pool = castify_storage::connect(&path).await.unwrap();
        castify_storage::run_migrations(&pool).await.unwrap();
        let secret = castify_auth::SessionSecret::resolve(&pool, None)
            .await
            .unwrap();
        let token_key = castify_catalog::TokenKey::resolve(&pool, None)
            .await
            .unwrap();
        let data_dir =
            std::env::temp_dir().join(format!("castify-s3-connect-test-{}", std::process::id()));
        std::fs::create_dir_all(&data_dir).ok();
        let config = crate::Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            log_level: "warn".to_string(),
            data_dir: data_dir.clone(),
            database_path: path.clone(),
            app_base_url: None,
            cookie_secure: false,
            google_oauth: None,
            dropbox_oauth: None,
            microsoft_oauth: None,
            video_cache: castify_core::VideoCacheConfig {
                enabled: false,
                max_bytes: 0,
                dir: data_dir.join("video-cache"),
            },
            probe: Default::default(),
            transcode: Default::default(),
            abr: Default::default(),
            prune: Default::default(),
        };
        (AppState::new(config, pool, secret, token_key).await, named)
    }

    /// What the mock factory's `verify` returns.
    #[derive(Clone, Copy)]
    enum MockVerify {
        Ok,
        NoAccountId,
        Unauthorized,
        NotFound,
    }

    struct MockS3Factory {
        behavior: MockVerify,
    }

    struct NoopProvider;

    #[async_trait::async_trait]
    impl castify_catalog::provider::Provider for NoopProvider {
        fn name(&self) -> &'static str {
            "s3-mock"
        }
        async fn list_videos(&self, _cursor: Option<&str>) -> ProviderResult<ListPage> {
            Ok(ListPage {
                videos: vec![],
                subtitles: vec![],
                files: vec![],
                next_cursor: None,
            })
        }
        async fn fetch_prefix_hash(
            &self,
            _file_id: &str,
            _size: i64,
        ) -> ProviderResult<Option<String>> {
            Ok(None)
        }
        async fn fetch_thumbnail(&self, _file_id: &str) -> ProviderResult<ThumbnailData> {
            Err(castify_catalog::ProviderError::NotFound(
                "mock has no thumbnails".into(),
            ))
        }
        async fn open_stream(
            &self,
            _file_id: &str,
            _range: Option<&str>,
        ) -> ProviderResult<StreamResponse> {
            Err(castify_catalog::ProviderError::NotFound(
                "mock has no streams".into(),
            ))
        }
    }

    #[async_trait::async_trait]
    impl ProviderFactory for MockS3Factory {
        fn name(&self) -> &'static str {
            "s3-mock"
        }
        fn connect_flow(&self) -> castify_catalog::ConnectFlow {
            castify_catalog::ConnectFlow::Credentials(castify_catalog::CredentialsSchema {
                fields: vec![],
            })
        }
        async fn create(
            &self,
            _credential: &Credential,
        ) -> ProviderResult<Box<dyn castify_catalog::provider::Provider>> {
            Ok(Box::new(NoopProvider))
        }
        async fn verify(
            &self,
            _credential: &Credential,
        ) -> ProviderResult<(Option<String>, Option<String>)> {
            match self.behavior {
                MockVerify::Ok => Ok((Some("mock-s3-account".into()), None)),
                MockVerify::NoAccountId => Ok((None, None)),
                MockVerify::Unauthorized => Err(castify_catalog::ProviderError::Unauthorized),
                MockVerify::NotFound => Err(castify_catalog::ProviderError::NotFound(
                    "The specified bucket does not exist".into(),
                )),
            }
        }
    }

    fn s3_payload() -> S3ConnectRequest {
        S3ConnectRequest {
            endpoint: "http://127.0.0.1:9000".into(),
            region: "us-east-1".into(),
            bucket: "media".into(),
            access_key_id: "minioadmin".into(),
            secret_access_key: "minioadmin".into(),
            prefix: None,
        }
    }

    async fn active_connections(repo: &CatalogRepository) -> Vec<ProviderConnection> {
        repo.list_active_connections().await.unwrap()
    }

    /// Valid creds → 201 + ConnectionDto with no secret material anywhere,
    /// and exactly one persisted connection carrying a Credential::S3.
    #[tokio::test]
    async fn connect_s3_inner_persists_and_returns_created_dto() {
        let (state, _guard) = test_state().await;
        let (status, dto) = connect_s3_inner(
            &state,
            s3_payload(),
            &MockS3Factory {
                behavior: MockVerify::Ok,
            },
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(dto.provider, "s3");
        assert!(!dto.id.is_empty());

        // No secret fields anywhere in the serialized response.
        let json = serde_json::to_string(&dto.0).unwrap();
        assert!(
            !json.contains("minioadmin"),
            "response leaked a secret: {json}"
        );
        assert!(
            !json.contains("secret_access_key"),
            "response names a secret field: {json}"
        );
        assert!(
            !json.contains("access_key"),
            "response names a secret field: {json}"
        );

        let conns = active_connections(state.catalog_repository()).await;
        assert_eq!(conns.len(), 1);
        assert_eq!(
            conns[0].provider_account_id.as_deref(),
            Some("mock-s3-account")
        );

        let stored = state
            .catalog_repository()
            .fetch_credential(&conns[0].id)
            .await
            .unwrap()
            .expect("credential row exists");
        match stored {
            Credential::S3(creds) => {
                assert_eq!(creds.endpoint, "http://127.0.0.1:9000");
                assert_eq!(creds.bucket, "media");
                assert_eq!(creds.access_key_id, "minioadmin");
            }
            Credential::OAuth(_) => panic!("s3 connection stored an OAuth credential"),
        }
    }

    /// Reconnecting the same endpoint+bucket (same derived account_id)
    /// rotates the credential on the existing row — no duplicate.
    #[tokio::test]
    async fn connect_s3_inner_rotates_credential_on_reconnect() {
        let (state, _guard) = test_state().await;
        let (_, first) = connect_s3_inner(
            &state,
            s3_payload(),
            &MockS3Factory {
                behavior: MockVerify::Ok,
            },
        )
        .await
        .unwrap();

        let mut second_payload = s3_payload();
        second_payload.secret_access_key = "rotated-secret".into();
        second_payload.access_key_id = "rotated-key".into();
        let (_, second) = connect_s3_inner(
            &state,
            second_payload,
            &MockS3Factory {
                behavior: MockVerify::Ok,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            first.id, second.id,
            "reconnect must reuse the connection row"
        );
        let conns = active_connections(state.catalog_repository()).await;
        assert_eq!(conns.len(), 1, "reconnect must not create a duplicate row");

        let stored = state
            .catalog_repository()
            .fetch_credential(&first.id)
            .await
            .unwrap()
            .unwrap();
        match stored {
            Credential::S3(creds) => {
                assert_eq!(creds.secret_access_key, "rotated-secret");
                assert_eq!(creds.access_key_id, "rotated-key");
            }
            Credential::OAuth(_) => panic!("credential is not S3"),
        }
    }

    /// Soft-deleted connection with the same account id revives in place:
    /// same row id, `disconnected_at` cleared, credential rotated.
    #[tokio::test]
    async fn connect_s3_inner_revives_soft_deleted_connection() {
        let (state, _guard) = test_state().await;
        let (_, first) = connect_s3_inner(
            &state,
            s3_payload(),
            &MockS3Factory {
                behavior: MockVerify::Ok,
            },
        )
        .await
        .unwrap();

        state
            .catalog_repository()
            .disconnect(&first.id)
            .await
            .unwrap();
        assert!(active_connections(state.catalog_repository())
            .await
            .is_empty());

        let (_, revived) = connect_s3_inner(
            &state,
            s3_payload(),
            &MockS3Factory {
                behavior: MockVerify::Ok,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            revived.id, first.id,
            "revive must reuse the soft-deleted row"
        );

        let conn = state
            .catalog_repository()
            .fetch_connection(&first.id)
            .await
            .unwrap()
            .expect("revived row is visible again");
        assert!(conn.disconnected_at.is_none());
        assert_eq!(
            active_connections(state.catalog_repository()).await.len(),
            1
        );
    }

    /// Bad creds → 4xx Validation with an actionable message and nothing
    /// persisted. Unreachable/missing buckets map the same way.
    #[tokio::test]
    async fn connect_s3_inner_verify_failure_persists_nothing() {
        let (state, _guard) = test_state().await;
        for behavior in [MockVerify::Unauthorized, MockVerify::NotFound] {
            let err = connect_s3_inner(&state, s3_payload(), &MockS3Factory { behavior })
                .await
                .unwrap_err();
            match &err {
                ApiError::Validation { detail } => {
                    assert!(!detail.is_empty(), "error must be actionable: {err:?}");
                }
                other => panic!("expected Validation, got {other:?}"),
            }
            assert!(
                active_connections(state.catalog_repository())
                    .await
                    .is_empty(),
                "no connection row may be persisted on verify failure"
            );
        }
    }

    /// Missing/blank required fields are rejected before verify runs.
    #[tokio::test]
    async fn connect_s3_inner_rejects_blank_fields() {
        let (state, _guard) = test_state().await;
        for blank in [
            "endpoint",
            "region",
            "bucket",
            "access_key_id",
            "secret_access_key",
        ] {
            let mut payload = s3_payload();
            match blank {
                "endpoint" => payload.endpoint = "   ".into(),
                "region" => payload.region = "".into(),
                "bucket" => payload.bucket = "".into(),
                "access_key_id" => payload.access_key_id = "".into(),
                _ => payload.secret_access_key = "".into(),
            }
            let err = connect_s3_inner(
                &state,
                payload,
                &MockS3Factory {
                    behavior: MockVerify::Ok,
                },
            )
            .await
            .unwrap_err();
            match err {
                ApiError::Validation { detail } => {
                    assert!(
                        detail.contains(blank),
                        "message should name the field: {detail}"
                    );
                }
                other => panic!("expected Validation, got {other:?}"),
            }
        }
        assert!(active_connections(state.catalog_repository())
            .await
            .is_empty());
    }

    /// A verify result without an account id refuses to connect (mirrors
    /// the OAuth callback's ACCOUNT_ID_MISSING guard): a fresh insert with
    /// a NULL account id would orphan the library on reconnect.
    #[tokio::test]
    async fn connect_s3_inner_refuses_missing_account_id() {
        let (state, _guard) = test_state().await;
        let err = connect_s3_inner(
            &state,
            s3_payload(),
            &MockS3Factory {
                behavior: MockVerify::NoAccountId,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::Validation { .. }));
        assert!(active_connections(state.catalog_repository())
            .await
            .is_empty());
    }
}
