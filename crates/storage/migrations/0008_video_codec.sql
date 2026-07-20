-- Migration 0008: Codec model + embedded subtitle tracks (M5).
--
-- Adds codec/bitrate/framerate columns to `videos`, populated by the M5
-- ffprobe worker. Probe is hybrid: lazy on first play (fire-and-forget in
-- the /stream-url handler) + eager background sweep after scan completion.
-- Failed probes are retryable; probe_status tracks the state machine.
--
-- Also adds `video_subtitle_tracks` for embedded (muxed-in) subtitle tracks
-- discovered at probe time. This is separate from `video_subtitles` (M3),
-- which holds sidecar .srt/.vtt files. M8 unifies them at the API layer.

ALTER TABLE videos ADD COLUMN video_codec TEXT;
ALTER TABLE videos ADD COLUMN audio_codec TEXT;
ALTER TABLE videos ADD COLUMN bitrate INTEGER;
ALTER TABLE videos ADD COLUMN framerate REAL;
ALTER TABLE videos ADD COLUMN probed_at TEXT;
ALTER TABLE videos ADD COLUMN probe_status TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX idx_videos_probe_status ON videos(probe_status)
    WHERE probe_status = 'pending';

CREATE TABLE video_subtitle_tracks (
    id                TEXT PRIMARY KEY NOT NULL,
    video_id          TEXT NOT NULL
                      REFERENCES videos(id) ON DELETE CASCADE,
    embedded_index    INTEGER NOT NULL,
    codec             TEXT NOT NULL,
    format_family     TEXT NOT NULL,
    language          TEXT,
    title             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, embedded_index)
);

CREATE INDEX idx_subtitle_tracks_video ON video_subtitle_tracks(video_id);
