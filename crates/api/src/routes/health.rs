use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use sqlx::Row;

use crate::state::AppState;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub uptime_seconds: u64,
    pub db: &'static str,
}

#[tracing::instrument(skip(state))]
pub async fn health(State(state): State<AppState>) -> (StatusCode, Json<HealthResponse>) {
    let db_ok = db_liveness(state.pool()).await;
    let (status_code, status, db) = if db_ok {
        (StatusCode::OK, "ok", "ok")
    } else {
        tracing::warn!("health check degraded: DB liveness probe failed");
        (StatusCode::SERVICE_UNAVAILABLE, "degraded", "error")
    };

    (
        status_code,
        Json(HealthResponse {
            status,
            version: env!("CARGO_PKG_VERSION"),
            uptime_seconds: state.started_at().elapsed().as_secs(),
            db,
        }),
    )
}

/// Run `SELECT 1` against the SQLite pool with a bounded acquire timeout as a
/// safety net. SQLite local probes are sub-millisecond; the bound only guards
/// against pool exhaustion under abnormal load.
async fn db_liveness(pool: &sqlx::SqlitePool) -> bool {
    let mut conn = match tokio::time::timeout(Duration::from_millis(500), pool.acquire()).await {
        Ok(Ok(conn)) => conn,
        Ok(Err(_)) | Err(_) => return false,
    };
    let row = sqlx::query("SELECT 1 AS one").fetch_one(&mut *conn).await;
    row.map(|r| r.get::<i64, _>("one") == 1).unwrap_or(false)
}
