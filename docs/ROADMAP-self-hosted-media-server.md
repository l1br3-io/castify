# Roadmap: Self-Hosted Media Server

> **Status:** Directional overview of the post-launch arc that takes Castify from "cloud video browser" to "self-hosted media server." No dates; dependency-driven sequencing.
> **Companion:** [`VISION.md`](./VISION.md), [`ROADMAP.md`](./ROADMAP.md) (the launch arc M0–M3), per-milestone PRDs under [`docs/prds/`](./prds/).

## Context

Castify shipped its personal-media-server core in M0–M3: connect cloud providers, unify them into one catalog, browse, and play. The launch posture was conservative — never proxy bytes when the browser can fetch directly, never transcode, never burn subtitles. Those prohibitions were artifacts of an earlier "hosted service" framing where server bandwidth cost money.

Castify is **self-hosted only**. The user owns the hardware. Server bandwidth, CPU, and disk are all free. This roadmap unlocks the capabilities that distinction enables: smooth playback for every codec, every network condition, every subtitle format. Plex/Jellyfin-class features, built around the user's own cloud and their own hardware.

## Guiding principle

**Pick the path that delivers the smoothest UX per provider, per network, per codec.** Cost is no longer the optimization target. If a provider's native direct URL is smooth in the browser, use it. If server-side proxying is smoother, proxy. If the browser can't decode the codec, transcode. If the connection is weak, transcode down. If the subtitle format is unrenderable, burn it in.

## Milestones

Six milestones, sequenced by dependency. Each ships independently; each exits only when its PRD's exit criteria are met.

```text
M3.5 (posture refactor + Drive stutter fix)
  │
  ▼
M4 (hot video disk cache + reusable cache module)
  │
  ▼
M5 (ffprobe + codec/bitrate/framerate model)
  │
  ▼
M6 (transcoding — HLS output, hardware accel)   ←─── requires M4 + M5
  │                       │
  ▼                       ▼
M7 (adaptive bitrate)   M8 (advanced subtitles)
```

| #     | Milestone                       | Ships (user-visible)                                                                                               |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| M3.5  | **Streaming posture refactor**  | Doc reframe (UX-first posture); Google Drive playback stutter root-caused and fixed; `/stream` benchmark coverage. |
| M4    | **Hot video disk cache**        | Reusable `crates/cache/` module; re-watching any played video is disk-fast; manual pin/unpin of favorites.          |
| M5    | **Codec model + ffprobe**       | Catalog knows the true video/audio codec, bitrate, and framerate of every played file; enables M6+ transcoding decisions. |
| M6    | **Server-side transcoding**     | Any file in the user's library plays smoothly in the browser regardless of source codec. HLS output, hardware-accelerated when available. |
| M7    | **Adaptive bitrate**            | Smooth playback on weak remote connections (phone far from home, hotel Wi-Fi). Multi-bitrate ladder with hls.js ABR. |
| M8    | **Advanced subtitles**          | ASS renders with full styling (libass.js); PGS/VobSub burned into the video frame; embedded MKV subtitles extracted and routed. |

## Dependency notes

- **M3.5 is the foundation.** Every later milestone assumes a fast proxy. The Drive stutter audit and fix land here.
- **M4 is the prereq for M6's transcode cache** (separate cache pool, but reuses the module).
- **M5 is the prereq for M6's transcoding decisions** (codec awareness drives the "is this browser-playable?" check).
- **M6 is the prereq for M7** (HLS output enables ABR) and **for M8** (transcode pipeline powers burn-in).
- **M7 and M8 are independent** of each other; either can ship first.

## Cross-cutting concerns

**Schema evolution** — sequential migration files, no numbering conflicts:
- M3.5: no migration
- M4: `0007_video_cache.sql`
- M5: `0008_video_codec.sql`
- M6: `0009_transcode_cache.sql`
- M7: extends `0009` (variant vocabulary); no new migration
- M8: `0010_subtitle_formats.sql`

**Configuration growth** — ~15 new env vars across M4–M8, all default-off or conservative. Documented in [`docs/config.md`](./config.md) as they land; `.env.example` keeps the canonical list.

**Test strategy** — every milestone extends the existing `e2e` cargo feature pattern (mock factories in `crates/api/src/e2e.rs`). Bench crate (`crates/bench/`) grows scenarios per milestone.

**Dockerfile** — stays distroless. ffmpeg-the-third is statically linked into the Rust binary in M5; no runtime dependency on a system ffmpeg.

**Backward compatibility** — every feature default-off where possible (cache, transcode). M0–M3 users see no behavior change until they opt in via env var.

## Risks and unknowns

| Risk                                                         | Impact | Mitigation                                                                                                                  |
| ------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| Drive stutter root cause is upstream (Google rate-limiting)  | High   | M3.5 audit will reveal this; mitigation likely involves request coalescing or, worst case, M4 disk cache front-and-center.  |
| ffmpeg-the-third build is heavy (~3 min compile)             | Med    | Acceptable; documented in M5 PRD. CI cache the build artifacts.                                                             |
| Hardware accel detection unreliable across deployments       | Med    | M6 falls back to CPU; users can force an accel via `CASTIFY_TRANSCODE_HW_ACCEL`.                                            |
| HLS segment cache disk usage unbounded                       | Med    | M6 ships LRU eviction with `CASTIFY_TRANSCODE_CACHE_MAX_BYTES` default of 50 GiB.                                           |
| Transcoding worker saturation under concurrent plays          | Low    | Dedicated thread pool (CPU/2) with bounded queue (`CASTIFY_TRANSCODE_QUEUE_MAX=8`); 503 + `Retry-After` when full.          |

## Status

**M3.5, M4, M5, M6 — implemented.** The self-hosted media server arc is landing milestone by milestone. Here's where each stands:

| #     | Milestone                       | Status         | Notes                                                                                                  |
| ----- | ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| M3.5  | Streaming posture refactor       | ✅ Complete    | Drive playback confirmed smooth. Audit instrumentation shipped permanently. Drive strategy: status quo. |
| M4    | Hot video disk cache             | ✅ Complete    | `crates/cache/` crate, stream-through tee, pin/unpin, admin endpoint. Background sweep + thumbnail migration deferred. |
| M5    | Codec model (ffprobe)            | ✅ Complete    | Shells out to system `ffprobe` (not ffmpeg-the-third). Codec support map (16+ codecs). Lazy probe fires on `/stream-url`. Admin endpoints shipped. |
| M6    | Server-side transcoding          | ✅ Complete    | Shells out to system `ffmpeg` (not ffmpeg-the-third). CPU-only HLS output. Process-level dedup registry. HW accel, worker pool, idle timeout, bounded queue, hls.js frontend integration all deferred. |
| M7    | Adaptive bitrate                 | 🔲 Not started | Multi-variant ladder. Depends on M6 (complete).                                                         |
| M8    | Advanced subtitles               | 🔲 Not started | ASS via libass.js, PGS burn-in, embedded extraction. Depends on M6 (complete).                         |

**Key implementation deviations from the original PRDs:**

1. **ffmpeg integration strategy**: The PRDs locked "static-linked `ffmpeg-the-third` Rust crate." Implementation shelled out to system `ffmpeg`/`ffprobe` binaries instead — simpler, works immediately, avoids the heavy build dependency. The probe and transcode module APIs are designed so a future swap to `ffmpeg-the-third` is localized to one module.
2. **M6 scope reduction**: HW accel detection, dedicated worker pool (CPU/2 threads), bounded queue with 503 backpressure, idle timeout, partial cache resume, and frontend (hls.js) integration are all deferred. The shipped implementation uses a process-level `OnceLock<Mutex<HashMap>>` for dedup and CPU-only encoding. These are additive improvements that can land incrementally.
3. **M4 background sweep**: The `evict_to_target()` helper exists and eviction runs synchronously on cache write completion. A periodic background sweep task (cleaning orphaned temp files) is not yet wired.
4. **M5 eager post-scan probe**: Repository methods (`fetch_pending_probe_ids`) and config (`probe_on_scan`) exist. The scanner integration that triggers eager probing after scan completion is not yet wired; only lazy (on-first-play) probing runs.

**Next:** M7 (adaptive bitrate) or M8 (advanced subtitles) — both are unblocked. Alternatively, circle back to wire the deferred M4–M6 improvements (HW accel, worker pool, background sweep, scanner integration) before moving forward.
