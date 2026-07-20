-- Migration 0007: Hot video disk cache (M4).
--
-- Manifest table for the hot-video disk cache. One row per cached video
-- file on disk. Managed by crates/catalog (manifest ops) + crates/cache
-- (filesystem ops). The cache is opt-in via CASTIFY_VIDEO_CACHE_ENABLED.
--
-- Cache invalidation:
--   - On provider_file_id mismatch at read time (re-scan replaced the file).
--   - On explicit DELETE /api/videos/{id}/cache.
--   - On LRU eviction when total size exceeds CASTIFY_VIDEO_CACHE_MAX_BYTES.
-- No TTL — self-hosted users may go months between plays; TTL would defeat
-- the purpose.
--
-- Pinned rows survive LRU eviction; pinning is a manual user action via
-- POST /api/videos/{id}/cache { pinned: bool }.

CREATE TABLE video_cache_entries (
    video_id          TEXT PRIMARY KEY NOT NULL
                      REFERENCES videos(id) ON DELETE CASCADE,
    connection_id     TEXT NOT NULL
                      REFERENCES provider_connections(id) ON DELETE CASCADE,
    provider_file_id  TEXT NOT NULL,
    size_bytes        INTEGER NOT NULL,
    last_accessed_at  TEXT NOT NULL,
    pinned            INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- LRU eviction query: ORDER BY last_accessed_at ASC, WHERE pinned = 0.
CREATE INDEX idx_video_cache_last_accessed
    ON video_cache_entries(last_accessed_at)
    WHERE pinned = 0;

-- Admin stats: count of pinned entries, total pinned size.
CREATE INDEX idx_video_cache_pinned
    ON video_cache_entries(pinned)
    WHERE pinned = 1;
