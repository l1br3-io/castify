//! Library folders — owner-curated organization for the whole catalog
//! (docs/specs/library-folders/spec.md).
//!
//! Google Drive-style folders the owner creates inside Castify, filing
//! catalog items (videos *and* non-video files) into them. The curated
//! tree is a presentation axis bolted onto the catalog: placement is a
//! nullable column on `videos`/`files`, NULL meaning **Unfiled** — the
//! pinned virtual node every new scan lands in by default (no scanner
//! changes). The auto-detected provider-folder tree stays a secondary
//! view, untouched.
//!
//! Invariants, enforced here and relied on by every route:
//!   * Folders are organization, never authorization — playback, shares,
//!     search, filters, and the "All files" grid never read placement.
//!     The only writer of `library_folder_id` is the batch-move path.
//!   * One transaction per owner action (create / rename+reparent /
//!     delete / batch move / reorder) — a partial folder operation can
//!     never land.
//!   * Guard failures (unknown or foreign folder ids) are `Ok(None)`,
//!     never errors — the same no-leak shape as the shares repository.
//!   * Item positions (drag-and-drop task 005): a placement scope is
//!     ordered iff every placed item in it has a position; unordered
//!     scopes (the all-NULL default) keep name-ascending contents. The
//!     only writers are the dense-rewrite reorder (the first one flips
//!     a scope dense in its one transaction) and batch moves appending
//!     into an already-ordered scope.
//!
//! GOTCHA: ids travel as `String` (the DB stores TEXT UUIDs); only the
//! owner_id input side is a `Uuid` where the session layer hands one
//! over — same convention as the shares module.
//!
//! GOTCHA: after adding a migration under `crates/storage/migrations/`,
//! `sqlx::migrate!` (compile-time snapshot) only re-embeds when the
//! storage crate is rebuilt — `cargo build` may not notice the new file
//! on its own. `touch crates/storage/src/lib.rs` forces the re-snapshot.

pub mod repository;

pub use repository::{
    FolderInvalid, FolderWriteError, ItemKind, LibraryContentsFilter, LibraryFolderRepository,
    LibraryFolderRow, LibraryFolderTree, LibraryTreeFolder, MoveItem,
};

#[derive(Debug, thiserror::Error)]
pub enum LibraryFolderError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

pub type LibraryFolderResult<T> = Result<T, LibraryFolderError>;
