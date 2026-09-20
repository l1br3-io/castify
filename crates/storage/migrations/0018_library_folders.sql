-- Migration 0018: Library folders — owner-curated organization for the
-- whole catalog (docs/specs/library-folders/spec.md).
--
-- Data-storage justification (docs/data-storage-principles.md, decision
-- framework run per datum):
--   * The curated folder tree (names, parents, positions) and item
--     placement (`library_folder_id` on `videos` and `files`) are the
--     owner's cross-device library structure — written by the owner,
--     read on every device → rule 4 (shared across users): Server.
--   * Writes are low-frequency and user-initiated — one transaction per
--     owner action (create/rename/reparent/delete/batch-move), never
--     per-request → rule 5: Server OK.
--   * Browse navigation (`?folder=`) and multi-select state are client
--     URL / React state — deliberately NOT here.
--
-- Model: the share-folders adjacency list (migration 0017) applied at
-- library scale — `parent_id` NULL = tree root, walked by single
-- recursive CTEs (depth ≤ 8, personal-library cardinality). Depth cap
-- and cycle-freedom are repo-enforced; sibling-name uniqueness is the
-- same two partial unique indexes (SQLite treats NULLs as distinct in a
-- plain UNIQUE, so the root level needs its own). Case-sensitive,
-- POSIX-ish. Scope is `owner_id`, not a share: the tree belongs to the
-- library's owner (the `video_favorites` precedent).
--
-- FK safety nets (the repository's explicit transactions are the real
-- path; these keep the tree walkable if anything bypasses them):
--   * `library_folders.parent_id ... ON DELETE CASCADE` — a folder row
--     vanishing never orphans subfolders.
--   * `videos.library_folder_id` / `files.library_folder_id ... ON
--     DELETE SET NULL` — a folder vanishing by FK alone returns its
--     items to Unfiled; catalog membership is never touched (folders
--     are organization, not authorization — playback, shares, search
--     never read these columns).
--   * `library_folders.owner_id ... ON DELETE CASCADE` — an owner purge
--     removes the curated tree with it.
--
-- Existing data: both placement columns default NULL, so every current
-- item starts Unfiled and the tree starts empty — today's library is
-- already the degenerate conformant state (no scanner changes; new
-- files land Unfiled by column default).

CREATE TABLE library_folders (
    id         TEXT PRIMARY KEY NOT NULL,
    owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    parent_id  TEXT REFERENCES library_folders(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,                 -- order within the scope (folder or root)
    created_at TEXT NOT NULL
);

CREATE INDEX idx_library_folders_owner ON library_folders(owner_id);

-- Sibling-name invariant: unique per scope. Root folders (parent_id IS
-- NULL) get their own partial index — SQLite treats NULLs as distinct
-- in a plain UNIQUE, so one three-column index would not enforce it.
CREATE UNIQUE INDEX uq_library_folders_siblings
    ON library_folders(owner_id, parent_id, name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX uq_library_folders_root
    ON library_folders(owner_id, name) WHERE parent_id IS NULL;

ALTER TABLE videos
    ADD COLUMN library_folder_id TEXT REFERENCES library_folders(id) ON DELETE SET NULL;
ALTER TABLE files
    ADD COLUMN library_folder_id TEXT REFERENCES library_folders(id) ON DELETE SET NULL;

CREATE INDEX idx_videos_library_folder ON videos(library_folder_id);
CREATE INDEX idx_files_library_folder ON files(library_folder_id);
