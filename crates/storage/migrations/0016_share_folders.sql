-- Migration 0016: Share folders — filesystem-style organization inside a
-- share (docs/specs/share-folders/spec.md).
--
-- Data-storage justification (docs/data-storage-principles.md, decision
-- framework run per datum):
--   * Folder tree (names, parents, positions) and item placement
--     (`folder_id`) are part of a share's curated structure — written by
--     the owner, read by recipients → rule 4 (shared across users):
--     Server.
--   * Writes are low-frequency and user-initiated — one transaction per
--     owner action (create/rename/reparent/move/delete), never
--     per-request → rule 5: Server OK.
--   * Recipient navigation state (`?folder=`) is client URL state —
--     deliberately NOT here; recipient browsing performs zero writes.
--
-- Model: adjacency list (`parent_id`, NULL = share root) walked by single
-- recursive CTEs — the canonical small-tree model (depth ≤ 8, dozens of
-- folders). Depth cap and cycle-freedom are repo-enforced (declarative SQL
-- cannot express them); sibling-name uniqueness CAN be expressed and is —
-- two partial unique indexes, because SQLite treats NULLs as distinct in a
-- plain UNIQUE so the root level needs its own. Uniqueness is
-- case-sensitive (SQLite TEXT default, POSIX-ish).
--
-- FK safety nets (the repository's explicit transactions are the real
-- path; these are last resorts that keep the tree walkable if anything
-- ever bypasses them):
--   * `share_folders.parent_id ... ON DELETE CASCADE` — deleting a folder
--     takes its subfolders, never orphans them.
--   * `share_items.folder_id ... ON DELETE SET NULL` — a folder vanishing
--     by FK alone lifts its items to the share root (membership is never
--     touched; folders are organization, not authorization).
--   * `share_folders.share_id ... ON DELETE CASCADE` — a share purge
--     removes its folder tree with it, mirroring `share_items`.
--
-- Existing data: the added `folder_id` column defaults NULL, so
-- pre-existing items stay at the share root with their positions
-- untouched — today's flat shares are already the degenerate conformant
-- tree.

CREATE TABLE share_folders (
    id         TEXT PRIMARY KEY NOT NULL,
    share_id   TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    parent_id  TEXT REFERENCES share_folders(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,                 -- order within the scope (folder or root)
    created_at TEXT NOT NULL
);

CREATE INDEX idx_share_folders_share ON share_folders(share_id);

-- Sibling-name invariant: unique per scope. Root folders (parent_id IS
-- NULL) get their own partial index — SQLite treats NULLs as distinct in
-- a plain UNIQUE, so one three-column index would not enforce it.
CREATE UNIQUE INDEX uq_share_folders_siblings
    ON share_folders(share_id, parent_id, name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX uq_share_folders_root
    ON share_folders(share_id, name) WHERE parent_id IS NULL;

ALTER TABLE share_items
    ADD COLUMN folder_id TEXT REFERENCES share_folders(id) ON DELETE SET NULL;

CREATE INDEX idx_share_items_folder ON share_items(folder_id);
