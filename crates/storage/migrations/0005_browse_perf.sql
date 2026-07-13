-- Migration 0005: Browse performance index (M2 T13).
--
-- Partial covering index for the ungrouped representative arm of the dedup
-- query: `SELECT id FROM videos WHERE dedup_group IS NULL`. Without it, the
-- planner does a full table scan over `videos`. With it, the scan uses the
-- index (EXPLAIN shows `SCAN videos USING INDEX idx_videos_ungrouped`).
--
-- The existing `idx_videos_dedup` partial index covers the grouped arm
-- (`WHERE dedup_group IS NOT NULL`); this is the symmetric counterpart for
-- the ungrouped arm.

CREATE INDEX IF NOT EXISTS idx_videos_ungrouped
    ON videos(id)
    WHERE dedup_group IS NULL;
