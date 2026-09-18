-- Migration 0014: Catalog prune — reconcile deletions on rescan
-- (docs/specs/catalog-prune/spec.md).
--
-- A row dies only after the provider authoritatively omitted it across
-- consecutive *successful, complete* listings ("delete on evidence, never
-- on absence of evidence"). The tombstone pair carries that evidence:
--   * missing_scan_count — consecutive completed scans that omitted the row;
--     the existing upsert resets it to 0, so reappearance self-heals.
--   * missing_since      — first omission timestamp, observability only
--     (grace is counted in scans, not wall-clock time).
--
-- scan_state gains per-scan prune counters for the connections UI ("3 videos
-- removed last scan"). Defaults keep upgraded catalogs looking present and
-- zero-pruned — no backfill needed.

ALTER TABLE videos ADD COLUMN missing_since      TEXT;
ALTER TABLE videos ADD COLUMN missing_scan_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE files ADD COLUMN missing_since      TEXT;
ALTER TABLE files ADD COLUMN missing_scan_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scan_state ADD COLUMN videos_pruned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_state ADD COLUMN files_pruned   INTEGER NOT NULL DEFAULT 0;
