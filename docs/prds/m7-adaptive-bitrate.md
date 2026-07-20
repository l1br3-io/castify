# PRD: M7 — Adaptive Bitrate

> **Status:** Baseline — fifth milestone of the self-hosted media server arc.
> **Companion:** [`ROADMAP-self-hosted-media-server.md`](../ROADMAP-self-hosted-media-server.md), [`m6-transcoding.md`](./m6-transcoding.md).

## Purpose

M7 makes Castify stream smoothly on weak remote connections. When the user is on a phone far from home, hotel Wi-Fi, or a flaky cellular connection, the source bitrate (often 5–20 Mbps for 1080p) exceeds what the connection can sustain. Buffering dominates the experience.

The fix is adaptive bitrate (ABR): generate multiple variants of the video at different bitrates, let the player switch between them as bandwidth fluctuates. HLS handles this natively via the master playlist; hls.js has built-in ABR logic.

M6 ships single-variant transcode (best-for-source capped at 720p). M7 adds the ladder.

## In scope

- **Multi-bitrate ladder** per video: variants from `CASTIFY_ABR_LADDER=360p,480p,720p,1080p` (default).
- **Pre-compute policy**: generate one variant upfront (the best-for-source, capped at 720p default — already done by M6). Other variants generate on-demand if the client requests them.
- **Master playlist assembly**: master playlist lists all available variants. Initially only the pre-computed variant; grows as on-demand variants land.
- **On-demand variant generation**: when client requests a variant not yet transcode-cached, the playlist endpoint kicks off generation and returns 404 (hls.js retries per its ABR logic).
- **Variant metadata in master playlist**: each variant entry includes `BANDWIDTH`, `RESOLUTION`, `CODECS` so hls.js can pick intelligently.
- **Per-variant independent cache**: each variant cached/evicted independently via the existing `(video_id, variant, profile)` key.
- **Bandwidth detection**: leverage hls.js built-in ABR. No server-side bandwidth probing.

## Out of scope (deferred)

- Server-side bandwidth probing — hls.js handles this client-side.
- DASH support — HLS is sufficient; DASH adds complexity without clear benefit.
- Custom ABR heuristics — hls.js's defaults are well-tuned.
- Pre-computing all variants for every video — too expensive on disk; on-demand is the right default.
- User-selectable ladder per video — global config is sufficient for M7.

## Architecture decisions (locked)

| Area                                | Choice                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ABR ladder source**                | Configurable via `CASTIFY_ABR_LADDER` (comma-separated resolutions). Default: `360p,480p,720p,1080p`. The pre-compute cap (default `720p`) and the ladder together define behavior.                                                                                                                                                                  |
| **Pre-compute policy**               | One variant pre-computed at transcode start: the closest ladder rung at-or-below source resolution, capped at `CASTIFY_ABR_PRECOMPUTE_CAP=720p`. Other variants generated on-demand. Avoids disk explosion while ensuring the common case (LAN playback) has zero startup latency.                                                                      |
| **On-demand generation**             | Variant playlist endpoint kicks off generation if not cached. Returns 404 immediately; client (hls.js) retries per its ABR logic. Worker pool from M6 handles the new variant — same `(video_id, variant, profile)` key, just different variant.                                                                                                       |
| **Master playlist format**            | Standard HLS master with one `#EXT-X-STREAM-INF` per variant, including `BANDWIDTH`, `RESOLUTION`, `CODECS="avc1.4d401f,mp4a.40.2"`. Updates as variants become available.                                                                                                                                                                              |
| **Bitrate targeting per rung**         | Conservative defaults: 360p = 800 kbps, 480p = 1500 kbps, 720p = 3000 kbps, 1080p = 6000 kbps. Tunable via a future config; M7 ships defaults.                                                                                                                                                                                                       |
| **Per-variant cache**                 | Each variant has its own row in `transcode_cache_entries`. Eviction is per-variant; popular variants stay, unpopular ones get evicted.                                                                                                                                                                                                                  |
| **Bandwidth detection**                | hls.js's built-in ABR. No server-side probing. Server's only job is to make variants available; client picks.                                                                                                                                                                                                                                          |

## Schema changes

**No new migration.** M6's `transcode_cache_entries` table already supports multiple variants per video via the `(video_id, variant, profile)` primary key. M7 just populates more rows per video.

The `variant` column vocabulary expands from `['source', '720p']` (M6) to `['source', '1080p', '720p', '480p', '360p']` (M7). Existing rows from M6 are valid; new variants land as they're generated.

## Functional requirements

### FR-1: Ladder configuration

- **FR-1.1** New env var `CASTIFY_ABR_LADDER=360p,480p,720p,1080p` (default). Parsed into a `Vec<VariantRung>` at startup.
- **FR-1.2** `VariantRung`: `{ name, target_height, target_bitrate_kbps }`. Map: `360p → (360, 800)`, `480p → (480, 1500)`, `720p → (720, 3000)`, `1080p → (1080, 6000)`.
- **FR-1.3** Invalid ladder values rejected at startup with actionable error.
- **FR-1.4** `CASTIFY_ABR_PRECOMPUTE_CAP=720p` (default). The variant at-or-below source resolution, capped at this rung, is pre-computed.

### FR-2: Master playlist assembly

- **FR-2.1** `GET /api/videos/{id}/transcode/master.m3u8` (existing from M6) is extended to list all available variants for the video.
- **FR-2.2** Initially lists only the pre-computed variant. As on-demand variants land, master playlist grows.
- **FR-2.3** Master playlist is regenerated on each request from the current `transcode_cache_entries` rows for the video.
- **FR-2.4** Each `#EXT-X-STREAM-INF` includes `BANDWIDTH`, `RESOLUTION`, `CODECS`.
- **FR-2.5** If a variant's transcode is still in-progress, it's listed but with `BANDWIDTH` set to estimated target (so hls.js can include it in selection).

### FR-3: On-demand variant generation

- **FR-3.1** `GET /api/videos/{id}/transcode/{variant}/playlist.m3u8` (existing from M6) checks if the variant is cached.
- **FR-3.2** If cached (any status): existing behavior (M6) — return playlist of completed segments.
- **FR-3.3** If not cached: enqueue transcode job for `(video_id, variant, default_profile)`. Return 404 with `Retry-After: 3`.
- **FR-3.4** hls.js retries per its ABR logic; once first segment is ready, playlist returns 200 with the segment listed.
- **FR-3.5** Concurrent requests for the same variant deduplicate via the M6 worker pool.

### FR-4: Per-variant independent cache

- **FR-4.1** Each variant cached independently in `transcode_cache_entries` (one row per `(video_id, variant, profile)`).
- **FR-4.2** LRU eviction considers each variant separately.
- **FR-4.3** Pinned variants (via existing M4 pin endpoint, extended) never evicted.
- **FR-4.4** Master playlist reflects current cache state (evicted variants disappear from list).

### FR-5: Frontend ABR handling

- **FR-5.1** hls.js configured with `abrDefaultBandwidthEstimate` from a conservative default (1 Mbps).
- **FR-5.2** hls.js's ABR logic selects variants based on observed throughput.
- **FR-5.3** Player UI shows current variant (resolution badge in controls, e.g. "720p").
- **FR-5.4** Manual variant override: user can force a specific rung via the player settings menu ("Auto", "1080p", "720p", "480p", "360p").
- **FR-5.5** Safari native HLS handles ABR automatically; no custom code needed.

### FR-6: Admin endpoint

- **FR-6.1** `GET /api/admin/transcode` (existing from M6) is extended to report per-variant stats: how many variants cached at each rung, total disk usage per rung.

## Non-functional requirements

| Category    | Requirement                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Performance | Master playlist response < 50 ms (single SQL query + format).                                                                                |
| Performance | On-demand variant generation kicks off within 200 ms of playlist request.                                                                    |
| Reliability | Variant generation failures don't affect other variants; client falls back to lower rung.                                                    |
| Operability | Admin endpoint shows per-rung cache distribution; surfaces which rungs are popular.                                                           |

## Configuration

Two new env vars (in addition to M6's transcode vars):

| Variable                            | Default             | Description                                                  |
| ----------------------------------- | ------------------- | ------------------------------------------------------------ |
| `CASTIFY_ABR_LADDER`                  | `360p,480p,720p,1080p` | Comma-separated list of available variants.                    |
| `CASTIFY_ABR_PRECOMPUTE_CAP`          | `720p`              | Variant to pre-compute at transcode start. Must be in the ladder. |

## Acceptance criteria (milestone-level)

- [ ] Ladder config parses and validates
- [ ] Master playlist lists all cached variants with correct BANDWIDTH/RESOLUTION/CODECS
- [ ] Master playlist grows as on-demand variants land
- [ ] On-demand variant request triggers generation, returns 404 + Retry-After
- [ ] hls.js ABR switches between variants based on bandwidth (verified in Chrome with throttling)
- [ ] Manual variant override in player UI works
- [ ] Safari native HLS switches variants correctly
- [ ] Per-variant independent eviction works (popular variant stays, unpopular evicted)
- [ ] `GET /api/admin/transcode` reports per-rung stats
- [ ] All existing M0–M6 tests pass unchanged
- [ ] `cargo build --workspace && cargo clippy --workspace --all-targets && cargo test --workspace` clean

## Dependencies

- **M6 — Transcoding** (complete): worker pool, cache pool, HLS output, hls.js integration.

## Risks

| Risk                                              | Impact | Mitigation                                                                                                                  |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| On-demand variant generation too slow for live ABR   | Med    | Pre-compute the most-likely-needed variant (720p). Client falls back to it while others generate.                              |
| Master playlist refresh causes client flicker       | Low    | hls.js handles playlist updates smoothly. We don't push updates; client polls.                                                 |
| Disk usage explodes if all variants cached          | Med    | Per-variant LRU eviction. Default cache limit (50 GiB) bounds total usage.                                                    |
| hls.js ABR stuck on lowest variant                   | Low    | Configurable starting estimate. User manual override available.                                                               |
| Bitrate targets are wrong for modern codecs          | Low    | Conservative defaults ship; tunable via future config.                                                                        |

## Open questions resolved

- **Pre-compute vs on-demand**: hybrid. One variant pre-computed; others on-demand.
- **Pre-compute choice**: best-for-source capped at `CASTIFY_ABR_PRECOMPUTE_CAP` (default 720p).
- **Bandwidth detection**: hls.js built-in. No server-side probing.
- **Ladder config**: env var, global. Per-video ladders deferred.
- **Per-variant cache**: independent eviction. Pinned variants survive.
