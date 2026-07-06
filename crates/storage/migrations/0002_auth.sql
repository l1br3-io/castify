-- Migration 0002: owner authentication (M0 Phase 3).
--
-- Supports the first-run setup wizard (T8) with two credential kinds:
-- password (Argon2id) and passkey (WebAuthn). Sessions persist in SQLite so
-- the owner stays logged in across server restarts (T9).

CREATE TABLE password_credentials (
    owner_id      TEXT PRIMARY KEY NOT NULL
                  REFERENCES owners(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,            -- Argon2id PHC-encoded string
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE webauthn_credentials (
    id           TEXT PRIMARY KEY NOT NULL,  -- base64url of credential id
    owner_id     TEXT NOT NULL
                 REFERENCES owners(id) ON DELETE CASCADE,
    public_key   BLOB NOT NULL,
    counter      INTEGER NOT NULL DEFAULT 0,
    transports   TEXT,                       -- JSON array of transport hints
    created_at   TEXT NOT NULL,
    last_used_at TEXT
);

CREATE INDEX idx_webauthn_credentials_owner ON webauthn_credentials(owner_id);

CREATE TABLE sessions (
    id           TEXT PRIMARY KEY NOT NULL,  -- opaque random session id
    owner_id     TEXT NOT NULL
                 REFERENCES owners(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent   TEXT,
    ip_address   TEXT
);

CREATE INDEX idx_sessions_owner   ON sessions(owner_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
