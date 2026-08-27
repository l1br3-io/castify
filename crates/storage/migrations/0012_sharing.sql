-- Migration 0012: Sharing — read-only links (docs/specs/sharing/spec.md).
--
-- Data-storage justification (docs/data-storage-principles.md, decision
-- framework run per datum):
--   * Share records (token hash, password hash, expiry, revocation) are
--     security-sensitive → rule 3: Server. Raw tokens are NEVER stored —
--     only their SHA-256 hash (`token_hash`), so a DB dump yields no
--     usable links.
--   * Shares are shared across users: the owner writes, recipients read →
--     rule 4: Server.
--   * Writes are low-frequency and user-initiated (one per create/revoke
--     action; editing item lists is a v1 non-goal) → rule 5: Server OK.
--   * Recipient playback progress/preferences stay client-side
--     (IndexedDB) — deliberately NOT here; recipient playback performs
--     zero server writes.
--   * Password attempt counters (unlock rate limiting) are in-memory only
--     — ephemeral by design, never persisted.
--
-- `owner_id` scopes listing/revocation to the creating owner (single-owner
-- today; the FK keeps the seam honest). `share_items` carries `position`
-- to preserve the owner's curation order; PK(share_id, video_id) makes
-- membership a set relation. Video deletes cascade: a share whose items
-- vanish resolves to an empty list, not an error.

CREATE TABLE shares (
    id            TEXT PRIMARY KEY NOT NULL,
    owner_id      TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    token_hash    BLOB NOT NULL UNIQUE,        -- SHA-256 of the raw token
    password_hash TEXT,                        -- NULL = no password; argon2id PHC string
    title         TEXT NOT NULL,
    expires_at    TEXT,                        -- NULL = never expires (RFC3339)
    revoked_at    TEXT,                        -- NULL = live; set = terminal state
    created_at    TEXT NOT NULL
);

CREATE INDEX idx_shares_owner ON shares(owner_id);

CREATE TABLE share_items (
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,                 -- curation order within the share
    PRIMARY KEY (share_id, video_id)
);

CREATE INDEX idx_share_items_video ON share_items(video_id);
