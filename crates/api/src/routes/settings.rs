//! Runtime-editable server settings (Settings page).
//!
//! `GET /api/settings/transcode` — current transcode toggle.
//! `PUT /api/settings/transcode` — persist to the `settings` table and flip
//! the in-memory flag. The next request sees the new value; no restart.
//!
//! The env var (`CASTIFY_TRANSCODE_ENABLED`) only provides the default until
//! the owner sets the toggle once; after that the DB value wins across
//! restarts.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct TranscodeSettingsDto {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct TranscodeSettingsUpdate {
    pub enabled: bool,
}

pub async fn get_transcode_settings(State(state): State<AppState>) -> Json<TranscodeSettingsDto> {
    Json(TranscodeSettingsDto {
        enabled: state.transcode_enabled(),
    })
}

pub async fn put_transcode_settings(
    State(state): State<AppState>,
    Json(update): Json<TranscodeSettingsUpdate>,
) -> ApiResult<Json<TranscodeSettingsDto>> {
    // Persist first — the in-memory flag only flips when the write is
    // durable, so a failed write can't leave the two disagreeing.
    let value = if update.enabled { "true" } else { "false" };
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('transcode_enabled', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(value)
    .execute(state.pool())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "failed to persist transcode_enabled");
        ApiError::Internal(e.into())
    })?;

    state.set_transcode_enabled(update.enabled);
    tracing::info!(enabled = update.enabled, "transcode setting updated");
    Ok(Json(TranscodeSettingsDto {
        enabled: state.transcode_enabled(),
    }))
}
