//! CLI subcommands. `main.rs` dispatches argv here; each function owns one
//! subcommand's host-side logic so tests can call it directly.
//!
//! `reset-password` is the locked-out recovery path. It is non-interactive
//! (no TTY prompt): run it on the host next to the database — in Docker,
//! `docker exec <container> castify reset-password` — and it prints a
//! one-time temp password to stdout. The password is never routed through
//! `tracing` (JSON logs share stdout and would leak/bury it); the single
//! `println!` in `main.rs` is the only emission.

use anyhow::Context;
use castify_auth::{password, AuthRepository};
use castify_core::Config;
use castify_storage::{connect, run_migrations};

/// Usage text for argv dispatch failures (unknown subcommand → stderr, exit 2).
pub const USAGE: &str = "usage: castify [serve | reset-password]";

/// Install a randomly generated 20-char temp password for the owner and
/// revoke every session, so a locked-out owner can sign back in exactly once.
///
/// Connects to and migrates the DB at `config.database_path` — the same
/// resolution the server boot path uses — via its own connection, like the
/// real binary. Refuses (`Err`) when no owner exists. Returns the generated
/// temp password; the caller prints it to stdout once.
pub async fn reset_password(config: &Config) -> anyhow::Result<String> {
    let pool = connect(&config.database_path)
        .await
        .context("failed to open database")?;
    run_migrations(&pool)
        .await
        .context("database migration failed")?;
    let repo = AuthRepository::new(pool);

    let owner = repo.fetch_owner().await?;
    let temp = password::generate_temp_password();
    let phc = password::hash_password(&temp)?;
    repo.set_password(&owner.id, &phc).await?;
    repo.delete_all_sessions(&owner.id).await?;
    Ok(temp)
}
