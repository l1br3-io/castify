-- Migration 0003: Connect & Catalog (M1).
--
-- Stores OAuth-connected cloud storage providers, the unified video catalog,
-- and resumable scan state per connection.

CREATE TABLE provider_connections (
    id                     TEXT PRIMARY KEY NOT NULL,
    provider               TEXT NOT NULL,        -- 'google_drive' | 'dropbox' | 'onedrive'
    token_bundle           BLOB NOT NULL,        -- AES-256-GCM encrypted JSON
    provider_account_id    TEXT,
    provider_account_email TEXT,
    connected_at           TEXT NOT NULL,
    disconnected_at        TEXT,                 -- NULL = active; soft-delete for audit
    UNIQUE(provider, provider_account_id)
);

CREATE INDEX idx_connections_active
    ON provider_connections(provider)
    WHERE disconnected_at IS NULL;

CREATE TABLE videos (
    id                   TEXT PRIMARY KEY NOT NULL,
    connection_id        TEXT NOT NULL
                         REFERENCES provider_connections(id) ON DELETE CASCADE,
    provider             TEXT NOT NULL,
    provider_file_id     TEXT NOT NULL,
    name                 TEXT NOT NULL,
    path                 TEXT,
    size_bytes           INTEGER NOT NULL,
    mime_type            TEXT,
    duration_ms          INTEGER,
    width                INTEGER,
    height               INTEGER,
    native_hash          TEXT,
    native_hash_algo     TEXT,
    castify_hash         TEXT,
    dedup_group          TEXT,
    provider_modified_at TEXT,
    scanned_at           TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    UNIQUE(connection_id, provider_file_id)
);

CREATE INDEX idx_videos_dedup
    ON videos(dedup_group)
    WHERE dedup_group IS NOT NULL;

CREATE INDEX idx_videos_connection ON videos(connection_id);

CREATE INDEX idx_videos_provider ON videos(provider);

CREATE TABLE scan_state (
    connection_id   TEXT PRIMARY KEY NOT NULL
                    REFERENCES provider_connections(id) ON DELETE CASCADE,
    status          TEXT NOT NULL,           -- 'idle' | 'scanning' | 'error'
    cursor          TEXT,
    started_at      TEXT,
    completed_at    TEXT,
    error_message   TEXT,
    videos_found    INTEGER NOT NULL DEFAULT 0
);
