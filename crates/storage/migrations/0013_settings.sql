-- Migration 0013: Runtime-editable server settings.
--
-- Key-value store for settings the owner can toggle from the app's Settings
-- page. Server-side persistence is justified per docs/data-storage-principles:
-- these control server behavior (transcode CPU/disk spend) and must survive
-- restarts and apply across devices.
--
-- Current keys:
--   'transcode_enabled' — 'true' | 'false'. Overrides the
--   CASTIFY_TRANSCODE_ENABLED env default once the owner has set it.

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
