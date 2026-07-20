# PRD: M5 — Codec Model (ffprobe)

> **Status:** ✅ Complete — ffprobe shell-out shipping, codec map (16+ codecs) live, lazy probe fires on every `/stream-url` call. Admin endpoints shipped. Eager post-scan sweep deferred.
> **Companion:** [`ROADMAP-self-hosted-media-server.md`](../ROADMAP-self-hosted-media-server.md), [`m4-hot-video-cache.md`](./m4-hot-video-cache.md).

## Implementation deviations

The following were specified in the baseline PRD but changed or deferred during implementation:

- **ffmpeg binding**: PRD specified `ffmpeg-the-third` (static-linked Rust crate). Implementation shells out to system `ffprobe` binary instead. Rationale: simpler, works immediately, avoids heavy build dependency. The probe module's public API (`probe_video(bytes)`) is designed so a future swap to `ffmpeg-the-third` is localized to `crates/catalog/src/probe.rs`.
- **Runtime requirement**: `ffprobe` must be installed on the host. Most Linux distros package it via `apt install ffmpeg`. The Docker image must include ffmpeg.
- **Eager post-scan sweep**: `fetch_pending_probe_ids()` and `CASTIFY_PROBE_ON_SCAN` config exist. The scanner integration that triggers background probing after scan completion is not yet wired. Only lazy (on-first-play) probing runs today.
- **Codec map coverage**: 16 video codecs + 10 audio codecs mapped (PRD targeted ≥20 total). Coverage is sufficient for common libraries; exotic codecs fall through to `DependsOnBrowser` (try direct, fall back to transcode).

## Purpose

M5 makes Castify codec-aware. The catalog learns the true video codec, audio codec, bitrate, and framerate of every played file. This is the prerequisite for M6 transcoding decisions ("is this browser-playable?"), M7 adaptive bitrate ("what variants should we generate?"), and M8 subtitle routing ("are these subs embedded, and in what format?").

Today the schema has only `mime_type` (provider-declared, often wrong or generic like `video/mp4`) and `width` / `height` / `duration_ms` (provider-reported). Probing the file directly with ffprobe gives ground truth.

## In scope

- **Add `ffmpeg-the-third` crate to the workspace** (static-linked per locked decision). Multi-minute initial build; acceptable.
- **Schema migration `0008_video_codec.sql`** — add codec columns to `videos`.
- **Probe module** in `crates/catalog/src/probe.rs` — wraps `ffmpeg-the-third` for read-only probing.
- **Hybrid probe trigger**:
  - **Lazy**: on first play (in `/stream-url` handler), queue a probe task if `probed_at IS NULL`
  - **Eager**: after scan completion, background-task probes all un-probed videos up to `CASTIFY_PROBE_CONCURRENCY` parallel
- **Byte-efficient probing**: download the first ~1 MB of the file via existing `open_stream(file_id, Some("bytes=0-1048576"))` and probe from the buffer. ffprobe needs only the header for codec identification in most container formats.
- **Codec compatibility map** — static `BROWSER_CODEC_SUPPORT: HashMap<Codec, Support>` baked into `crates/catalog`. Encodes "is this codec browser-playable in 2024+" for ~20 common codecs.
- **Embedded subtitle track extraction at probe time** — when probing, also extract the list of embedded tracks (language, codec, format family: text/image). Populates new `video_subtitle_tracks` table. Byte content (PGS images, ASS text) is fetched on-demand later (M8).

## Out of scope (deferred)

- Transcoding itself — that's M6.
- Adaptive bitrate — M7.
- Burning subtitles into video — M8.
- Hardware-accelerated probing — ffprobe is fast enough on CPU; not worth the complexity.
- Re-probing on schedule (probe is once-per-video; re-probe only on `provider_file_id` change).
- Codec support for "modern but rare" codecs (e.g., AV1 with film grain synthesis) — covered when reported by users.
- Updating probe data when user replaces the file at the provider (re-scan picks up new `provider_modified_at`, triggers re-probe).

## Architecture decisions (locked)

| Area                                | Choice                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ffmpeg binding**                  | `ffmpeg-the-third` crate (static-linked). Compiles ffmpeg into the Rust binary. ~3 min clean build, ~30s incremental. Accepted tradeoff — Castify stays single-binary, no runtime ffmpeg dependency. |
| **Probe trigger**                   | Hybrid: lazy on first play (zero scan delay) + eager background post-scan (most videos probed before user clicks them). Driven by `probed_at IS NULL` filter. |
| **Probe byte budget**               | 1 MB Range request. Sufficient for codec/format identification in MP4/MKV/AVI/WMV/MOV containers. If ffprobe needs more (rare), the probe fails gracefully with `probed_at = NULL` and `probe_status = 'needs_more_bytes'`. M5 ships "fail gracefully" — multi-range probe is a follow-up. |
| **Probe concurrency**               | `CASTIFY_PROBE_CONCURRENCY=2` (default). Background tasks run via `tokio::spawn` with a `Semaphore` to bound concurrency. Lazy (on-play) probes bypass the queue (single-task per request). |
| **Codec compatibility map source**   | Curated from MDN + caniwrite data, baked into `crates/catalog/src/codec_support.rs`. ~20 entries covering H.264, H.265/HEVC, VP8, VP9, AV1, MPEG-2, MPEG-4 Part 2, WMV3, WVC1, DivX, Xvid, MJPEG, ProRes, DNxHD, Theora, plus audio codecs (AAC, MP3, Opus, Vorbis, AC3, DTS, FLAC, PCM). Values: `Yes`, `No`, `DependsOnBrowser`, `DependsOnProfile`. |
| **Embedded subtitle tracks schema**   | New table `video_subtitle_tracks` (separate from existing `video_subtitles` which holds sidecar files). Different lifecycle (embedded tracks are part of the file; sidecars are separate files), different concerns. M8 unifies them at the API layer. |
| **Probe status column**                | New `probe_status TEXT` column on `videos`. Values: `pending`, `probed`, `failed`, `needs_more_bytes`, `unsupported_container`. Drives whether to retry. |
| **Re-probe policy**                  | Trigger when `provider_file_id` changes (file replaced at provider) OR when explicit admin request (`POST /api/admin/reprobe/{video_id}`). No scheduled re-probe. |
| **Failure handling**                  | Probe failures don't block playback. `/stream-url` continues to work without codec info (treats as "assume browser can play, fall back to download on canPlayType failure"). Failed probes surface in admin endpoint. |

## Schema migration `0008_video_codec.sql`

```sql
-- Codec + probe metadata. Populated by M5 probe workers.
ALTER TABLE videos ADD COLUMN video_codec TEXT;
ALTER TABLE videos ADD COLUMN audio_codec TEXT;
ALTER TABLE videos ADD COLUMN bitrate INTEGER;
ALTER TABLE videos ADD COLUMN framerate REAL;
ALTER TABLE videos ADD COLUMN probed_at TEXT;
ALTER TABLE videos ADD COLUMN probe_status TEXT NOT NULL DEFAULT 'pending';

-- Embedded subtitle tracks (extracted at probe time, byte content fetched on-demand in M8).
CREATE TABLE video_subtitle_tracks (
    id                TEXT PRIMARY KEY NOT NULL,
    video_id          TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    embedded_index    INTEGER NOT NULL,         -- ffprobe stream index
    codec             TEXT NOT NULL,             -- e.g. 'hdmv_pgs_subtitle', 'ass', 'subrip'
    format_family     TEXT NOT NULL,             -- 'text' | 'image' (drives M8 routing)
    language          TEXT,
    title             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, embedded_index)
);

CREATE INDEX idx_subtitle_tracks_video ON video_subtitle_tracks(video_id);
```

## Functional requirements

### FR-1: ffmpeg-the-third dependency

- **FR-1.1** `ffmpeg-the-third` added to workspace `Cargo.toml` and to `crates/catalog/Cargo.toml`.
- **FR-1.2** Build succeeds on Linux (CI environment). macOS/Windows build documented if it differs.
- **FR-1.3** Build time impact measured and documented in `crates/catalog/README.md` (or similar). Initial clean build: expected ~3 min.
- **FR-1.4** No runtime ffmpeg dependency. Verified by running the binary in a clean container without ffmpeg installed.

### FR-2: Probe module

- **FR-2.1** New module `crates/catalog/src/probe.rs` exposes `pub async fn probe_video(bytes: &[u8]) -> ProbeResult<ProbeInfo>`.
- **FR-2.2** `ProbeInfo` contains: `video_codec`, `audio_codec`, `bitrate`, `framerate`, `embedded_subtitle_tracks: Vec<EmbeddedTrack>`.
- **FR-2.3** `EmbeddedTrack`: `embedded_index`, `codec`, `format_family`, `language`, `title`.
- **FR-2.4** `ProbeResult` enum: `Ok(ProbeInfo)`, `NeedsMoreBytes`, `UnsupportedContainer(String)`, `Failed(String)`.
- **FR-2.5** Probe runs in `tokio::task::spawn_blocking` (ffmpeg-the-third is sync).
- **FR-2.6** Unit tests cover: MP4 (H.264/AAC), MKV (H.265/Opus + ASS subtitle), AVI (MPEG-4/Xvid), WebM (VP9/Opus), malformed bytes (returns Failed).

### FR-3: Byte-efficient probing

- **FR-3.1** Probe worker calls `provider.open_stream(file_id, Some("bytes=0-1048576"))` (1 MB).
- **FR-3.2** Collects bytes into `Vec<u8>` (not streaming — 1 MB is fine to buffer).
- **FR-3.3** Calls `probe_video(&bytes)`.
- **FR-3.4** On `NeedsMoreBytes`, the probe is retried once with 4 MB. On second failure, recorded as `probe_status = 'needs_more_bytes'` and abandoned.
- **FR-3.5** Bytes are downloaded through the existing factory/connection/token pipeline (no new auth path).

### FR-4: Hybrid probe trigger

- **FR-4.1** **Lazy path**: `/stream-url` handler checks if `probed_at IS NULL` for the video. If so, spawns a probe task (`tokio::spawn` — fire and forget) and continues serving. The probe runs in the background; first-play latency is unaffected.
- **FR-4.2** **Eager path**: scan completion (`scan.rs::run_scan`) spawns a background task that iterates `videos WHERE probe_status = 'pending'`, probes each up to `CASTIFY_PROBE_CONCURRENCY` parallel.
- **FR-4.3** Both paths funnel into a shared `probe_worker` function that handles deduplication (skip if `probed_at IS NOT NULL` by the time the task runs).
- **FR-4.4** Probe worker writes results via a single SQL UPDATE: `SET video_codec, audio_codec, bitrate, framerate, probed_at = now, probe_status = 'probed' WHERE id = ?`.
- **FR-4.5** Embedded subtitle tracks are upserted in the same transaction.

### FR-5: Codec compatibility map

- **FR-5.1** New module `crates/catalog/src/codec_support.rs`.
- **FR-5.2** `pub fn is_browser_playable(video_codec: &str, audio_codec: &str) -> BrowserSupport` returns one of `Yes`, `No`, `DependsOnBrowser`, `DependsOnProfile`.
- **FR-5.3** Map covers ≥ 20 codecs (video + audio).
- **FR-5.4** `BrowserSupport` has a `as_strategy() -> TranscodeDecision` method returning `PlayDirect`, `MustTranscode`, `ProbeUserProfile`, `TryDirectFallbackToTranscode`.
- **FR-5.5** Map is documented with source (MDN URL, caniuse data) per codec.

### FR-6: Probe admin

- **FR-6.1** `GET /api/admin/probe` returns: `{ total, probed, pending, failed, needs_more_bytes, unsupported_container }`.
- **FR-6.2** `POST /api/admin/reprobe/{video_id}` queues a re-probe for a single video. Requires CSRF.
- **FR-6.3** `POST /api/admin/reprobe-all` re-probes all `probe_status != 'probed'` videos. Requires CSRF. Returns 202 (queued).

### FR-7: Configuration

- **FR-7.1** Two new env vars: `CASTIFY_PROBE_ON_SCAN=true` (default), `CASTIFY_PROBE_CONCURRENCY=2` (default).
- **FR-7.2** When `CASTIFY_PROBE_ON_SCAN=false`, only the lazy path (probe on first play) runs. Eager post-scan probe is suppressed.
- **FR-7.3** `.env.example` and `docs/config.md` updated.

## Non-functional requirements

| Category    | Requirement                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Performance | Probe of a 1 MB Range: < 500 ms wall-clock (provider fetch + ffprobe on commodity CPU).                                                       |
| Performance | Eager post-scan probe throughput: ≥ 2 videos/sec at default concurrency, bounded by provider API rate limits rather than local CPU.            |
| Performance | Probe instrumentation overhead: zero on the play path (lazy probe is fire-and-forget; first-play latency unaffected).                          |
| Reliability | Probe failures never block playback or scanning. Failed probes surface in admin endpoint and are retryable.                                  |
| Reliability | ffmpeg-the-third panic in probe is caught (catch_unwind); the probe is recorded as `failed` and the worker continues with the next video.     |
| Portability | ffmpeg-the-third builds on Linux (primary deployment target). macOS build documented if it works; Windows not supported in M5.                |
| Operability  | Probe stats visible via admin endpoint. Per-video probe status visible in DB (debugging via sqlite3 CLI).                                    |

## Configuration

Two new env vars:

| Variable                            | Default | Description                                                                              |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `CASTIFY_PROBE_ON_SCAN`               | `true`  | When true, scan completion triggers background probing of all un-probed videos.           |
| `CASTIFY_PROBE_CONCURRENCY`           | `2`     | Parallel probe workers for the eager path. Lazy path bypasses this (one task per request). |

## Acceptance criteria (milestone-level)

> **See Implementation Deviations above** — the `ffmpeg-the-third` items below were replaced with system `ffprobe` shell-out. Items marked ⏳ are deferred.

- [ ] ~~`ffmpeg-the-third` builds as part of `cargo build --workspace`~~ → replaced by system `ffprobe` shell-out
- [x] Schema migration `0008_video_codec.sql` applies cleanly on existing DBs
- [x] Probe module passes unit tests for MP4, MKV, AVI, WebM, and malformed input
- [x] Probe correctly identifies H.264, H.265, VP9, AV1, MPEG-2, WMV3, DivX, AAC, MP3, Opus, Vorbis, AC3
- [x] Embedded subtitle tracks detected and stored for MKV files with embedded subs
- [x] Lazy probe triggers on first play of an un-probed video
- [ ] ⏳ Eager probe runs after scan completion, bounded by `CASTIFY_PROBE_CONCURRENCY` — deferred (scanner integration not wired)
- [x] Codec compatibility map covers ≥ 20 codecs; `is_browser_playable` returns correct decisions
- [x] `GET /api/admin/probe` returns accurate stats
- [x] `POST /api/admin/reprobe/{id}` and `POST /api/admin/reprobe-all` work
- [x] Probe failures recorded as `failed` and don't crash the worker pool
- [ ] ~~Castify binary runs in a clean container without ffmpeg installed~~ → requires system `ffprobe` at runtime
- [x] All existing M0–M4 tests pass unchanged
- [x] `cargo build --workspace && cargo clippy --workspace --all-targets && cargo test --workspace` clean

## Dependencies

- **M4 — Hot Video Disk Cache** (complete): `crates/cache/` exists; the probe worker can optionally use the cache for repeated probes (not required for M5).
- **Internal:** `crates/catalog/` (probe module, codec map, schema), `crates/api/` (admin endpoints).
- **External:** `ffmpeg-the-third` Rust crate (compiled from source).

## Risks

| Risk                                              | Impact | Mitigation                                                                                                                  |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| ffmpeg-the-third build is broken on stable Rust    | High   | Pin a known-good version in `Cargo.toml`. CI builds the workspace; failure is a release blocker until resolved.             |
| ffmpeg-the-third compile time > 5 min              | Med    | Document; CI caches `target/` across runs. Local devs use `cargo check` for fast iteration.                                  |
| 1 MB probe insufficient for some containers        | Med    | Retry once with 4 MB on `NeedsMoreBytes`. Track failure rate in production; if > 5%, ship multi-range probe in a follow-up. |
| Provider rate-limits the eager probe path           | Med    | Concurrency defaults to 2 (conservative). Provider 429 responses back off exponentially (existing `RateLimited` handling).   |
| Probe panic crashes the worker pool                  | Low    | `catch_unwind` around the probe call; failed video marked, worker continues.                                                  |
| Static-linked ffmpeg binary size grows significantly | Low    | Acceptable; expected ~30 MB increase. Release builds strip debug symbols.                                                    |
| Codec map gets out of date as browsers evolve        | Low    | Each entry cites its source (MDN revision, caniuse data). Annual review scheduled via a `# TODO: review` comment with date.   |

## Open questions resolved

- **ffmpeg binding**: static-linked `ffmpeg-the-third`. Castify stays single-binary; distroless Dockerfile unchanged.
- **Probe trigger**: hybrid (lazy on first play + eager post-scan). Best of both: no scan delay, most videos probed before click.
- **Probe byte budget**: 1 MB Range with one 4 MB retry. Sufficient for the vast majority of containers.
- **Probe concurrency**: `CASTIFY_PROBE_CONCURRENCY=2` (conservative default).
- **Codec map source**: hand-curated from MDN + caniuse. Reviewed annually.
- **Embedded subtitle tracks schema**: separate table (`video_subtitle_tracks`) — different lifecycle from sidecar files (`video_subtitles`).
- **Re-probe policy**: on `provider_file_id` change or admin request. No scheduled re-probe.
- **Failure handling**: probe failures never block playback.
