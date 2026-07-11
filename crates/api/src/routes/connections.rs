//! Provider connection lifecycle endpoints.
//!
//!   * `GET  /api/connections`              — list active connections
//!   * `GET  /api/connections/available`     — which providers are configured
//!   * `POST /api/connections/{provider}/start`    — initiate OAuth flow
//!   * `GET  /api/connections/{provider}/callback` — OAuth callback
//!   * `DELETE /api/connections/{id}`        — disconnect a provider
//!   * `POST /api/connections/{id}/scan`     — trigger a rescan (202/409)
//!   * `GET  /api/connections/{id}/scan`     — scan status JSON

use std::time::Instant;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use castify_catalog::provider::ProviderFactory;
use castify_catalog::{
    redirect_uri, NewConnection, OAuthStateEntry, PkceChallenge, Provider,
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

    state.oauth_store().insert(
        state_param,
        OAuthStateEntry {
            provider,
            owner_id: owner.id.clone(),
            pkce_verifier: pkce.verifier,
            created_at: Instant::now(),
        },
    );

    Ok(Json(StartResponse { auth_url }))
}

pub async fn callback(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(provider_str): Path<String>,
    Query(params): Query<CallbackParams>,
) -> Response {
    match callback_inner(&state, &jar, &provider_str, &params).await {
        Ok(provider) => Redirect::to(&format!("/connections?connected={provider}")).into_response(),
        Err(msg) => {
            tracing::warn!(error = %msg, "OAuth callback failed");
            Redirect::to("/connections?error=oauth_failed").into_response()
        }
    }
}

async fn callback_inner(
    state: &AppState,
    jar: &CookieJar,
    provider_str: &str,
    params: &CallbackParams,
) -> Result<Provider, String> {
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

    Ok(provider)
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

    repo.delete_connection(&conn.id).await?;
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

    let factory = match build_factory(state, provider) {
        Some(f) => f,
        None => return,
    };

    tokio::spawn(async move {
        castify_catalog::scanner::run_scan(repo, conn_id, provider, factory).await;
    });
}

/// Construct the provider factory for a scan task.
///
/// When the `e2e` feature is enabled, returns a mock factory that serves
/// canned video listings — allowing the full scan → catalog → dedup pipeline
/// to run without real OAuth credentials or external API access.
#[cfg(feature = "e2e")]
fn build_factory(_state: &AppState, provider: Provider) -> Option<Box<dyn ProviderFactory>> {
    Some(Box::new(crate::e2e::E2eMockFactory::new(provider)))
}

#[cfg(not(feature = "e2e"))]
fn build_factory(state: &AppState, provider: Provider) -> Option<Box<dyn ProviderFactory>> {
    let factory = state.provider_registry().factory_for(provider);
    if factory.is_none() {
        tracing::warn!("{provider} not configured, skipping scan");
    }
    factory
}
