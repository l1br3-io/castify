# PRD: M6 — Server-Side Transcoding

> **Status:** ✅ Complete (reduced scope) — ffmpeg shell-out shipping, HLS output live, trigger logic wired into `/stream-url`. HW accel, worker pool, idle timeout, bounded queue, partial resume, and frontend integration all deferred.
> **Companion:** [`ROADMAP-self-hosted-media-server.md`](../ROADMAP-self-hosted-media-server.md), [`m5-codec-model.md`](./m5-codec-model.md).

## Implementation deviations

M6 is the largest milestone in the arc. The baseline PRD specified an ambitious feature set; implementation delivered the core transcode pipeline and deferred several additive improvements. The deferred items can land incrementally without rework.

### What shipped

- ✅ ffmpeg shell-out (system `ffmpeg` binary, not `ffmpeg-the-third`)
- ✅ HLS output (`.m3u8` playlist + `.ts` segments, 10-sec segments)
- ✅ CPU-only encoding (H.264 High@L4.0 + AAC 128k, libx264 veryfast preset)
- ✅ Variant scaling (720p cap without upscaling)
- ✅ Three HLS endpoints (`master.m3u8`, `{variant}/playlist.m3u8`, `{variant}/{segment}.ts`)
- ✅ Provider stream piped to ffmpeg stdin (on-the-fly, no full download first)
- ✅ Process-level dedup (concurrent requests for same video share one ffmpeg process)
- ✅ Trigger logic in `get_stream_url` via `codec_strategy()` from M5
- ✅ `StreamUrl::Transcode` variant + frontend DTO
- ✅ Schema migration `0009_transcode_cache.sql`
- ✅ Config (`TranscodeConfig` with 4 env vars)

### What's deferred

- ⏳ **`ffmpeg-the-third` static linking** — shelled out to system `ffmpeg` instead. Swap is localized to `crates/api/src/transcode.rs`.
- ⏳ **Hardware acceleration** — no NVENC/VAAPI/VideoToolbox detection. CPU-only via `libx264`. Adding HW accel means changing ffmpeg args based on a startup probe.
- ⏳ **Dedicated worker pool** — no thread pool sized to CPU/2. Uses a process-level `OnceLock<Mutex<HashMap>>` for dedup. Concurrent transcodes of *different* videos are unbounded (each spawns its own ffmpeg process).
- ⏳ **Bounded queue + 503 backpressure** — no `CASTIFY_TRANSCODE_QUEUE_MAX`. Concurrent requests for different videos all spawn ffmpeg processes. Under extreme load this could exhaust system resources.
- ⏳ **Idle timeout** — workers run to completion (no idle shutdown). A video that's requested once transcodes fully even if the client disconnects.
- ⏳ **Partial cache resume** — ffmpeg starts from scratch each time. The `-ss` seek flag for resuming from the last completed segment is not wired.
- ⏳ **Frontend integration (hls.js)** — API endpoints are ready and tested. The frontend player changes (lazy-load hls.js, detect Safari native HLS, wire `<video>` to HLS stream) are not yet built.
- ⏳ **Transcode cache manifest integration** — the `transcode_cache_entries` table exists but `ensure_transcode_started` uses filesystem checks instead of the manifest. Wiring the manifest would enable proper cache stats, LRU eviction, and resume.
- ⏳ **LRU eviction for transcode cache** — no eviction logic wired. Cache grows unbounded until manual cleanup.

## Purpose

M6 makes Castify play any video file regardless of source codec. The browser can't decode H.265/HEVC, WMV3, DivX, MPEG-2, or a dozen other codecs natively; today those files hit the "unsupported format, download instead" wall. M6 replaces that wall with a server-side transcode pipeline: the file is transcoded to H.264/AAC HLS on the fly, served to an hls.js-powered player.

This is the milestone that makes Castify a real self-hosted media server (Plex/Jellyfin class) rather than a cloud video browser. Self-hosted hardware means we have CPU and disk to burn on smoothness.

## In scope

- **Transcode pipeline** built on `ffmpeg-the-third` (added in M5):
  - Input: bytes from the provider via `open_stream(file_id, range)`
  - Output: HLS segments (.ts) + master playlist (.m3u8) on disk
  - Output cached in a separate cache pool (reuses `crates/cache/`)
- **Hardware acceleration detection** at startup:
  - Try in order: NVENC (NVIDIA) → VAAPI (Linux Intel/AMD) → VideoToolbox (macOS) → CPU fallback
  - Active method logged on startup; configurable via `CASTIFY_TRANSCODE_HW_ACCEL`
- **Worker pool**:
  - Dedicated thread pool sized to `CASTIFY_TRANSCODE_WORKER_THREADS` (default: `cpu_count / 2`)
  - One worker per `(video_id, variant, profile)` cache key
  - Reference-counted: concurrent plays of the same video share one worker
  - Idle timeout: 5 min (configurable) with no segment requests → worker shuts down, partial cache kept
- **Cache key**: `(video_id, variant, profile)` where `variant` is the target quality (e.g. `720p`) and `profile` encodes HW accel + encoder settings. Prevents stale cache when hardware changes.
- **Three new endpoints**:
  - `GET /api/videos/{id}/transcode/master.m3u8` — master playlist listing all available variants
  - `GET /api/videos/{id}/transcode/{variant}/playlist.m3u8` — per-variant playlist
  - `GET /api/videos/{id}/transcode/{variant}/{segment}.ts` — segment bytes
- **Frontend integration**:
  - `hls.js` for non-Safari browsers; native HLS for Safari
  - `use-stream-url` hook extends to return transcode URL when codec is unsupported
  - Player falls back to existing direct/proxy path when codec IS browser-playable
- **Trigger logic**: in `open_stream_url`, check `is_browser_playable(video_codec, audio_codec)` (from M5). If `MustTranscode`, return transcode master URL. If `TryDirectFallbackToTranscode`, try direct first; on browser `canPlayType` failure, frontend re-requests with `?force_transcode=true`.
- **Cancellation**: workers check a cancellation token between segments. `DELETE /api/videos/{id}/transcode` cancels immediately.
- **Saturation handling**: bounded queue (`CASTIFY_TRANSCODE_QUEUE_MAX=8`). When full, new requests get 503 + `Retry-After`.
- **Schema migration `0009_transcode_cache.sql`** — `transcode_cache_entries` table.

## Out of scope (deferred)

- Adaptive bitrate ladder with multiple variants — that's M7. M6 ships **single-variant** transcode (the "best for source, capped at 720p" default). M7 adds the ladder.
- Burning image-based subtitles into the video frame — that's M8.
- Pre-transcoding the entire library on scan — too expensive; M6 is on-demand only.
- User-uploaded custom transcode profiles — single default profile in M6.
- Re-transcoding when source file changes — handled by cache invalidation on `provider_file_id` change.
- Streaming output directly without disk cache (pass-through mode) — disk cache is the simpler design; pass-through is a future optimization.
- Transcoding for download (only for streaming).

## Architecture decisions (locked)

| Area                                | Choice                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Output format**                   | HLS (`.m3u8` + `.ts` segments). Adaptive-ready for M7. ~10 second segments (default; configurable).                                                                                                                                                                                                                                                  |
| **Default codec + profile**         | H.264 (yuv420p, High profile, level 4.0) + AAC (192 kbps stereo). Plays in every modern browser via hls.js or native HLS.                                                                                                                                                                                                                            |
| **Default variant**                 | Best-for-source, capped at 720p. Source ≤ 720p → transcode at source resolution. Source > 720p → transcode down to 720p. No upscaling. M7 adds the ladder.                                                                                                                                                                                              |
| **ffmpeg binding**                  | `ffmpeg-the-third` (carried from M5). Same static-linked binary.                                                                                                                                                                                                                                                                                       |
| **Worker thread model**              | Dedicated thread pool, size = `CASTIFY_TRANSCODE_WORKER_THREADS` (default `cpu_count / 2`). ffmpeg-the-third is sync; workers run ffmpeg in their own thread, communicate segment-readiness via `tokio::sync::mpsc`. HTTP handlers fetch segments from disk once ready.                                                                                  |
| **Worker reference counting**         | One worker per `(video_id, variant, profile)`. Concurrent HTTP requests increment a refcount on the worker handle; worker exits when refcount = 0 AND idle timeout expires. Prevents redundant transcodes when multiple clients play the same video.                                                                                                |
| **Cache storage**                    | `<data_dir>/transcode-cache/<video_id>/<variant>/<profile>/<segment>.ts`. Reuses `crates/cache/` from M4 (separate pool, separate eviction).                                                                                                                                                                                                            |
| **Cache key**                        | `(video_id, variant, profile)`. Profile encodes HW accel method + encoder settings. Changing hardware or `CASTIFY_TRANSCODE_HW_ACCEL` invalidates old caches naturally (different profile string).                                                                                                                                                       |
| **Hardware acceleration**            | Auto-detect at startup: NVENC → VAAPI → VideoToolbox → CPU. Override via `CASTIFY_TRANSCODE_HW_ACCEL=auto|nvenc|vaapi|videotoolbox|cpu`. Logged on startup. CPU fallback always works.                                                                                                                                                                  |
| **Segment readiness notification**    | Worker writes segment file + updates manifest; HTTP handler polls manifest or waits on a `Notify` if segment is in-flight. Default behavior: handler serves segments already on disk; if next segment not yet ready, waits up to 30s (configurable) then 503.                                                                                            |
| **Frontend player integration**       | hls.js loaded lazily (only when transcode path is taken). Safari uses native HLS via `<video src=".../master.m3u8">`. Custom controls (existing) remain in charge.                                                                                                                                                                                        |
| **Idle timeout**                     | 5 minutes default (configurable via `CASTIFY_TRANSCODE_IDLE_TIMEOUT_SECS=300`). Worker keeps running if any segment was requested within the window.                                                                                                                                                                                                    |
| **Queue + saturation**               | Bounded async queue of pending transcode requests, size = `CASTIFY_TRANSCODE_QUEUE_MAX=8`. When full, new requests get 503 + `Retry-After: 5`.                                                                                                                                                                                                          |
| **Partial cache reuse**              | On worker restart (server restart, eviction-then-re-add), transcode resumes from the last completed segment. Segment files on disk are kept; manifest records `completed_segments`. Worker starts ffmpeg from `completed_segments + 1` via the `-ss` seek flag.                                                                                          |
| **Cancellation**                     | Workers check a cancel token between segments. `DELETE /api/videos/{id}/transcode` triggers immediate cancel. Browser tab close does NOT trigger cancel (user might come back); idle timeout cleans up.                                                                                                                                                       |
| **Disk-full handling**               | Cache writes fail gracefully. Worker logs error, marks cache entry `failed`, transcode stops, HTTP handler returns 503 with a clear error. Player shows "transcode failed — try again or use direct download."                                                                                                                                          |

## Schema migration `0009_transcode_cache.sql`

```sql
-- Transcode cache manifest. One row per (video, variant, profile).
-- Reuses crates/cache/ for file management; this table is the manifest.
CREATE TABLE transcode_cache_entries (
    video_id              TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    variant               TEXT NOT NULL,        -- 'source' | '720p' | '480p' | '360p' (M7 adds the ladder)
    profile               TEXT NOT NULL,        -- e.g. 'h264-high-40-aac192-nvenc'
    output_dir            TEXT NOT NULL,
    master_playlist       TEXT NOT NULL,        -- relative path
    variant_playlist      TEXT NOT NULL,        -- relative path
    total_segments        INTEGER,              -- NULL until transcode completes
    completed_segments    INTEGER NOT NULL DEFAULT 0,
    segment_duration_secs INTEGER NOT NULL DEFAULT 10,
    bitrate               INTEGER,              -- bits/sec; populated when known
    width                 INTEGER,
    height                INTEGER,
    status                TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'in_progress' | 'completed' | 'failed'
    last_error            TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at      TEXT NOT NULL,
    PRIMARY KEY (video_id, variant, profile)
);

CREATE INDEX idx_transcode_status ON transcode_cache_entries(status);
CREATE INDEX idx_transcode_last_accessed ON transcode_cache_entries(last_accessed_at);
```

## Functional requirements

### FR-1: Transcode pipeline

- **FR-1.1** New module `crates/catalog/src/transcode.rs` exposes `pub async fn start_transcode(input: TranscodeInput, output: TranscodeOutput) -> TranscodeResult<TranscodeHandle>`.
- **FR-1.2** `TranscodeInput`: `{ provider bytes source (StreamResponse), source_codec, source_bitrate, source_resolution }`.
- **FR-1.3** `TranscodeOutput`: `{ output_dir, variant, profile, segment_duration_secs }`.
- **FR-1.4** `TranscodeHandle`: `{ cancel_token, segment_ready_rx (channel), completion_rx (oneshot) }`.
- **FR-1.5** Pipeline configures ffmpeg-the-third with:
  - Video decoder: auto-detected from source codec
  - Video encoder: H.264 (High profile, level 4.0, yuv420p)
  - Audio encoder: AAC (192 kbps stereo)
  - Container: MPEG-TS segments for HLS
  - Segment duration: 10 seconds (default)
  - HW accel method: from `profile` string
- **FR-1.6** Pipeline emits one `SegmentReady { index, path }` message per segment.
- **FR-1.7** Pipeline emits one `Completion { total_segments, bitrate, width, height }` on finish.
- **FR-1.8** Pipeline emits `Failure { segment_index, error }` on error; transcode halts.

### FR-2: Worker pool

- **FR-2.1** `TranscodePool` holds N worker threads (`CASTIFY_TRANSCODE_WORKER_THREADS`), a registry of active handles, and a bounded request queue.
- **FR-2.2** When a transcode is requested: pool checks registry for existing worker on same `(video_id, variant, profile)`. If found, increment refcount and return its handle.
- **FR-2.3** If not found and queue has room: enqueue; worker thread picks up, runs `start_transcode`, registers handle.
- **FR-2.4** If queue full: return `TranscodeError::PoolFull` immediately. API layer returns 503 + `Retry-After: 5`.
- **FR-2.5** Refcount decreases on client disconnect (HTTP response dropped). When refcount = 0 AND idle timeout expires, worker cancels and unregisters.
- **FR-2.6** Pool stats exposed via `GET /api/admin/transcode` (workers active, queue depth, completed/failed counts).

### FR-3: HTTP endpoints

- **FR-3.1** `GET /api/videos/{id}/transcode/master.m3u8` returns the HLS master playlist. If no transcode exists yet, kicks off a default-variant transcode and returns the playlist (with only the default variant listed) once the first segment is ready.
- **FR-3.2** `GET /api/videos/{id}/transcode/{variant}/playlist.m3u8` returns the per-variant playlist, listing segments that are ready. If transcode in-progress, playlist lists completed segments with `#EXT-X-VERSION:6` and updates as new segments land (client polls).
- **FR-3.3** `GET /api/videos/{id}/transcode/{variant}/{segment}.ts` returns segment bytes from disk. Returns 404 if segment not ready (client retries per playlist).
- **FR-3.4** `DELETE /api/videos/{id}/transcode` cancels the active transcode for the video. Requires CSRF. Returns 204.
- **FR-3.5** All endpoints require authenticated session. Master + variant playlist + segment are safe GETs (no CSRF).
- **FR-3.6** Endpoints return 503 + `Retry-After: 5` when transcode pool is saturated.

### FR-4: Trigger logic

- **FR-4.1** `open_stream_url` (existing) is extended:
  - If `is_browser_playable(video_codec, audio_codec) == Yes` → existing logic (direct or proxy)
  - If `MustTranscode` → return `StreamUrl::Transcode { master_url: "/api/videos/{id}/transcode/master.m3u8" }`
  - If `TryDirectFallbackToTranscode` → return direct URL with a hint; frontend retries with `?force_transcode=true` on `canPlayType` failure
- **FR-4.2** New `StreamUrl` variant: `Transcode { master_url }`. Frontend uses hls.js to consume.
- **FR-4.3** `?force_transcode=true` query parameter on `/stream-url` overrides the codec check and returns `StreamUrl::Transcode`.

### FR-5: Hardware acceleration

- **FR-5.1** On startup, `TranscodePool::detect_hw_accel()` probes for NVENC, VAAPI, VideoToolbox in order.
- **FR-5.2** Detection: try a tiny test transcode with each backend; first success wins.
- **FR-5.3** Active method logged at startup: `INFO transcode pool started; hw_accel=nvenc, worker_threads=4`.
- **FR-5.4** Override via `CASTIFY_TRANSCODE_HW_ACCEL=auto|nvenc|vaapi|videotoolbox|cpu`.
- **FR-5.5** If selected method unavailable: log warning and fall back to CPU.
- **FR-5.6** Profile string includes accel method (e.g. `h264-high-40-aac192-nvenc`).

### FR-6: Frontend integration

- **FR-6.1** `hls.js` added to `frontend/package.json` (lazy-loaded only when transcode path is taken).
- **FR-6.2** `use-stream-url` hook returns `{ url, strategy }` where `strategy` may now be `"transcode"`.
- **FR-6.3** Watch route detects `strategy: "transcode"` and initializes hls.js with the master playlist URL.
- **FR-6.4** Safari detection: native HLS via `<video src={master_url}>`. No hls.js load.
- **FR-6.5** Existing player controls remain in charge — hls.js attaches to the `<video>` element; controls read from the element's standard APIs.
- **FR-6.6** Transcode errors surface in the player UI: "transcode failed, retrying" or "transcode failed, download instead".

### FR-7: Cache eviction

- **FR-7.1** Separate cache pool size: `CASTIFY_TRANSCODE_CACHE_MAX_BYTES` (default 50 GiB).
- **FR-7.2** LRU eviction by `last_accessed_at`. Runs on each segment write (cheap: one SQL check).
- **FR-7.3** Eviction never removes an in-progress transcode (`status IN ('pending', 'in_progress')`).
- **FR-7.4** Failed entries older than 24 hours are evicted on the background sweep.

### FR-8: Configuration

Seven new env vars:

| Variable                                       | Default             | Description                                                  |
| ---------------------------------------------- | ------------------- | ------------------------------------------------------------ |
| `CASTIFY_TRANSCODE_ENABLED`                      | `true`              | Master switch. When false, codec-incompatible videos hit the existing "download instead" wall. |
| `CASTIFY_TRANSCODE_HW_ACCEL`                     | `auto`              | Hardware acceleration method. `auto|nvenc|vaapi|videotoolbox|cpu`. |
| `CASTIFY_TRANSCODE_CACHE_MAX_BYTES`              | `53687091200` (50 GiB) | Soft limit for transcode cache pool.                          |
| `CASTIFY_TRANSCODE_WORKER_THREADS`               | `cpu_count / 2`     | Worker pool size.                                              |
| `CASTIFY_TRANSCODE_IDLE_TIMEOUT_SECS`            | `300`               | Idle timeout before worker shuts down (no segment requests).   |
| `CASTIFY_TRANSCODE_QUEUE_MAX`                    | `8`                 | Bounded queue size for pending transcode requests.             |
| `CASTIFY_TRANSCODE_SEGMENT_DURATION_SECS`        | `10`                | HLS segment duration.                                            |

## Non-functional requirements

| Category    | Requirement                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Performance | First-segment latency < 3 sec on commodity hardware (4-core CPU, no GPU) for 1080p source → 720p transcode.                                   |
| Performance | Subsequent segments stream without buffering gaps on commodity hardware for source bitrate ≤ 10 Mbps.                                       |
| Performance | Hardware-accelerated first-segment latency < 1 sec when NVENC/VAAPI/VideoToolbox available.                                                  |
| Performance | Concurrent transcodes (up to `WORKER_THREADS`) don't starve each other.                                                                      |
| Reliability | ffmpeg panic is caught; worker records failure, continues serving other workers.                                                            |
| Reliability | Disk-full events degrade gracefully (503 to client, no crash).                                                                                |
| Reliability | Server restart resumes partial transcodes from last completed segment.                                                                       |
| Reliability | Client disconnect doesn't kill the worker (user might come back); idle timeout cleans up.                                                    |
| Security    | All transcode endpoints require authenticated session. DELETE requires CSRF.                                                                  |
| Operability | `GET /api/admin/transcode` surfaces pool state: active workers, queue depth, recent failures, hardware accel method.                          |
| Portability | Builds on Linux (primary). macOS documented. CPU fallback always works.                                                                       |

## Acceptance criteria (milestone-level)

> **See Implementation Deviations above** — many items below were deferred. The core pipeline (schema, ffmpeg shell-out, HLS endpoints, trigger logic) shipped.

- [x] Schema migration `0009_transcode_cache.sql` applies cleanly
- [ ] ⏳ Transcode pipeline transcodes a 1-min H.265/MKV clip to H.264 HLS in < 3 sec first-segment — not benchmarked yet (pipeline ships, perf untested)
- [ ] ⏳ Hardware accel detection — deferred (CPU-only)
- [x] CPU fallback works on a no-GPU Linux machine — CPU is the default
- [x] Worker pool correctly deduplicates concurrent plays of same video — process-level dedup via `OnceLock<Mutex<HashMap>>`
- [ ] ⏳ Idle timeout — deferred
- [ ] ⏳ Queue saturation returns 503 + Retry-After — deferred (no bounded queue)
- [ ] ⏳ hls.js plays transcode output in Chrome + Firefox — frontend integration deferred
- [ ] ⏳ Native HLS plays transcode output in Safari — frontend integration deferred
- [ ] ⏳ Existing player controls work on transcode playback — frontend integration deferred
- [ ] ⏳ `DELETE /api/videos/{id}/transcode` cancels immediately — deferred
- [ ] ⏳ Server restart resumes partial transcode — deferred
- [ ] ⏳ Disk-full events return 503 — not explicitly handled (ffmpeg fails, logged at warn)
- [ ] ⏳ `GET /api/admin/transcode` returns accurate stats — deferred (manifest table not wired)
- [x] All existing M0–M5 tests pass unchanged
- [x] `cargo build --workspace && cargo clippy --workspace --all-targets && cargo test --workspace` clean

## Dependencies

- **M4 — Hot Video Disk Cache** (complete): `crates/cache/` reused for transcode cache pool.
- **M5 — Codec Model** (complete): `is_browser_playable` drives transcode trigger; ffmpeg-the-third already linked.
- **Internal:** `crates/catalog/` (transcode module), `crates/api/` (endpoints, admin), `frontend/` (hls.js integration).
- **External:** `hls.js` npm package (lazy-loaded).

## Risks

| Risk                                              | Impact | Mitigation                                                                                                                  |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| ffmpeg-the-third API is unstable across versions    | High   | Pin a specific version. Wrap ffmpeg calls behind a thin internal trait so future version bumps are scoped to one file.       |
| First-segment latency > 3 sec on commodity CPU       | High   | Acceptable up to 5 sec for M6 ship. Optimize in follow-up: probe-source-codec fast-path, larger keyframe interval, GPU accel. |
| HLS segment gaps during playback on slow CPUs         | High   | Client-side buffer (hls.js default 30s). Server-side: priority queue for the active-playing transcode.                       |
| Hardware accel detection unreliable across distros    | Med    | Auto-detect tries each backend; CPU fallback always works. Force override via env var.                                       |
| Worker pool deadlock under edge-case load             | Med    | Bounded queue + 503 backpressure prevents unbounded growth. Idle timeout prevents leak. Catch_unwind on ffmpeg panics.        |
| Partial cache resume off-by-one errors                 | Med    | Unit tests for resume scenarios. `-ss` seek flag precision verified.                                                          |
| Disk fills up faster than eviction can keep up        | Med    | Conservative default (50 GiB). Background sweep runs every 5 min. Admin endpoint surfaces disk usage.                          |
| hls.js adds significant frontend bundle size            | Low    | Lazy-loaded only when transcode path is taken; not in the main bundle.                                                         |
| Safari native HLS quirks                              | Low    | Test in Safari during M6. Document any quirks (codec selection, subtitle handling).                                            |

## Open questions resolved

- **Output format**: HLS (per locked decision). Sets up M7 cleanly.
- **Default variant**: best-for-source capped at 720p (no upscaling). M7 adds the ladder.
- **Worker model**: dedicated pool (CPU/2). Predictable, composes with M7's multi-variant needs.
- **Cache key**: `(video_id, variant, profile)`. Profile encodes accel + encoder settings.
- **Idle timeout**: 5 min default, configurable.
- **Queue + saturation**: bounded queue, 503 backpressure.
- **Partial cache resume**: yes, via `-ss` seek.
- **Cancellation**: workers check token between segments; explicit DELETE cancels immediately.
- **Frontend integration**: hls.js (lazy-loaded) for non-Safari; native HLS for Safari.
- **Pre-transcode vs on-demand**: on-demand only in M6. Pre-transcode deferred.
