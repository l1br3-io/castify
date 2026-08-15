-- Migration 0011: Non-video file catalog (M9 — file-aware library).
--
-- Real cloud folders hold photos, documents, archives, and audio alongside
-- videos; M9 catalogs them so the folder tree mirrors the user's cloud.
-- Rows are metadata-only: no thumbnails, no ffprobe, no FTS, no favorites —
-- the cheapest possible catalog citizenship (see
-- docs/specs/home-redesign/spec.md § Architecture decisions).
--
-- `videos` is untouched — dedup, FTS, favorites, ratings, and the transcode
-- pipeline keep working without change. `kind` excludes 'video' by
-- construction: only non-video entries land here (the providers' video
-- gates stay the entry point for `videos`).
--
-- Subtitle sidecars are dual-represented: a `files` row (organizational —
-- it is a real file in the folder tree) plus the existing
-- `video_subtitles` row (playback routing, unchanged since M3/M8).

CREATE TABLE files (
    id                   TEXT PRIMARY KEY NOT NULL,
    connection_id        TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    provider_file_id     TEXT NOT NULL,
    name                 TEXT NOT NULL,
    path                 TEXT,
    size_bytes           INTEGER,
    mime_type            TEXT,
    kind                 TEXT NOT NULL CHECK (kind IN ('audio', 'image', 'subtitle', 'document', 'archive', 'other')),
    provider_modified_at TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(connection_id, provider_file_id)
);

-- Path lookups: the folder tree and contents queries (M9 FR-4/FR-5) filter
-- on path prefixes. Connection-scoped deletes ride the cascade + this index.
CREATE INDEX idx_files_path ON files(path);
CREATE INDEX idx_files_connection ON files(connection_id);
