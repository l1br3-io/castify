-- Migration 0006: Play (M3).
--
-- Adds per-owner playback progress for resume-where-you-left-off + the
-- continue-watching shelf, and a subtitle-track table for scan-time sidecar
-- .srt/.vtt detection.

CREATE TABLE playback_progress (
    owner_id          TEXT NOT NULL
                      REFERENCES owners(id) ON DELETE CASCADE,
    video_id          TEXT NOT NULL
                      REFERENCES videos(id) ON DELETE CASCADE,
    position_seconds  REAL NOT NULL,
    duration_seconds  REAL,
    updated_at        TEXT NOT NULL,
    completed         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, video_id)
);

-- Partial index for the continue-watching shelf query:
--   WHERE owner_id = ? AND completed = 0 ORDER BY updated_at DESC LIMIT 20
-- Only in-progress rows are indexed; completed rows are excluded entirely.
CREATE INDEX idx_progress_in_progress
    ON playback_progress(owner_id, updated_at DESC)
    WHERE completed = 0;

CREATE TABLE video_subtitles (
    id                TEXT PRIMARY KEY NOT NULL,
    video_id          TEXT NOT NULL
                      REFERENCES videos(id) ON DELETE CASCADE,
    connection_id     TEXT NOT NULL
                      REFERENCES provider_connections(id) ON DELETE CASCADE,
    provider_file_id  TEXT NOT NULL,
    language          TEXT,
    filename          TEXT NOT NULL,
    format            TEXT NOT NULL CHECK (format IN ('srt', 'vtt')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, provider_file_id)
);

CREATE INDEX idx_subtitles_video ON video_subtitles(video_id);
