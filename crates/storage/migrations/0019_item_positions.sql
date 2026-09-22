-- Migration 0019: item positions within curated folders
-- (drag-and-drop effort, docs/specs/drag-and-drop/spec.md).
--
-- Data-storage justification (docs/data-storage-principles.md, decision
-- framework run per datum): the owner's intra-folder order is
-- cross-device state — written rarely (one reorder = one transaction),
-- read on every device → rules 4/6 (shared across the owner's
-- devices): Server. Rule 5: exactly one request per user action — the
-- dense-rewrite reorder, never per-item writes.
--
-- Model: `library_folder_position INTEGER NULL` on `videos` and
-- `files`. NULL = never ordered. A placement scope is "ordered" iff it
-- has at least one placed item and every placed item in it has a
-- position (the repository's detection helper); the first reorder
-- flips the whole folder dense (0..n-1) in one transaction, and batch
-- moves into an ordered folder append at the tail. Unordered scopes —
-- all NULL, i.e. every folder that exists today — keep the shipped
-- name-ascending contents byte-for-byte.
--
-- Positions are organization, never authorization: playback, shares,
-- search, and the "All files" grid never read these columns. No index
-- — reads filter by the already-indexed `library_folder_id` and sort
-- one per-folder page.

ALTER TABLE videos ADD COLUMN library_folder_position INTEGER;
ALTER TABLE files ADD COLUMN library_folder_position INTEGER;
