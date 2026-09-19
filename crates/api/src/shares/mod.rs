//! Sharing — read-only links for family and friends
//! (docs/specs/sharing/spec.md).
//!
//! A share is a revocable, optionally password-protected, optionally
//! expiring set of catalog items addressed by a single URL token
//! (`/share/<token>`). This module owns the server-side storage
//! (`ShareRepository`) and the token/crypto utilities (`token`).
//!
//! Security invariants, enforced here and relied on by every later route:
//!   * Raw tokens exist only in memory and in the URL — the database
//!     stores the SHA-256 hash (`shares.token_hash`), so a DB dump yields
//!     no usable links.
//!   * Raw tokens and passwords never appear in `tracing` output (a
//!     source-level lint test in `token.rs` keeps it that way).
//!   * Password hashes are argon2id PHC strings (reuse
//!     `castify_auth::password`); unlock state travels as a signed,
//!     share-scoped cookie (HMAC via `castify_auth::SessionSecret`), and
//!     the cookie is never authority by itself — every guarded request
//!     re-checks token hash, expiry, and revocation in the DB.
//!
//! GOTCHA: share IDs and video IDs travel as `String` in this module (the
//! DB stores TEXT UUIDs). Only the owner_id input side is a `Uuid` where
//! the session layer hands one over; parsing UUIDs out of rows would add
//! error paths the callers never need.
//!
//! GOTCHA: after adding a migration under `crates/storage/migrations/`,
//! `sqlx::migrate!` (compile-time snapshot) only re-embeds when the
//! storage crate is rebuilt — `cargo build` may not notice the new file
//! on its own. `touch crates/storage/src/lib.rs` forces the re-snapshot.

pub mod ratelimit;
pub mod repository;
pub mod status;
pub mod token;

pub use repository::{
    FolderInvalid, FolderWriteError, NewShare, RemovedItem, ShareFolderRow, ShareItemRow,
    ShareRepository, ShareRow,
};

#[derive(Debug, thiserror::Error)]
pub enum ShareError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("auth crypto error: {0}")]
    Auth(#[from] castify_auth::AuthError),
    #[error("unlock cookie payload was not a share unlock value")]
    InvalidUnlock,
}

pub type ShareResult<T> = Result<T, ShareError>;
