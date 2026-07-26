# Changelog

Reverse-chronological ship history. Shipped efforts live in place under
[`docs/specs/`](./docs/specs/) with `status: shipped` in their spec.md frontmatter;
this file is the human-facing summary. Direction and sequencing live in
[`docs/ROADMAP.md`](./docs/ROADMAP.md).

## M7 — Adaptive bitrate (shipped)

Multi-variant HLS ladder (`CASTIFY_ABR_LADDER`, default 360p/480p/720p/1080p), pre-compute
policy, on-demand variant generation (404 + `Retry-After`), per-variant LRU eviction with
background sweep, `GET /api/admin/transcode`, `DELETE /api/videos/{id}/transcode`, and
frontend hls.js integration (lazy-load for non-Safari, native for Safari) with resolution
badge + manual variant override.

## M6 — Server-side transcoding (shipped, reduced scope)

System-ffmpeg HLS transcode (`master.m3u8`/`playlist.m3u8`/`{segment}`), process-level
dedup registry, `StreamUrl::Transcode` + `maybe_override_to_transcode` trigger. HW accel,
dedicated worker pool, idle timeout, partial-cache resume, manifest wiring, and frontend
hls.js deferred (most closed by M7).

## M5 — Codec model (shipped)

Schema for codec/bitrate/framerate + subtitle tracks, ffprobe shell-out probe module,
codec-compatibility map (16 video + 10 audio codecs), lazy probe on `/stream-url`, and
admin endpoints (`GET /api/admin/probe`, reprobe, reprobe-all). Eager post-scan sweep
deferred.

## M4 — Hot video disk cache (shipped)

Reusable `crates/cache/` module, stream-through tee into a disk cache, `StreamUrl::Cached`,
`GET /api/videos/{id}/cached-stream`, pin/unpin + evict, `GET /api/admin/cache`. Background
periodic sweep and thumbnail-cache migration deferred.

## M3.5 — Streaming posture refactor (shipped)

UX-first per-provider streaming posture across docs and code comments. `InstrumentedStream`
logs TTFB/throughput; `bench-stream` measures resolve/seek/throughput. Drive playback
confirmed smooth — no code fix required; default strategy kept as status quo.

## M3 — Play (shipped, launch)

Per-provider streaming strategy (`GET /api/videos/{id}/stream-url` → proxy for Drive, direct
CDN for OneDrive/Dropbox), native `<video>` player with custom Tailwind controls, resume
(IndexedDB per data-storage principles), ephemeral session queue, scan-time sidecar subtitle
detection (`.srt`/`.vtt`), and a continue-watching shelf.

## M2 — Browse (shipped)

Extended catalog query (FTS5 search, filters, sort, folders, favorites/ratings joins),
per-provider thumbnails + proxy cache, favorites/ratings CRUD, poster-card browse page with
hero + shelves, search + filter panel with URL deep-linking, favorite/rating UI. Benchmarks
beat all PRD latency targets on a 10K-video catalog.

## M1 — Connect & Catalog (shipped)

Schema + token crypto, catalog crate + Provider/ProviderFactory traits, Google Drive /
Dropbox / OneDrive providers, unified dedup-aware `GET /api/videos`, background scanner with
rate-limit backoff, two-tier dedup (native hash + prefix-hash via Range), Connections UI +
first-run guide, rescan API + scan-status polling.

## M0 — Foundation (shipped)

Monorepo scaffolding (Rust workspace + Vite SPA bundled into a single distroless binary),
SQLite pool + migration runner, config validation, full password auth lifecycle (Argon2id,
durable sessions, CSRF), observability, container build, and a Playwright auth-flow e2e
smoke test.
