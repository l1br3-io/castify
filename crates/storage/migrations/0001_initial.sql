-- Castify initial schema (M0: Foundation).
-- Future migrations append to this file's tables; never edit in place.

-- Single owner of a Castify instance. Auth credential columns arrive
-- in migration 0002 alongside the first-run setup work.
CREATE TABLE owners (
    id           TEXT PRIMARY KEY NOT NULL,
    created_at   TEXT NOT NULL,
    display_name TEXT
);

-- Generic key-value store for instance-level metadata (instance id,
-- first-run markers, feature flags, etc.). Avoid using this for hot data.
CREATE TABLE app_meta (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO app_meta (key, value, updated_at) VALUES
    ('instance_id', lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('created_at',  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
