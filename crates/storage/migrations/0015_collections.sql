-- Migration 0015: Library collections (docs/specs/library-collections/spec.md).
--
-- Data-storage justification (docs/data-storage-principles.md): collections
-- are curated cross-device state — accept on one device, see them on every
-- device → rule 4 (shared across devices): Server. Writes are low-frequency
-- and user-initiated (accept/dismiss/create/edit), never per-request.
--
-- Staging-vs-persistent split (plan, architecture decision #1):
--   * `collection_suggestions` is STAGING — deterministically regenerated
--     from scratch by each completed scan for that connection (minus
--     dismissed signatures). It is derived data, safe to drop and rebuild,
--     and self-healing when the classifier improves. Never user state.
--   * `collections` / `collection_items` are PERSISTENT — created only by
--     explicit user acceptance or manual creation. Nothing auto-applies.
--
-- Durability (spec F4): membership attaches to `videos(id)` with CASCADE —
-- the re-link pass (hash-based identity recovery) runs before any prune
-- could strand rows, and a hard video delete removing its membership is
-- the intended last resort, mirroring `share_items`.
--
-- Suppression key: `signature` is the classifier's canonical key
-- (normalized show/movie title or `time:YYYY-MM`), deliberately NOT row
-- ids — dismissed groups must stay dismissed across rescans even when the
-- underlying video rows churn.

CREATE TABLE collections (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('show', 'movie', 'time', 'manual')),
    created_at TEXT NOT NULL
);

CREATE TABLE collection_items (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    video_id      TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,               -- curation order within the collection
    PRIMARY KEY (collection_id, video_id)
);

CREATE INDEX idx_collection_items_video ON collection_items(video_id);

-- Staging: one row per proposed group from the latest completed scan of
-- a connection. `kind` excludes 'manual' — the cascade never proposes it.
CREATE TABLE collection_suggestions (
    id            TEXT PRIMARY KEY NOT NULL,
    connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('show', 'movie', 'time')),
    title         TEXT NOT NULL,
    signature     TEXT NOT NULL,
    member_count  INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (connection_id, signature)
);

CREATE INDEX idx_collection_suggestions_connection ON collection_suggestions(connection_id);

CREATE TABLE collection_suggestion_items (
    suggestion_id TEXT NOT NULL REFERENCES collection_suggestions(id) ON DELETE CASCADE,
    video_id      TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    PRIMARY KEY (suggestion_id, video_id)
);

-- Dismissals are connection-scoped by signature: re-scans regenerate
-- staging and must filter against this table, never resurrect a group
-- the user rejected.
CREATE TABLE collection_suggestion_dismissals (
    connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    signature     TEXT NOT NULL,
    dismissed_at  TEXT NOT NULL,
    PRIMARY KEY (connection_id, signature)
);
