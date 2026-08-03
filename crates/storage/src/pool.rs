use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: u32 = 5;

pub async fn connect(database_path: impl AsRef<Path>) -> Result<SqlitePool> {
    let path = database_path.as_ref();
    let path_str = path
        .to_str()
        .with_context(|| format!("db path must be valid UTF-8: {}", path.display()))?;

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("failed to create db dir {}", parent.display()))?;
        }
    }

    let options = SqliteConnectOptions::from_str(&format!("sqlite://{path_str}"))?
        .journal_mode(SqliteJournalMode::Wal)
        .create_if_missing(true)
        .busy_timeout(BUSY_TIMEOUT);

    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect_with(options)
        .await
        .with_context(|| format!("failed to connect to sqlite at {path_str}"))?;

    tracing::info!(db_path = %path.display(), "sqlite pool opened (WAL mode)");
    Ok(pool)
}

// Migrations live in `./migrations`; the `migrate!` proc-macro snapshots them
// at compile time. Adding a new .sql file requires touching this file (or any
// `src/*.rs` in the crate) to trigger re-expansion. Latest: `0010_subtitle_formats`.
pub async fn run_migrations(pool: &SqlitePool) -> Result<()> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .context("failed to run migrations")?;
    tracing::info!("database migrations applied");
    Ok(())
}
