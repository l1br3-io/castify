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
    #[error("auth error: {0}")]
    Auth(#[from] castify_auth::AuthError),
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
            ApiError::Auth(err) => {
                let status = match err {
                    castify_auth::AuthError::InvalidCredentials
                    | castify_auth::AuthError::InvalidSession
                    | castify_auth::AuthError::SessionExpired => StatusCode::UNAUTHORIZED,
                    castify_auth::AuthError::NoOwner => StatusCode::NOT_FOUND,
                    castify_auth::AuthError::OwnerAlreadyExists => StatusCode::CONFLICT,
                    castify_auth::AuthError::Validation(_) => StatusCode::BAD_REQUEST,
                    // WebAuthn verification failures are caused by client-supplied
                    // data (malformed credential, wrong challenge, etc.). The
                    // underlying webauthn-rs errors aren't distinguishable here
                    // without leaking internals, so treat them all as 400. If a
                    // genuine server-side misconfiguration occurs it surfaces as
                    // a build-time `Webauthn` construction failure in `main.rs`.
                    castify_auth::AuthError::Webauthn(_) => StatusCode::BAD_REQUEST,
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
