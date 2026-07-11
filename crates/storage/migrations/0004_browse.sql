-- Migration 0004: Browse (M2).
--
-- Adds per-owner favorites + ratings for personalization, a thumbnail_status
-- column tracking the lazy proxy cache, and an FTS5 virtual table over video
-- name + path for full-text search (kept in sync via triggers).

CREATE TABLE video_favorites (
    owner_id   TEXT NOT NULL
               REFERENCES owners(id) ON DELETE CASCADE,
    video_id   TEXT NOT NULL
               REFERENCES videos(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, video_id)
);

CREATE INDEX idx_favorites_owner ON video_favorites(owner_id);

CREATE TABLE video_ratings (
    owner_id   TEXT NOT NULL
               REFERENCES owners(id) ON DELETE CASCADE,
    video_id   TEXT NOT NULL
               REFERENCES videos(id) ON DELETE CASCADE,
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, video_id)
);

CREATE INDEX idx_ratings_owner ON video_ratings(owner_id);

-- Thumbnail cache state: 'pending' | 'cached' | 'failed' | 'unsupported'.
-- Lazy proxy fetches on first view; existing rows backfill to 'pending'.
ALTER TABLE videos ADD COLUMN thumbnail_status TEXT NOT NULL DEFAULT 'pending';

-- Full-text search over video name + path. External-content FTS5 table backed
-- by `videos` rowid; the three triggers below keep the index in sync.
-- https://www.sqlite.org/fts5.html#external_content_tables
CREATE VIRTUAL TABLE videos_fts USING fts5(
    name,
    path,
    content='videos',
    content_rowid='rowid'
);

-- Backfill index for rows that existed before this migration.
INSERT INTO videos_fts(rowid, name, path)
    SELECT rowid, name, path FROM videos;

CREATE TRIGGER videos_fts_ai AFTER INSERT ON videos BEGIN
    INSERT INTO videos_fts(rowid, name, path)
        VALUES (new.rowid, new.name, new.path);
END;

CREATE TRIGGER videos_fts_ad AFTER DELETE ON videos BEGIN
    INSERT INTO videos_fts(videos_fts, rowid, name, path)
        VALUES ('delete', old.rowid, old.name, old.path);
END;

CREATE TRIGGER videos_fts_au AFTER UPDATE ON videos BEGIN
    INSERT INTO videos_fts(videos_fts, rowid, name, path)
        VALUES ('delete', old.rowid, old.name, old.path);
    INSERT INTO videos_fts(rowid, name, path)
        VALUES (new.rowid, new.name, new.path);
END;
