# Data storage principles

> **Status:** Living guideline — the "where" behind every piece of data in Castify.
> **Audience:** Contributors, PRD authors, and AI agents working in this repo.
> **Goal:** Keep server work as low as practical — fewer requests, lighter DB writes, simpler ops, faster UX.

Castify's product model is "bring your own cloud" — the user's media never moves to the server, and the app runs on hardware the user owns (a NAS, a home server, a VPS). The cheapest byte is the one never transferred; the cheapest request is the one never made. Less work on the server means a smaller footprint, longer uptime on cheap hardware, and a faster experience in the browser.

This doc is the gate every new feature passes through before adding server-side storage, API endpoints, or recurring requests. Default to client-side. Justify every server write.

---

## The core principle

**Default to client-side storage.** The server stores only what it *must*: the shared catalog, auth/security data, and low-frequency cross-device state. Everything else lives in the browser.

"Convenience" is not sufficient justification for a server request. A feature that works entirely client-side is better than one that round-trips to the server — even if the server-side version is simpler to implement.

---

## Decision framework

Run new data through these questions in order. The first match wins.

| #   | Question                                                                  | If YES →                              | If NO →     |
| --- | ------------------------------------------------------------------------- | ------------------------------------- | ----------- |
| 1   | Is the data write-heavy during a single session? (timer-driven, >1/min)   | **Client** (IndexedDB)                   | Continue ↓  |
| 2   | Is it only relevant to one browser/device?                                | **Client** (IndexedDB/localStorage)      | Continue ↓  |
| 3   | Is it security-sensitive (tokens, auth, secrets)?                         | **Server** (encrypted at rest)           | Continue ↓  |
| 4   | Is it scanned from cloud providers or shared across users?                | **Server**                               | Continue ↓  |
| 5   | Is it low-frequency and user-initiated? (≤1 request per user action)      | **Server OK** — cross-device value justifies it | Continue ↓  |
| 6   | Does it need cross-device sync?                                           | **Server** — but batch/sync, don't stream | **Client**      |

### Worked example: playback progress

1. Write-heavy during playback? **Yes** (every 15s during a video). → **IndexedDB.** Stop.
   - The old design (`POST /progress` every 15s) generated ~120 requests per 30-min video. The IndexedDB version generates zero.

### Worked example: favorites toggle

1. Write-heavy? **No** — one toggle per user action. Continue.
2. Per-device? **No** — user wants favorites on every device. Continue.
3. Security-sensitive? **No.** Continue.
4. Scanned/shared? **No.** Continue.
5. Low-frequency and user-initiated? **Yes.** → **Server.** Stop.
   - Favorites stay server-side: ~1 request per toggle, cross-device value.

---

## Storage tiers

| Tier                          | Where                            | Castify examples                                                                                  |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Shared catalog**              | Server (SQLite)                  | `videos`, `video_subtitles`, `provider_connections`, `scan_state`, FTS index, dedup groups         |
| **Per-user low-frequency**     | Server (SQLite)                  | `video_favorites`, `video_ratings` — user-initiated, cross-device value                              |
| **Auth & security**            | Server (SQLite, AES-256-GCM)     | `owners`, OAuth token bundles                                                                       |
| **Thumbnails**               | Server (disk cache)              | `/data/thumbnails/{id}` — lazy-fetched once from provider, disk-cached, served with HTTP cache headers |
| **Per-device session state**   | **Client (IndexedDB)**              | Playback progress, completed flag, continue-watching shelf data                                      |
| **Per-device preferences**     | **Client (IndexedDB)**              | Volume, mute, playback speed, subtitle track selection                                              |
| **Ephemeral UI state**         | **Client (React state / router)**   | Queue, panel open/close, filter state, form drafts                                                  |

---

## Anti-patterns (lessons we've already paid for)

These are real regressions from earlier milestones. Each one is a concrete example of what the framework prevents.

### 1. Timer-driven server POSTs

**Anti-pattern:** A `setInterval` fires `POST /api/...` on a timer during an active session.

**What happened:** The watch page posted playback progress every 15 seconds. A 30-minute video generated ~120 server requests. A 2-hour movie: ~480. This was the single largest source of server load — and the data was inherently per-device (resume position on one browser doesn't need to match another).

**Fix:** Moved to IndexedDB. Zero server requests during playback.

**Rule:** If data changes more than once per user action, it belongs client-side. The server sees at most a batched sync — never a live stream.

### 2. Picking the streaming path on UX, not cost

**Old anti-pattern (retired):** "Never proxy bytes when the browser can reach the source directly." That rule was inherited from an earlier "hosted service" framing where server bandwidth cost us money. Castify is self-hosted only — the user owns the hardware, server bandwidth is free, and the optimization target is **smoothest playback per provider**, not lowest server load.

**Current principle:** For each provider, pick the path that delivers the smoothest UX:

- **OneDrive + Dropbox**: their APIs issue short-lived preauthenticated CDN URLs that the browser fetches directly. This path is smooth (one hop to a fast CDN) and is the right choice. The backend resolves the URL; the browser fetches.
- **Google Drive**: Drive's `?alt=media` endpoint sometimes 302-redirects to a pre-signed CDN URL (smooth, browser-direct) and sometimes serves bytes inline requiring a bearer header (must be proxied). The backend tries direct first; falls back to the proxy (`/stream`) when Drive declines. The proxy is fine — **self-hosted means we're free to use it**. Future milestones (M3.5 audit + fix, M4 disk cache) ensure the proxy path is also smooth.

**Lesson:** Cost-driven streaming rules don't apply to self-hosted software. Pick what gives the user the best experience for their provider. The proxy is a tool, not a last resort. The M3.5 streaming posture refactor instruments and audits the proxy to verify it actually is smooth; the M4 disk cache makes second plays disk-fast.

**Rule:** Per provider, pick the path that delivers smoothest playback. Don't apologize for using the proxy when it's the right call. The decision framework below still applies to *other* data (catalog, progress, favorites); video bytes are special because their volume dwarfs everything else and provider CDN URLs are the better path *when they exist and are smooth*.

### 3. Server endpoints for per-device data

**Anti-pattern:** A server endpoint queries the DB for data that is only ever read by the browser that wrote it.

**What happened:** `GET /api/videos?in_progress=true` queried the server's `playback_progress` table to populate the continue-watching shelf. But progress is per-browser — querying the server for "what am I watching" adds a network round-trip for data the browser already has locally.

**Fix:** The continue-watching shelf reads from IndexedDB. Zero server calls.

**Rule:** If the server is the only writer and the only reader is one browser, the server is a slow cache. Cut it out.

### 4. Polling for state that rarely changes

**Anti-pattern:** A frontend polls an endpoint every N seconds for data that changes infrequently.

**What happened (averted):** The scan-status hook could have polled `GET /api/connections/{id}/scan` on a timer. Instead, it only polls while a scan is actively running (`refetchInterval` gated on `status === "scanning"`) and stops when idle.

**Rule:** Polling is appropriate only for the duration of an active operation. Idle state should be event-driven or read once on mount.

---

## Implementation guide

### IndexedDB — the client-side store for structured data

Use IndexedDB for any client-side data that is structured, queryable, or larger than a few key-value pairs. The pattern lives in `frontend/src/lib/player-db.ts` — follow it for new client-side stores.

```
Database: castify-player
Stores:
  - playbackProgress (keyPath: "videoId")
  - playerPrefs (keyPath: "key")
```

Write frequency guidance for IndexedDB:
- IndexedDB writes are cheap (local I/O, async) but not free (battery, disk).
- Throttle writes with a position-delta or time-delta check — don't write on every `timeupdate` event.
- 5–10 second write intervals are fine for high-frequency state. Sub-second writes are wasteful.

### localStorage — for simple key-value

Use `localStorage` only for tiny, simple values (a single string or number). Examples: theme preference, last-visited-route. Don't use it for structured data — IndexedDB is the right tool for that.

Never use cookies for data. The session cookie is auth-only.

### Server-side storage

The server uses SQLite (`crates/storage/`). New tables go in `crates/storage/migrations/00NN_name.sql`. Before adding one, re-run the decision framework above and document the justification in the migration's header comment.

---

## Pre-implementation checklist

Before adding any new server-side storage, API endpoint, or recurring request, answer these questions. If any answer points client-side, implement it client-side.

- [ ] Is this data written more than once per user action? → IndexedDB.
- [ ] Is this data only read by the browser that wrote it? → IndexedDB.
- [ ] If server-side: what is the worst-case request frequency per user session? (State the number.)
- [ ] If server-side: can the writes be batched or synced on unload instead of streamed live?
- [ ] If this is a GET endpoint: is the data already in the browser's possession (from a previous fetch, IndexedDB, or page state)? → Use what you have; don't re-fetch.
- [ ] Does this endpoint proxy bytes the browser could fetch directly from a CDN/provider URL? → For video bytes specifically, see the "Picking the streaming path on UX, not cost" anti-pattern above. For other byte payloads (thumbnails, subtitle text), prefer resolving a URL the browser can fetch directly.

Document the answers in the PRD's "Architecture decisions" section or the migration's header comment. Future contributors and agents should be able to trace *why* a piece of data lives where it does.
