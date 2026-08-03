-- Migration 0010: Advanced subtitle formats (M8).
--
-- Rebuilds `video_subtitles` to (a) relax the `format` CHECK so ASS/SSA/PGS/
-- VobSub are legal alongside the original SRT/VTT, and (b) add the routing
-- columns M8 needs: `format_family` (drives burn-vs-serve without a lookup),
-- `embedded_track_id` (links an extracted-embedded text track back to its
-- muxed stream index; NULL for sidecars), and `extracted_path` (on-disk path
-- for extracted-embedded text tracks; NULL for sidecars whose bytes live at
-- the provider).
--
-- SQLite cannot `ALTER TABLE … DROP CHECK`, so the migration creates a `_new`
-- table with the relaxed CHECK + new columns, copies rows across, drops the
-- old, and renames. Existing rows are all SRT/VTT sidecars → migrated with
-- `format_family = 'text'`, `embedded_track_id = NULL`, `extracted_path = NULL`.
--
-- The dedup story splits across two constraints because SQLite's
-- `ON CONFLICT(<columns>)` only matches a column-list unique index, not an
-- expressional one:
--   1. Inline `UNIQUE(video_id, provider_file_id)` — the original sidecar
--      dedup. Sidecars always carry a non-NULL provider_file_id, so this
--      catches duplicate sidecar files and stays a valid ON CONFLICT target
--      for the scan-time upsert path.
--   2. Expressional unique index on `(video_id, COALESCE(provider_file_id,
--      '_embedded_' || embedded_track_id))` — covers extracted-embedded
--      tracks, whose provider_file_id is NULL (SQLite treats NULLs as
--      distinct, so the inline constraint can't dedupe them). The COALESCE
--      maps them to a synthetic '_embedded_<index>' key. This index also
--      redundantly catches sidecar dupes; that's harmless.
--
-- SQLite prohibits expressions in inline table UNIQUE constraints, which is
-- why (2) is a `CREATE UNIQUE INDEX` rather than a column constraint.

CREATE TABLE video_subtitles_new (
    id                TEXT PRIMARY KEY NOT NULL,
    video_id          TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    connection_id     TEXT REFERENCES provider_connections(id) ON DELETE CASCADE,
    provider_file_id  TEXT,
    embedded_track_id INTEGER,
    language          TEXT,
    filename          TEXT NOT NULL,
    format            TEXT NOT NULL CHECK (format IN ('srt', 'vtt', 'ass', 'ssa', 'pgs', 'vobsub')),
    format_family     TEXT NOT NULL CHECK (format_family IN ('text', 'image')),
    extracted_path    TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, provider_file_id)
);

INSERT INTO video_subtitles_new (id, video_id, connection_id, provider_file_id, embedded_track_id,
                                 language, filename, format, format_family, extracted_path, created_at)
SELECT id, video_id, connection_id, provider_file_id, NULL, language, filename, format, 'text', NULL, created_at
FROM video_subtitles;

DROP TABLE video_subtitles;
ALTER TABLE video_subtitles_new RENAME TO video_subtitles;

CREATE INDEX idx_video_subtitles_video ON video_subtitles(video_id);

-- Embedded-track dedup. See the block comment above for why this is a
-- separate index alongside the inline sidecar UNIQUE.
CREATE UNIQUE INDEX idx_video_subtitles_embedded_dedup
    ON video_subtitles(video_id, COALESCE(provider_file_id, '_embedded_' || embedded_track_id));
