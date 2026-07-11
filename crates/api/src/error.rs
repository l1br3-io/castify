use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

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
    #[error("provider error: {0}")]
    Provider(#[from] castify_catalog::ProviderError),
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    status: &'static str,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (code, message) = match &self {
            ApiError::Validation { detail } => (StatusCode::BAD_REQUEST, detail.clone()),
            ApiError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            ApiError::Conflict(_) => (StatusCode::CONFLICT, self.to_string()),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            ApiError::ForbiddenCsrf => (StatusCode::FORBIDDEN, self.to_string()),
            ApiError::ServiceUnavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, self.to_string()),
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
                (status, message)
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
                (status, message)
            }
            ApiError::Provider(err) => {
                tracing::error!(error = ?err, "provider error");
                (StatusCode::BAD_GATEWAY, err.to_string())
            }
            ApiError::Internal(err) => {
                tracing::error!(error = ?err, "internal server error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
        };
        let body = Json(ErrorBody {
            status: "error",
            message,
        });
        (code, body).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
