# PRD: M4 — Hot Video Disk Cache

> **Status:** ✅ Complete — `crates/cache/` crate shipped, stream-through caching live, pin/unpin + admin endpoint working. Background sweep task and thumbnail cache migration deferred.
> **Companion:** [`ROADMAP-self-hosted-media-server.md`](../ROADMAP-self-hosted-media-server.md), [`m3.5-streaming-posture-refactor.md`](./m3.5-streaming-posture-refactor.md).

## Implementation deviations

The following were specified in the baseline PRD but deferred during implementation. They are additive improvements that can land incrementally without rework:

- **Thumbnail cache migration to `crates/cache/`** — the existing inline code in `videos.rs` was not rewritten to use the new `DiskCache` API. The thumbnail cache continues to work as before. Migration is mechanical (swap `tokio::fs::write` for `DiskCache::put_bytes`).
- **Background LRU sweep task** — `evict_to_target()` exists and runs synchronously at the end of each cache write (via `cache_write_task`). A periodic background task that calls `sweep_orphans()` + `evict_to_target()` every ~10 min is not yet wired. Orphaned temp files from crashed writers are cleaned up by the `StreamingCacheWriter::Drop` safety net; the sweep is a secondary defense.
- **Eager post-scan probe trigger** — repo methods exist but scanner integration not wired.

## Purpose

M4 caches played videos to local disk. The first time a video is played, bytes flow through the server proxy and are written to disk as they pass. The second time, the cache serves from disk — no provider hop, no token refresh, no Google Drive / OneDrive / Dropbox round-trip. Re-watching becomes disk-fast.

This is also the milestone that extracts a reusable `crates/cache/` module. The thumbnail cache (currently inlined at `crates/api/src/routes/videos.rs:344-351`) becomes the first consumer; the new hot-video cache becomes the second; M6's transcode cache becomes the third.

## In scope

- **New crate `crates/cache/`** with a generic `DiskCache<K, V>` API:
  - `get(key) -> Option<CachedEntry>` — checks manifest table, opens file
  - `put(key, reader) -> CachedEntry` — streams bytes to disk, records manifest
  - `touch(key)` — updates `last_accessed_at`
  - `evict_oldest_until_under(limit_bytes)` — LRU eviction, respects pin
  - `pin(key, bool)` — toggle pin
- **Thumbnail cache migration** — the existing inline code in `videos.rs` is rewritten to use `crates/cache/`. No behavior change.
- **Schema migration `0007_video_cache.sql`** — `video_cache_entries` table.
- **New `StreamUrl` variant: `Cached { path }`** — added to `crates/catalog/src/provider.rs`. The catalog crate doesn't depend on the new cache crate; the variant just carries a path the API layer resolves.
- **New endpoint `GET /api/videos/{id}/cached-stream`** — serves bytes from disk with Range support, mirrors `/stream` headers.
- **Stream-through caching on `/stream`**: while serving the proxy response, bytes are tee'd to disk. First play still hits the provider; second play hits the cache.
- **Manual pin/unpin endpoint**: `POST /api/videos/{id}/cache` with body `{ pinned: bool }`.
- **LRU eviction worker**: when total cache size exceeds `CASTIFY_VIDEO_CACHE_MAX_BYTES`, oldest unpinned entries are evicted (file deleted, manifest row removed). Runs on each `put` and on a periodic background sweep.
- **Cache admin endpoint**: `GET /api/admin/cache` — total size, entry count, top 10 by size, eviction stats.
- **New env vars** (3): see Architecture decisions.

## Out of scope (deferred)

- Pre-fetching videos into cache without a play (background worker that pulls "recently added" or "favorites") — future enhancement.
- Cross-device cache coordination — single-server, no coordination needed.
- Transcoding output cache — M6 (reuses this crate, but separate cache pool).
- Cache encryption at rest — single-owner self-hosted; the OS disk encryption (LUKS, FileVault, etc.) is the right layer.
- Distributed / replicated cache — single-server only.

## Architecture decisions (locked)

| Area                                | Choice                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cache module placement**             | New crate `crates/cache/`. Generic over key + value types. Lives outside `crates/api/` so M6 (which depends on `crates/catalog/`) can also use it without a circular dep.                                                                                                          |
| **Cache module API**                  | `DiskCache<K, V>` where `K: CacheKey` (string-based, e.g. video_id) and `V: CacheValue` (serializeable metadata). Backed by SQLite (manifest table) + filesystem (bytes). Concurrent-safe via per-key `tokio::sync::Mutex`. |
| **Stream-through caching**           | On `/stream`, the proxy response body is tee'd: one stream to the HTTP response, one to disk. The disk write is async and buffered (8 MB chunks). If disk write fails (full, permissions), the stream continues serving — cache write failure is logged, never propagates to the client. |
| **Cache key**                          | `video_id` (the existing catalog PK). One cache entry per video. Re-scan replacing a video's `provider_file_id` (rare) invalidates the entry — verified by storing `provider_file_id` in the manifest and comparing on `get`. |
| **Cache invalidation**                | Three triggers: (1) `provider_file_id` mismatch on `get`; (2) explicit `DELETE /api/videos/{id}/cache`; (3) LRU eviction when over limit. No TTL — self-hosted users may go months between plays; TTL would defeat the purpose. |
| **Pin semantics**                     | Pinned entries never evicted by LRU. Pinning is a manual user action (POST endpoint or future UI button). Auto-pin policies (e.g. "favorites auto-pinned") are future enhancements; M4 ships manual-only. |
| **Eviction policy**                   | LRU by `last_accessed_at`. Eviction runs synchronously on `put` if over limit (fast — manifest delete + file unlink). Background sweep every 10 min catches orphaned entries (file present, manifest missing — or vice versa). |
| **Cached stream endpoint**           | `GET /api/videos/{id}/cached-stream` — same response shape as `/stream` (status, Content-Type, Content-Length, Content-Range, Accept-Ranges). Reads via `tokio::fs::File` + `seek` for Range support. Auth required, no CSRF (safe GET). |
| **Strategy resolution order**        | `open_stream_url` checks cache first. If cached and valid → `StreamUrl::Cached`. Else falls through to existing logic (provider native direct URL or proxy). Frontend treats `Cached` identically to `Direct` for `<video src>` purposes. |
| **Configuration**                     | Three new env vars. All default-off or conservative — see Config section below. |

## Schema migration `0007_video_cache.sql`

```sql
-- Hot video disk cache manifest. One row per cached video file on disk.
-- Managed by crates/cache/ via the API layer.
CREATE TABLE video_cache_entries (
    video_id          TEXT PRIMARY KEY NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    connection_id     TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    provider_file_id  TEXT NOT NULL,
    bytes_path        TEXT NOT NULL,
    size_bytes        INTEGER NOT NULL,
    last_accessed_at  TEXT NOT NULL,
    pinned            INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id)
);

CREATE INDEX idx_video_cache_last_accessed ON video_cache_entries(last_accessed_at);
CREATE INDEX idx_video_cache_pinned ON video_cache_entries(pinned);
```

**Why `connection_id` is denormalized**: cache invalidation needs to handle provider disconnect (cascade). Storing `connection_id` lets us bulk-invalidate without joining.

**Why `provider_file_id`**: re-scans occasionally replace this (provider changes file ID after a move). Storing it lets `get` verify the cache is still valid for the current video.

## Functional requirements

### FR-1: New `crates/cache/` module

- **FR-1.1** New crate `crates/cache/` with `DiskCache<K, V>` generic API.
- **FR-1.2** API methods: `get`, `put` (streaming), `touch`, `pin`, `unpin`, `delete`, `total_size_bytes`, `entry_count`, `evict_oldest_until_under`.
- **FR-1.3** Backed by SQLite (manifest table, injected by caller — not owned by the cache crate) + filesystem (bytes path, configurable root).
- **FR-1.4** Per-key `tokio::sync::Mutex` for concurrent-safe writes. Reads are lock-free (SQLite handles concurrency).
- **FR-1.5** All methods are `async`. Errors are typed: `CacheError::Io`, `CacheError::Manifest`, `CacheError::KeyNotFound`, `CacheError::DiskFull`.
- **FR-1.6** Crate has unit tests for: concurrent `put` to same key, eviction respects pin, orphan cleanup (file without manifest, manifest without file).

### FR-2: Thumbnail cache migration

- **FR-2.1** `crates/api/src/routes/videos.rs` `get_thumbnail` (lines 280–360 approximately) is rewritten to use `crates/cache/`.
- **FR-2.2** Cache key: `format!("thumbnail:{video_id}")`. Cache value: `{ mime_type: String }`. Bytes path: `<data_dir>/thumbnails/<video_id>`.
- **FR-2.3** `thumbnail_status` column on `videos` continues to drive logic (pending/cached/failed/unsupported) — the migration is mechanical, not semantic.
- **FR-2.4** Existing thumbnail tests pass unchanged: `thumbnail_cached_serves_from_disk`, `thumbnail_fetches_caches_and_serves`, `thumbnail_second_request_serves_from_cache`.

### FR-3: Hot video cache — write path

- **FR-3.1** When `CASTIFY_VIDEO_CACHE_ENABLED=true`, the `/stream` handler tee's response bytes to disk via `crates/cache/`.
- **FR-3.2** The tee is non-blocking: disk writes happen on a separate task; the HTTP response is not delayed by disk I/O.
- **FR-3.3** If disk write fails, the failure is logged at `warn` level. The HTTP response continues uninterrupted.
- **FR-3.4** On stream completion, the manifest row is inserted with `size_bytes`, `bytes_path`, `last_accessed_at = now`.
- **FR-3.5** Partial streams (client disconnects mid-play) produce partial cache entries. The cache module detects partial entries (size mismatch with `Content-Length`) and either resumes or evicts. M4 ships "evict partial" — resume is a future enhancement.

### FR-4: Hot video cache — read path

- **FR-4.1** `open_stream_url` checks cache first. If valid entry exists → returns `StreamUrl::Cached { path: "/api/videos/{id}/cached-stream" }`.
- **FR-4.2** `GET /api/videos/{id}/cached-stream` serves bytes from disk with full Range support.
- **FR-4.3** Response headers mirror `/stream`: `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges: bytes`.
- **FR-4.4** `last_accessed_at` is updated on every read (cheap: one SQL UPDATE).
- **FR-4.5** If the cache file is missing on disk (deleted out-of-band), the manifest row is removed and the request falls through to `/stream` (which may re-cache).

### FR-5: Eviction

- **FR-5.1** When `total_size_bytes > CASTIFY_VIDEO_CACHE_MAX_BYTES`, oldest unpinned entries are evicted until under limit.
- **FR-5.2** Eviction deletes the file first, then the manifest row. Crash between the two leaves an orphan; the background sweep (FR-5.4) cleans it.
- **FR-5.3** Eviction runs synchronously at the end of each `put` (after the new entry is recorded). Cost: O(log n) for the index seek + a few file deletes.
- **FR-5.4** Background sweep every 10 minutes: scan manifest for orphaned files (file missing), scan disk for orphaned entries (manifest missing), clean both.

### FR-6: Manual pin/unpin

- **FR-6.1** `POST /api/videos/{id}/cache` with body `{ pinned: bool }` toggles pin state. Requires CSRF.
- **FR-6.2** Returns 404 if video isn't cached (can't pin what isn't there).
- **FR-6.3** `DELETE /api/videos/{id}/cache` removes the cache entry immediately. Requires CSRF. Pinned entries can be deleted (explicit user action overrides pin).

### FR-7: Cache admin

- **FR-7.1** `GET /api/admin/cache` returns: `{ total_size_bytes, entry_count, pinned_count, max_bytes, entries: [{ video_id, size_bytes, last_accessed_at, pinned }, ...top_10_by_size] }`.
- **FR-7.2** Auth required (session). No CSRF (safe GET).

### FR-8: Configuration

- **FR-8.1** Three new env vars added to `Config` (see Config section).
- **FR-8.2** `.env.example` documents all three with defaults.
- **FR-8.3** `docs/config.md` "Media server features (M4–M8)" section is updated with M4 env vars marked "Available in M4."
- **FR-8.4** When `CASTIFY_VIDEO_CACHE_ENABLED=false`, the entire feature is off — no `/cached-stream` route registered, no tee on `/stream`, no manifest queries on `open_stream_url`. Zero overhead.

## Non-functional requirements

| Category    | Requirement                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Performance | Second play of cached video: TTFB < 100 ms, throughput disk-bound (> 100 MB/s on SSD, > 30 MB/s on spinning rust).                       |
| Performance | Cache write overhead on first play: < 5% throughput impact (async tee, 8 MB buffer).                                                       |
| Performance | Eviction run cost: < 100 ms for typical sizes (< 1000 entries).                                                                            |
| Reliability | Disk-full events degrade gracefully: cache writes fail, playback continues, admin endpoint reports disk-full state.                        |
| Reliability | Server restart preserves cache (SQLite manifest + on-disk files persist).                                                                  |
| Reliability | Crash between file delete and manifest delete self-heals within 10 minutes (background sweep).                                              |
| Security    | Cached-stream endpoint requires authenticated session. Provider tokens still never exposed to the browser (cached bytes are unauthenticated file bytes). |
| Operability | Cache admin endpoint surfaces actionable state: total size, top entries, pinned count, eviction stats.                                    |

## Configuration

Three new env vars:

| Variable                            | Default                      | Description                                                                              |
| ----------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `CASTIFY_VIDEO_CACHE_ENABLED`         | `false`                      | Master switch. When false, the feature is entirely absent (no routes, no overhead).       |
| `CASTIFY_VIDEO_CACHE_MAX_BYTES`       | `10737418240` (10 GiB)        | Soft limit. Eviction kicks in when total cached size exceeds this.                       |
| `CASTIFY_VIDEO_CACHE_DIR`             | `<DATA_DIR>/video-cache`     | Directory holding cached video files. Created on startup if missing.                     |

## Acceptance criteria (milestone-level)

- [x] `crates/cache/` exists with the API in FR-1, all unit tests pass
- [ ] ⏳ Thumbnail cache migrated to use `crates/cache/`; existing thumbnail tests pass unchanged — deferred (mechanical, low priority)
- [x] Schema migration `0007_video_cache.sql` applies cleanly on existing DBs
- [x] With cache enabled: first play of a video caches it; second play serves from cache
- [ ] ⏳ Second play: TTFB < 100 ms, throughput > 100 MB/s on SSD — not benchmarked (pipeline ships, perf untested)
- [x] Eviction triggers correctly when limit exceeded; pinned entries survive (repo tests verify candidates; `evict_to_target` wired)
- [x] `POST /api/videos/{id}/cache { pinned: true }` works; `DELETE /api/videos/{id}/cache` works
- [x] `GET /api/admin/cache` returns correct stats
- [x] With cache disabled: zero behavioral change vs M3.5
- [ ] ⏳ Background sweep cleans orphaned entries within 10 min — deferred (`sweep_orphans()` exists, periodic task not wired)
- [ ] ⏳ Disk-full events don't break playback — partially handled (cache write failure logged at warn, playback continues; no explicit disk-full detection)
- [x] All new env vars documented in `.env.example` and `docs/config.md`
- [x] `cargo build --workspace && cargo clippy --workspace --all-targets && cargo test --workspace` clean

## Dependencies

- **M3.5 — Streaming Posture Refactor** (complete): the proxy being audited and instrumented is what we're caching.
- **Internal:** `crates/storage/` (migrations), `crates/catalog/` (for the new `StreamUrl::Cached` variant), `crates/api/` (for routes).

## Risks

| Risk                                              | Impact | Mitigation                                                                                                                  |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| Stream-through tee introduces backpressure         | Med    | Use a bounded channel (8 MB worth of chunks). If channel full, prefer dropping the disk write over blocking the HTTP response. |
| SQLite manifest becomes write-through bottleneck   | Low    | Manifest writes are batched (one transaction per `put`/`touch`/`delete`). Touch is debounced for repeated reads within 60s.   |
| Disk space exhaustion in production                 | Med    | Conservative default limit (10 GiB). Admin endpoint surfaces current usage. `df` check on startup warns if free space < limit. |
| Concurrent writes to same video                     | Low    | Per-key `tokio::sync::Mutex` serializes writes. Concurrent reads are fine.                                                    |
| Orphan files accumulate                             | Low    | Background sweep every 10 min. Sweep is idempotent and cheap (directory scan + diff against manifest).                        |
| Migration of thumbnail cache regresses behavior     | Med    | Keep `thumbnail_status` semantics unchanged. Mechanical migration with all existing tests passing unchanged.                  |

## Open questions resolved

- **Cache module placement**: new crate `crates/cache/`. Avoids circular deps; M6 (transcoding) can consume it from `crates/catalog/`.
- **Population strategy**: stream-through (write as we serve). Zero extra provider hits; cache hit available immediately after first play.
- **Cache invalidation**: `provider_file_id` mismatch on `get`; explicit DELETE; LRU. No TTL.
- **Pin semantics**: manual only in M4. Auto-pin policies (favorites, etc.) deferred.
- **Partial stream cache**: evict, don't resume. Resume is a future enhancement once we have telemetry on how often it'd help.
- **Encryption at rest**: not built. OS-level encryption is the right layer.
