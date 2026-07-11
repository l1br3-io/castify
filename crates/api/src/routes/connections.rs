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

use castify_auth::AuthError;
use castify_catalog::provider::ProviderFactory;
use castify_catalog::providers::dropbox::{DropboxClient, DropboxConfig, DropboxFactory};
use castify_catalog::providers::google_drive::{
    GoogleDriveClient, GoogleDriveConfig, GoogleDriveFactory,
};
use castify_catalog::providers::onedrive::{OneDriveClient, OneDriveConfig, OneDriveFactory};
use castify_catalog::{
    redirect_uri, NewConnection, OAuthStateEntry, PkceChallenge, Provider, TokenBundle,
};

use crate::cookies::extract_session_id;
use crate::dto::OwnerDto;
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
    let config = state.config();
    Json(AvailableProviders {
        google_drive: config.google_oauth.is_some(),
        dropbox: config.dropbox_oauth.is_some(),
        onedrive: config.microsoft_oauth.is_some(),
    })
}

pub async fn start(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(provider_str): Path<String>,
) -> ApiResult<Json<StartResponse>> {
    let provider = parse_provider(&provider_str)?;
    ensure_provider_configured(provider, state.config())?;
    let base_url = state.config().app_base_url.as_deref().ok_or_else(|| {
        ApiError::ServiceUnavailable("CASTIFY_APP_BASE_URL is required for OAuth".into())
    })?;

    let owner = resolve_owner(&state, &jar).await?;

    let pkce = PkceChallenge::generate();
    let state_param = castify_catalog::oauth::generate_state();
    let redir = redirect_uri(base_url, &provider);

    let auth_url = build_auth_url(
        provider,
        state.config(),
        &redir,
        &state_param,
        &pkce.challenge,
    )?;

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
    let (token_bundle, account_id, account_email) =
        exchange_and_fetch_account(provider, state.config(), code, &entry.pkce_verifier, &redir)
            .await?;

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
        revoke_provider_token(conn.provider, state.config(), &bundle.access_token).await;
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

fn get_google_config(config: &castify_core::Config) -> Option<GoogleDriveConfig> {
    config.google_oauth.as_ref().map(|oauth| GoogleDriveConfig {
        client_id: oauth.client_id.clone(),
        client_secret: oauth.client_secret.clone(),
    })
}

fn get_dropbox_config(config: &castify_core::Config) -> Option<DropboxConfig> {
    config.dropbox_oauth.as_ref().map(|oauth| DropboxConfig {
        client_id: oauth.client_id.clone(),
        client_secret: oauth.client_secret.clone(),
    })
}

fn get_onedrive_config(config: &castify_core::Config) -> Option<OneDriveConfig> {
    config.microsoft_oauth.as_ref().map(|oauth| OneDriveConfig {
        client_id: oauth.client_id.clone(),
        client_secret: oauth.client_secret.clone(),
    })
}

fn not_configured(provider: Provider) -> ApiError {
    ApiError::ServiceUnavailable(format!("{provider} not configured"))
}

/// Validate that the provider's OAuth credentials are present. Called early
/// in the connect flow so the "not configured" error surfaces before other
/// configuration issues (e.g. missing base URL).
fn ensure_provider_configured(provider: Provider, config: &castify_core::Config) -> ApiResult<()> {
    let configured = match provider {
        Provider::GoogleDrive => get_google_config(config).is_some(),
        Provider::Dropbox => get_dropbox_config(config).is_some(),
        Provider::OneDrive => get_onedrive_config(config).is_some(),
    };
    if !configured {
        return Err(not_configured(provider));
    }
    Ok(())
}

/// Build the OAuth authorization URL for the given provider.
fn build_auth_url(
    provider: Provider,
    config: &castify_core::Config,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> ApiResult<String> {
    match provider {
        Provider::GoogleDrive => {
            let cfg = get_google_config(config).ok_or_else(|| not_configured(provider))?;
            Ok(GoogleDriveClient::new(cfg).authorization_url(redirect_uri, state, challenge))
        }
        Provider::Dropbox => {
            let cfg = get_dropbox_config(config).ok_or_else(|| not_configured(provider))?;
            Ok(DropboxClient::new(cfg).authorization_url(redirect_uri, state, challenge))
        }
        Provider::OneDrive => {
            let cfg = get_onedrive_config(config).ok_or_else(|| not_configured(provider))?;
            Ok(OneDriveClient::new(cfg).authorization_url(redirect_uri, state, challenge))
        }
    }
}

/// Exchange the authorization code for tokens and fetch the provider account
/// info (ID + email). Returns `(token_bundle, account_id, account_email)`.
async fn exchange_and_fetch_account(
    provider: Provider,
    config: &castify_core::Config,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<(TokenBundle, Option<String>, Option<String>), String> {
    match provider {
        Provider::GoogleDrive => {
            let cfg = get_google_config(config)
                .ok_or_else(|| format!("{provider} credentials no longer configured"))?;
            let client = GoogleDriveClient::new(cfg);
            let token = client
                .exchange_code(code, verifier, redirect_uri)
                .await
                .map_err(|e| format!("token exchange failed: {e}"))?;
            let info = client
                .fetch_user_info(&token.access_token)
                .await
                .map_err(|e| format!("failed to fetch user info: {e}"))?;
            Ok((token, Some(info.id), info.email))
        }
        Provider::Dropbox => {
            let cfg = get_dropbox_config(config)
                .ok_or_else(|| format!("{provider} credentials no longer configured"))?;
            let client = DropboxClient::new(cfg);
            let token = client
                .exchange_code(code, verifier, redirect_uri)
                .await
                .map_err(|e| format!("token exchange failed: {e}"))?;
            let info = client
                .fetch_user_info(&token.access_token)
                .await
                .map_err(|e| format!("failed to fetch user info: {e}"))?;
            Ok((token, info.account_id, info.email))
        }
        Provider::OneDrive => {
            let cfg = get_onedrive_config(config)
                .ok_or_else(|| format!("{provider} credentials no longer configured"))?;
            let client = OneDriveClient::new(cfg);
            let token = client
                .exchange_code(code, verifier, redirect_uri)
                .await
                .map_err(|e| format!("token exchange failed: {e}"))?;
            let info = client
                .fetch_user_info(&token.access_token)
                .await
                .map_err(|e| format!("failed to fetch user info: {e}"))?;
            Ok((token, info.account_id, info.email))
        }
    }
}

/// Revoke a provider token (best-effort — network failure is swallowed).
async fn revoke_provider_token(
    provider: Provider,
    config: &castify_core::Config,
    access_token: &str,
) {
    match provider {
        Provider::GoogleDrive => {
            if let Some(cfg) = get_google_config(config) {
                let _ = GoogleDriveClient::new(cfg).revoke_token(access_token).await;
            }
        }
        Provider::Dropbox => {
            if let Some(cfg) = get_dropbox_config(config) {
                let _ = DropboxClient::new(cfg).revoke_token(access_token).await;
            }
        }
        Provider::OneDrive => {
            if let Some(cfg) = get_onedrive_config(config) {
                let _ = OneDriveClient::new(cfg).revoke_token(access_token).await;
            }
        }
    }
}

fn spawn_scan(state: &AppState, connection_id: &str, provider: Provider) {
    let repo = state.catalog_repository().clone();
    let conn_id = connection_id.to_string();

    let factory: Box<dyn ProviderFactory> = match provider {
        Provider::GoogleDrive => {
            let oauth = match get_google_config(state.config()) {
                Some(cfg) => cfg,
                None => {
                    tracing::warn!("google_drive not configured, skipping scan");
                    return;
                }
            };
            Box::new(GoogleDriveFactory::new(oauth))
        }
        Provider::Dropbox => {
            let oauth = match get_dropbox_config(state.config()) {
                Some(cfg) => cfg,
                None => {
                    tracing::warn!("dropbox not configured, skipping scan");
                    return;
                }
            };
            Box::new(DropboxFactory::new(oauth))
        }
        Provider::OneDrive => {
            let oauth = match get_onedrive_config(state.config()) {
                Some(cfg) => cfg,
                None => {
                    tracing::warn!("onedrive not configured, skipping scan");
                    return;
                }
            };
            Box::new(OneDriveFactory::new(oauth))
        }
    };

    tokio::spawn(async move {
        castify_catalog::scanner::run_scan(repo, conn_id, provider, factory).await;
    });
}

async fn resolve_owner(state: &AppState, jar: &CookieJar) -> ApiResult<OwnerDto> {
    let session_id = extract_session_id(jar, state.session_secret())
        .ok_or(ApiError::Auth(AuthError::InvalidSession))?;
    let owner_id = state.repository().validate_session(&session_id).await?;
    let owner = state.repository().fetch_owner_by_id(&owner_id).await?;
    Ok(OwnerDto::from_owner(&owner))
}
