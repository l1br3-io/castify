# PRD: M1 — Connect & Catalog

> **Status:** Approved baseline — second milestone of the Media Hub Core.
> **Companion:** [`VISION.md`](../VISION.md), [`ROADMAP.md`](../ROADMAP.md), [`tasks/plan.md`](../../tasks/plan.md).

## Purpose

M1 turns Castify from a foundation into a media hub: the owner connects cloud storage providers they already pay for, the app scans for videos, and a unified deduplicated catalog appears. Everything in later milestones (browse UI, playback, sharing) builds on this catalog.

## In scope

- OAuth 2.0 connections for **Google Drive**, **Dropbox**, and **OneDrive** (Authorization Code + PKCE).
- Encrypted token storage (AES-256-GCM at rest); tokens survive restarts.
- Background catalog scanner: discovers video files via provider APIs, stores metadata.
- Unified video list API — paginated, deduplicated across providers.
- Tiered deduplication: same-provider via native hash (free), cross-provider via Castify prefix hash (SHA-256 of first 4 MB via Range requests).
- Connect, disconnect, and rescan from the UI.
- First-run connection guide: "Connect your first cloud" walkthrough.
- Configuration for per-provider OAuth credentials (owner BYO).

## Out of scope (deferred)

- Browse experience — hero showcase, poster grid, rows, search, filters, favorites, ratings (M2).
- Video playback — streaming, seeking, subtitles, resume (M3).
- Full-file content hashing (Tier 3 dedup) — prefix hash is sufficient for M1.
- Thumbnails / poster image generation (M2).
- Automatic background re-scan on a schedule (manual rescan only in M1).
- Photo and audio support (future directions).

## Architecture decisions (locked)

| Area                     | Choice                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider credentials     | **Owner BYO** — env vars per provider (`CASTIFY_*_CLIENT_ID` / `CASTIFY_*_CLIENT_SECRET`). App boots without them (connect buttons disabled).            |
| OAuth flow               | Authorization Code + **PKCE**. State parameter tied to owner session.                                                                                  |
| OAuth callback           | `GET /api/connections/{provider}/callback` — authenticated (session cookie rides the browser redirect). Not in pre-auth allowlist.                    |
| App base URL             | New `CASTIFY_APP_BASE_URL` env var (e.g. `https://media.example.com`) for constructing OAuth redirect URIs. Required only when a provider is configured. |
| Token storage            | **AES-256-GCM** encrypted at rest. Encryption key from `CASTIFY_TOKEN_KEY` (auto-generated + persisted to `app_meta` if absent, like session secret).    |
| HTTP client              | `reqwest` with `rustls-tls` (no OpenSSL dep; preserves static distroless binary).                                                                       |
| New crate                | `crates/catalog/` — domain types, `Provider` trait, 3 provider implementations, catalog repository, scanner, token crypto.                              |
| Dedup tier 1 (same-provider)  | Provider-native hash comparison (Google MD5/SHA-256, Dropbox content_hash, OneDrive QuickXorHash). Free — no download.                              |
| Dedup tier 2 (cross-provider) | Castify canonical prefix hash: SHA-256 of first 4 MB via HTTP Range request + exact file size. ~99.99%+ accuracy. Cheap (~4 MB per file).         |
| Dedup tier 3 (full-file)      | Deferred. Full-file SHA-256 on-demand for disputed edge cases. Not in M1.                                                                               |
| Video filter             | MIME type `video/*` (provider-native where available) + file-extension fallback (`.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.m4v`, `.ts`, `.wmv`, `.flv`). |
| Scanner trigger          | On-connect (automatic) + manual rescan (`POST /api/connections/{id}/scan`). No scheduled background scans in M1.                                         |
| Scanner runtime          | In-process `tokio::spawn` task (matches M0's background-work decision).                                                                                  |
| Rate-limit handling      | Exponential backoff on 429 / 503. Resumable via `scan_state` cursor per connection.                                                                      |

## Functional requirements

### FR-1: Connect provider

- **FR-1.1** `POST /api/connections/{provider}/start` returns a JSON body with the provider's OAuth authorization URL (including PKCE challenge + state).
- **FR-1.2** The browser redirects to the provider's consent screen. On approval, the provider redirects to `GET /api/connections/{provider}/callback?code=...&state=...`.
- **FR-1.3** The callback handler verifies the `state` parameter against the initiating owner session, exchanges the authorization code for tokens (using the configured client secret), encrypts the token bundle, and persists a `provider_connections` row.
- **FR-1.4** After storing the connection, the handler triggers a background catalog scan for the new connection.
- **FR-1.5** Supported providers: `google_drive`, `dropbox`, `onedrive`.
- **FR-1.6** `POST /api/connections/{provider}/start` returns 503 if the provider's OAuth credentials are not configured, with a hint pointing at `docs/config.md`.

### FR-2: Disconnect

- **FR-2.1** `DELETE /api/connections/{id}` revokes the provider token (best-effort; network failure does not block deletion) and deletes the connection row plus all its catalog rows (`ON DELETE CASCADE`).
- **FR-2.2** Returns 204 on success, 404 if the connection does not exist.

### FR-3: List connections

- **FR-3.1** `GET /api/connections` returns all active connections with: `id`, `provider`, `provider_account_email`, `connected_at`, `scan_status`, `last_scan_at`, `video_count`.
- **FR-3.2** Disconnected (soft-deleted) connections are excluded.

### FR-4: Catalog scan

- **FR-4.1** The scanner lists video files from the connected provider via its API, paginating through all results.
- **FR-4.2** For each video file, the scanner stores: `provider_file_id`, `name`, `path`, `size_bytes`, `mime_type`, `duration_ms`, `width`, `height`, `native_hash`, `native_hash_algo`, `provider_modified_at`, `scanned_at`.
- **FR-4.3** The scanner computes the Castify prefix hash (SHA-256 of first 4 MB) via an HTTP Range request and stores `castify_hash` + `dedup_group`.
- **FR-4.4** The scanner is resumable: it persists a cursor (`scan_state` row) after each page so an interrupted scan resumes from the last position.
- **FR-4.5** Re-scans are incremental: files whose `provider_modified_at` hasn't changed since the last scan are skipped.
- **FR-4.6** The scanner respects provider rate limits (429 / 503) with exponential backoff.

### FR-5: Unified video list

- **FR-5.1** `GET /api/videos` returns a paginated, deduplicated list across all active connections.
- **FR-5.2** Deduplication: videos sharing a `dedup_group` (prefix hash + size) appear as one entry with a `sources` array listing each provider copy.
- **FR-5.3** Videos without a `dedup_group` (not yet hashed or hash-pending) always appear.
- **FR-5.4** Query parameters: `page`, `limit` (default 50, max 200), `provider` (optional filter), `sort` (`name`, `size`, `date`; default `date-desc`).
- **FR-5.5** Response includes total count and pagination metadata.

### FR-6: Deduplication

- **FR-6.1** **Tier 1 (same-provider):** Videos from the same provider with identical `native_hash` are grouped.
- **FR-6.2** **Tier 2 (cross-provider):** Videos from different providers with identical `castify_hash` + `size_bytes` are grouped.
- **FR-6.3** The `dedup_group` key is `{castify_hash}:{size_bytes}`. Videos with no `castify_hash` yet are not grouped (always unique until hashed).
- **FR-6.4** The unified list returns one representative video per dedup group, with a `sources` array containing all copies (provider, connection_id, provider_file_id).

### FR-7: Rescan

- **FR-7.1** `POST /api/connections/{id}/scan` triggers a new scan for the specified connection.
- **FR-7.2** Returns 202 Accepted if the scan was started, or 409 Conflict if a scan is already in progress.
- **FR-7.3** `GET /api/connections/{id}/scan` returns the current scan status: `status` (`idle` / `scanning` / `error`), `videos_found`, `started_at`, `completed_at`, `error_message`.

### FR-8: Configuration

- **FR-8.1** Provider OAuth credentials are read from environment variables (see [docs/config.md](../config.md)). All are optional; the app boots without any.
- **FR-8.2** When a provider's credentials are absent, the corresponding "Connect" button is disabled in the UI with a setup hint.
- **FR-8.3** `CASTIFY_APP_BASE_URL` is required for constructing OAuth redirect URIs. If a provider is configured but `CASTIFY_APP_BASE_URL` is missing, startup warns (does not abort — the warning surfaces when a connect attempt is made).
- **FR-8.4** `CASTIFY_TOKEN_KEY` is auto-generated and persisted on first boot if absent.

### FR-9: First-run connection guide

- **FR-9.1** On first visit to the home page after login with zero connections, the UI shows a "Connect your first cloud" guide.
- **FR-9.2** The guide presents provider options (Google Drive, Dropbox, OneDrive) with connect buttons.
- **FR-9.3** After a successful connection, the guide transitions to scan-progress view ("Found N videos...") and then to the video list.

## Non-functional requirements

| Category    | Requirement                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Performance | `GET /api/videos` p99 < 500 ms for catalogs up to 10,000 videos (indexed queries; PRD target from VISION)     |
| Security    | OAuth tokens encrypted at rest (AES-256-GCM); PKCE on every flow; state parameter CSRF-protected               |
| Reliability | Scanner is resumable (cursor per connection); rate-limit backoff; token refresh on 401                         |
| Portability | `reqwest` + `rustls` preserves the static distroless binary; no new system library dependencies                |
| Operability | Scan status visible via API + UI; provider connection errors surfaced with actionable messages                  |

## Acceptance criteria (milestone-level)

- [ ] Owner can connect Google Drive, Dropbox, and OneDrive via OAuth from the UI
- [ ] Connected provider's videos appear in the catalog after a scan
- [ ] The same file in two providers appears once in the unified list (deduplication)
- [ ] The same file uploaded twice to one provider appears once (same-provider dedup)
- [ ] Owner can disconnect a provider; its videos disappear from the catalog
- [ ] Owner can manually trigger a rescan
- [ ] Scan status (progress, video count, errors) is visible in the UI
- [ ] `GET /api/videos` returns results in under 500 ms for catalogs up to 10,000 videos
- [ ] App boots with zero provider credentials configured (basic mode)
- [ ] OAuth tokens are encrypted at rest — a DB dump contains no plaintext tokens
- [ ] First-run guide appears on initial login with zero connections
- [ ] Interrupted scan resumes on next trigger without re-scanning completed pages

## Dependencies

- **M0 — Foundation** (complete): auth, sessions, SQLite, config validation, Docker, SPA shell.
- **External:** owner-supplied OAuth credentials for each provider they want to connect.

## Risks

| Risk                                        | Impact   | Mitigation                                                                                       |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| OAuth setup friction for self-hosters       | Med      | First-run guide + per-provider setup instructions in `docs/config.md`.                              |
| Token refresh failure mid-scan              | Med      | Scanner handles 401 → refresh → retry; connection status surfaces as degraded with actionable msg. |
| Rate limiting during initial full scan      | Med      | Exponential backoff + cursor-based resumability; scan is async, no blocking.                      |
| `reqwest` / `rustls` binary size increase       | Low      | Monitor image size; `rustls` is lighter than `native-tls`. Compare before/after.                   |
| Prefix-hash false positive (collision)      | Very Low | 4 MB SHA-256 + exact size is effectively unique for practical library sizes; Tier 3 available.    |
| Provider API quirks / breaking changes      | Med      | Each provider isolated behind `Provider` trait; one provider at a time in the plan.              |
| Dropbox `content_hash` algorithm mismatch   | Low      | Store as native hash only (same-provider dedup); cross-provider uses Castify prefix hash.          |

## Open questions resolved

- OAuth credentials model: **Owner BYO** (env vars). Castify does not publish shared OAuth apps for self-hosted.
- Token encryption: **AES-256-GCM** with key from `CASTIFY_TOKEN_KEY` (auto-generated fallback).
- Cross-provider dedup: **Tiered** — native hash for same-provider (free), prefix hash (first 4 MB SHA-256 + size) for cross-provider. Full-file hash deferred.
- Scanner scheduling: **On-connect + manual rescan only** (no periodic background schedule in M1).
- HTTP client: **`reqwest` + `rustls`** (preserves static binary).
