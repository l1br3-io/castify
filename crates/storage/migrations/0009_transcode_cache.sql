-- Migration 0009: Transcode cache manifest (M6).
--
-- One row per (video, variant, profile) transcode output. The HLS segments
-- and playlists live on disk under <data_dir>/transcode-cache/<video_id>/.
-- This table is the manifest the API layer consults to decide whether a
-- transcode is cached, in-progress, or needs starting.
--
-- Profile encodes the encoder settings (codec, preset, HW accel method).
-- Changing hardware or CASTIFY_TRANSCODE_HW_ACCEL produces a different
-- profile string, naturally invalidating old caches (different key).
--
-- Variants (M7 expands this):
--   'source' — transcode at source resolution (codec conversion only)
--   '720p'   — downscale to 1280x720 if source is larger
--   '480p', '360p' — added by M7 adaptive bitrate

CREATE TABLE transcode_cache_entries (
    video_id              TEXT NOT NULL
                          REFERENCES videos(id) ON DELETE CASCADE,
    variant               TEXT NOT NULL,
    profile               TEXT NOT NULL,
    output_dir            TEXT NOT NULL,
    total_segments        INTEGER,
    completed_segments    INTEGER NOT NULL DEFAULT 0,
    segment_duration_secs INTEGER NOT NULL DEFAULT 10,
    bitrate               INTEGER,
    width                 INTEGER,
    height                INTEGER,
    status                TEXT NOT NULL DEFAULT 'pending',
    last_error            TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at      TEXT NOT NULL,
    PRIMARY KEY (video_id, variant, profile)
);

CREATE INDEX idx_transcode_status ON transcode_cache_entries(status);
CREATE INDEX idx_transcode_last_accessed ON transcode_cache_entries(last_accessed_at);
