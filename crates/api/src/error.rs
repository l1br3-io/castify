use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use castify_catalog::model::Provider;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("validation failed")]
    Validation { detail: String },
    #[error("not found")]
    NotFound,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("csrf token missing or mismatched")]
    ForbiddenCsrf,
    #[error("service unavailable: {0}")]
    ServiceUnavailable(String),
    #[error("auth error: {0}")]
    Auth(#[from] castify_auth::AuthError),
    #[error("catalog error: {0}")]
    Catalog(#[from] castify_catalog::CatalogError),
    #[error("share error: {0}")]
    Shares(#[from] crate::shares::ShareError),
    #[error("provider error: {0}")]
    Provider(#[from] castify_catalog::ProviderError),
    /// The provider's refresh token has expired or been revoked
    /// (`ProviderError::ReauthRequired`). The session itself is still valid —
    /// only the cloud-provider grant is dead. Surfaced as **HTTP 401** with a
    /// structured body `{"status":"error","code":"reauth_required",...}` so
    /// the client can route the user to the Connections page to reconnect,
    /// distinct from a plain 401 (which would trigger a session re-login).
    #[error("provider connection {connection_id} ({provider}) requires re-authentication")]
    ReauthRequired {
        connection_id: String,
        provider: Provider,
    },
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    status: &'static str,
    message: String,
    /// Optional machine-readable code — currently only `"reauth_required"`.
    /// Omitted entirely when `None` so legacy callers/tests that compare the
    /// JSON shape keep working.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    /// Populated only for `code: "reauth_required"` — the connection row that
    /// needs reconnecting and which provider it represents. The frontend uses
    /// these to deep-link the user to the right reconnect flow on the
    /// Connections page.
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (code, message, error_code, connection_id, provider) = match &self {
            ApiError::Validation { detail } => {
                (StatusCode::BAD_REQUEST, detail.clone(), None, None, None)
            }
            ApiError::NotFound => (StatusCode::NOT_FOUND, self.to_string(), None, None, None),
            ApiError::Conflict(_) => (StatusCode::CONFLICT, self.to_string(), None, None, None),
            ApiError::Unauthorized => {
                (StatusCode::UNAUTHORIZED, self.to_string(), None, None, None)
            }
            ApiError::ForbiddenCsrf => (StatusCode::FORBIDDEN, self.to_string(), None, None, None),
            ApiError::ServiceUnavailable(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                self.to_string(),
                None,
                None,
                None,
            ),
            ApiError::Auth(err) => {
                let status = match err {
                    castify_auth::AuthError::InvalidCredentials
                    | castify_auth::AuthError::InvalidSession
                    | castify_auth::AuthError::SessionExpired => StatusCode::UNAUTHORIZED,
                    castify_auth::AuthError::NoOwner => StatusCode::NOT_FOUND,
                    castify_auth::AuthError::OwnerAlreadyExists => StatusCode::CONFLICT,
                    castify_auth::AuthError::Validation(_) => StatusCode::BAD_REQUEST,
                    _ => StatusCode::INTERNAL_SERVER_ERROR,
                };
                let message = if status == StatusCode::INTERNAL_SERVER_ERROR {
                    tracing::error!(error = ?err, "auth subsystem error");
                    "internal error".to_string()
                } else {
                    err.to_string()
                };
                (status, message, None, None, None)
            }
            ApiError::Catalog(err) => {
                let status = match err {
                    castify_catalog::CatalogError::ConnectionNotFound(_) => StatusCode::NOT_FOUND,
                    _ => {
                        tracing::error!(error = ?err, "catalog subsystem error");
                        StatusCode::INTERNAL_SERVER_ERROR
                    }
                };
                let message = if status == StatusCode::INTERNAL_SERVER_ERROR {
                    "internal error".to_string()
                } else {
                    err.to_string()
                };
                (status, message, None, None, None)
            }
            ApiError::Shares(err) => {
                // Route-level validation happens before any repository
                // call, so an error surfacing from the share subsystem is
                // infrastructure (DB, crypto) — opaque 500.
                tracing::error!(error = ?err, "share subsystem error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                    None,
                    None,
                    None,
                )
            }
            ApiError::Provider(err) => {
                tracing::error!(error = ?err, "provider error");
                (StatusCode::BAD_GATEWAY, err.to_string(), None, None, None)
            }
            ApiError::ReauthRequired {
                connection_id,
                provider,
            } => {
                tracing::info!(
                    connection_id = %connection_id,
                    provider = %provider,
                    "provider refresh token revoked/expired; client must reconnect"
                );
                (
                    StatusCode::UNAUTHORIZED,
                    format!(
                        "{provider} connection needs reconnecting (the provider's authorization has expired or been revoked)."
                    ),
                    Some("reauth_required"),
                    Some(connection_id.clone()),
                    Some(provider.to_string()),
                )
            }
            ApiError::Internal(err) => {
                tracing::error!(error = ?err, "internal server error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                    None,
                    None,
                    None,
                )
            }
        };
        let body = Json(ErrorBody {
            status: "error",
            message,
            code: error_code,
            connection_id,
            provider,
        });
        (code, body).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use castify_catalog::model::Provider;
    use serde_json::Value;

    #[tokio::test]
    async fn reauth_required_serializes_as_401_with_structured_code() {
        let err = ApiError::ReauthRequired {
            connection_id: "conn-123".into(),
            provider: Provider::GoogleDrive,
        };
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let bytes = to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(body["status"], "error");
        assert_eq!(body["code"], "reauth_required");
        assert_eq!(body["connection_id"], "conn-123");
        assert_eq!(body["provider"], "google_drive");
        // Message is human-readable — the frontend surfaces this as a
        // last-resort tooltip, but the structured fields above drive UX.
        assert!(body["message"].as_str().unwrap().contains("google_drive"));
    }

    #[tokio::test]
    async fn plain_unauthorized_omits_code_field() {
        // Legacy callers/tests compare `{ status, message }` — keep that shape
        // when no structured code applies.
        let resp = ApiError::Unauthorized.into_response();
        let bytes = to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["status"], "error");
        assert!(body.get("code").is_none() || body["code"].is_null());
        assert!(body.get("connection_id").is_none() || body["connection_id"].is_null());
    }
}
