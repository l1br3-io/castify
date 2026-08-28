pub mod connections;
pub mod csrf;
pub mod files;
pub mod folders;
pub mod health;
pub mod session;
pub mod setup;
pub mod share;
pub mod shares;
pub mod videos;

use crate::error::{ApiError, ApiResult};

pub(crate) const MIN_PASSWORD_LEN: usize = 8;
pub(crate) const MAX_PASSWORD_LEN: usize = 256;

/// Shared password policy for every path that accepts a password (first-run
/// setup and signed-in change): 8..=256 characters. One rule, one home —
/// the change-password handler must not drift from setup.
pub(crate) fn validate_password(password: &str) -> ApiResult<()> {
    let len = password.chars().count();
    if len < MIN_PASSWORD_LEN {
        return Err(ApiError::Validation {
            detail: format!("password must be at least {MIN_PASSWORD_LEN} characters"),
        });
    }
    if len > MAX_PASSWORD_LEN {
        return Err(ApiError::Validation {
            detail: format!("password must be at most {MAX_PASSWORD_LEN} characters"),
        });
    }
    Ok(())
}
