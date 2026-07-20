# PRD: M3 — Play

> **Status:** Baseline — fourth milestone of the Media Hub Core.
> **Companion:** [`VISION.md`](../VISION.md), [`ROADMAP.md`](../ROADMAP.md), [`tasks/plan.md`](../../tasks/plan.md).

## Purpose

M3 adds video playback to the unified catalog. The owner clicks any video and it
plays straight from their cloud — no download, no re-hosting, no server-side
transcoding. The player supports seeking, playback speed, subtitles, and
resume-where-you-left-off. An ephemeral queue lets the owner skip through
videos in the current browse context. A continue-watching shelf surfaces
in-progress videos on the browse page.

The media never leaves the owner's cloud. The Castify backend acts as a
streaming proxy: it resolves the video's source, authenticates to the provider,
and forwards bytes (with Range-header passthrough) to the browser. The browser's
native `<video>` element handles decoding and rendering.

## In scope

- **Stream proxy**: `GET /api/videos/{id}/stream` — backend proxy with
  Range-header passthrough that fetches video bytes from the connected cloud
  provider and streams them to the browser. Token refresh on 401. Mirrors the
  M2 thumbnail proxy pattern.
- **Download endpoint**: `GET /api/videos/{id}/download` — same as stream but
  with `Content-Disposition: attachment` for unsupported-format fallback.
- **Video detail**: `GET /api/videos/{id}` — full video metadata for the player
  page (dimensions, duration, MIME type, sources, personalization state,
  saved playback position, subtitle tracks).
- **Playback progress**: `playback_progress` table tracking position, duration,
  and completion state per owner per video. `POST /api/videos/{id}/progress`
  (upsert) + `GET /api/videos/{id}/progress` (read). Drives resume + the
  continue-watching shelf.
- **Player UI**: `/watch/:id` route with native `<video>` element and custom
  Tailwind controls (play/pause, seek scrubber with buffered indicator, volume,
  playback speed 0.5x–2x, fullscreen, subtitle toggle, time display). Keyboard
  shortcuts. Loading/error/unsupported-format states.
- **Resume**: seek to saved position on load with "resume from X:XX?" prompt.
  Periodic progress saves (every 15s + on pause/seek/ended). Auto-mark
  completed at 95%.
- **Ephemeral queue**: session-scoped play queue from the current browse context
  (grid, shelf, search results). Next/previous skip + auto-advance. Not
  persisted.
- **Subtitles**: scan-time sidecar file detection (`.srt`/`.vtt` alongside
  videos). `video_subtitles` table. `GET /api/videos/{id}/subtitles` (list) +
  `GET /api/videos/{id}/subtitles/{track_id}` (serve with .srt→.vtt conversion).
  Player renders `<track>` elements.
- **Continue-watching shelf**: browse page shelf showing in-progress videos with
  progress-bar overlays. Click to resume.
- **Provider `open_stream()` trait method**: each provider implements its own
  download-URL resolution + Range request, returning a streaming response.

## Out of scope (deferred)

- Server-side transcoding — out of M3 scope. M3 plays what the browser supports natively (MP4, WebM); unsupported formats show a download fallback. The post-launch [Self-Hosted Media Server roadmap](../ROADMAP-self-hosted-media-server.md) adds transcoding in M6 once M4 (disk cache) and M5 (codec model) are in place.
- Client-side transcoding (ffmpeg.wasm) — deferred. M3 plays what the browser supports natively (MP4, WebM); unsupported formats show a download fallback.
- Persistent named playlists (create/save/reorder/share) — the ephemeral queue
  satisfies the "skip" goal; persistent playlists are a future enhancement.
- Adaptive streaming (HLS/DASH) — provider download URLs are direct file
  access, not adaptive manifests. The native `<video>` element handles
  byte-range seeking. M7 (post-launch) adds HLS via server-side transcoding.
- Cross-device sync (resume on one device, continue on another) — progress is
  stored server-side in SQLite, so this works naturally, but no explicit sync
  protocol or push notification is built.
- Cast/airplay support — future direction.
- Watch parties — future direction.
- Video detail page (metadata editor, cast list, etc.) — M3's `/watch/:id` is a
  player page, not a metadata page.

## Architecture decisions (locked)

| Area                           | Choice                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Streaming architecture**         | **Per-provider strategy** (T12): `GET /api/videos/{id}/stream-url` returns `{ url, strategy, expires_at }`. OneDrive + Dropbox return `strategy: "direct"` with a short-lived preauthenticated CDN URL (`@microsoft.graph.downloadUrl` ~1hr; Dropbox `get_temporary_link` ~4hr) — the browser hits the CDN directly, our backend never proxies video bytes. Google Drive returns `strategy: "proxy"` pointing at the existing `GET /api/videos/{id}/stream` endpoint (Drive downloads require a bearer header the browser can't set). The proxy path stays as the Drive fallback + token-failure retry. M3 PRD originally locked a universal proxy ("the only approach that works for all three providers"); T12 split the strategy when verification confirmed 2/3 providers support direct CDN streaming — the browser shoulders the byte transfer and the server stops being a video proxy. Token refresh on 401 (before any bytes are sent). Mirrors the M2 thumbnail proxy pattern (`videos.rs:179-255`). |
| **Provider trait extension**       | New `Provider::open_stream(&self, file_id: &str, range: Option<&str>) -> ProviderResult<StreamResponse>`. `StreamResponse` = `{ status: u16, content_type: String, content_length: Option<u64>, content_range: Option<String>, body: Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>> }`. The catalog crate does not depend on axum; the api crate converts `StreamResponse` to an axum `Response`. E2eMockProvider returns canned video bytes. |
| **Google Drive streaming**         | `GET https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&supportsAllDrives=true` with `Authorization: Bearer {token}` + `Range` header. Adds a redirect-following `http_download` reqwest client to `GoogleDriveClient` (Drive's `alt=media` may 302 to a CDN). The existing `http` client uses `redirect::Policy::none()`; `open_stream` uses `http_download`. Mirrors OneDrive's client split. |
| **Dropbox streaming**              | `POST https://content.dropboxapi.com/2/files/download` with `Authorization: Bearer {token}`, `Dropbox-API-Arg: {"path": "{file_id}"}`, `Range` header. Same endpoint as `fetch_dropbox_prefix_hash`, just arbitrary Range instead of the fixed 4 MB window. Both 200 (small file, Range ignored) and 206 (partial content) are accepted. |
| **OneDrive streaming**             | Two-step: (1) `GET /me/drive/items/{file_id}?$select=@microsoft.graph.downloadUrl` with bearer to fetch a short-lived preauthenticated CDN URL; (2) `GET {download_url}` with `Range` header, no auth. Reuses the existing `http_download` client + `DownloadUrlResponse` struct from `fetch_onedrive_prefix_hash`. |
| **Download fallback**              | `GET /api/videos/{id}/download` — identical to the stream endpoint but adds `Content-Disposition: attachment; filename="{video_name}"`. For unsupported formats (MKV, AVI, FLV, etc.), the player shows a "not playable in-browser" message with a download link. No ffmpeg.wasm in M3. |
| **Playback progress**              | Migration 0006: `playback_progress` table `(owner_id TEXT REFERENCES owners(id) ON DELETE CASCADE, video_id TEXT REFERENCES videos(id) ON DELETE CASCADE, position_seconds REAL NOT NULL, duration_seconds REAL, updated_at TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner_id, video_id))`. Updated via `POST /api/videos/{id}/progress` every 15s + on pause/seek/ended/unmount. Auto-mark `completed=1` at 95% playback. |
| **Video detail**                   | `GET /api/videos/{id}` returns `VideoDetailDto` — full video metadata (name, mime_type, duration_ms, width, height, size_bytes, sources[], created_at, path, is_favorite, my_rating, thumbnail_status) plus playback state (position_seconds, duration_seconds, completed) and subtitle tracks[]. Single enriched query joining videos + favorites + ratings + progress + subtitles. |
| **Player UI**                      | Native `<video>` element with custom-built controls in Tailwind. No player library (no Video.js, Plyr, Vidstack). Controls: play/pause, seek scrubber with buffered-range indicator, volume slider + mute, time display (current / total), playback speed selector (0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x), fullscreen toggle, subtitle track toggle. Keyboard shortcuts: space (play/pause), ←/→ (±10s), j/l (±10s), ↑/↓ (volume), f (fullscreen), m (mute). |
| **Format handling**                | `HTMLMediaElement.canPlayType(mime)` probe on the video's MIME type. If the browser reports it can't play the format, the player shows an "unsupported format" state with a download link (`GET /api/videos/{id}/download`). No transcoding, no remuxing, no ffmpeg.wasm. Covers MP4 (H.264/AAC) and WebM (VP8/VP9) — the majority of cloud-stored videos. |
| **Ephemeral queue**                | Session-scoped React state. When the user clicks a video from a browse context (grid, shelf, search results), the sibling video IDs are passed to `/watch/:id` via router state. The player renders next/previous skip controls and auto-advances on ended. The queue is not persisted — navigating away or reloading starts fresh. |
| **Subtitles — detection**          | Scan-time sidecar detection. `ListPage` gains `subtitles: Vec<DiscoveredSubtitle>`. Each provider captures `.srt`/`.vtt` files during the same listing pass: Google Drive modifies its `q` parameter to include subtitle extensions (zero extra API calls, just more results per page); Dropbox and OneDrive already return all files in their listing responses and filter client-side — they additionally capture subtitle files (zero extra API calls). The scanner matches subtitles to videos by base name (strip extensions + language suffixes) and upserts into `video_subtitles`. |
| **Subtitles — serving**            | `GET /api/videos/{id}/subtitles` returns `[{ id, language, filename }]`. `GET /api/videos/{id}/subtitles/{track_id}` serves the subtitle content with `Content-Type: text/vtt`. `.srt` files are converted to WebVTT on the fly (replace `,` with `.` in timestamps, prepend `WEBVTT` header). The player renders `<track>` elements sourcing from these endpoints. Same-origin `<track>` requests include the session cookie by default. |
| **Continue-watching shelf**        | Browse page shelf showing videos with `position_seconds > 0 AND completed = 0`, sorted by `updated_at DESC`, limited to 20. PosterCard gains a progress-bar overlay. Click navigates to `/watch/:id` which seeks to the saved position. Hidden when no in-progress videos exist. Uses the existing `GET /api/videos` with a new `in_progress=true` filter. |
| **Route**                          | `/watch/:id` — new protected route (session required). PosterCard click navigates here. The route accepts optional router state `{ queue: string[] }` for the ephemeral queue. |
| **Migration**                      | `0006_play.sql` adds `playback_progress` + `video_subtitles` tables. |

## Functional requirements

### FR-1: Stream proxy

- **FR-1.1** `GET /api/videos/{id}/stream` streams the video's content from its cloud provider to the browser.
- **FR-1.2** The endpoint resolves video → connection → token → provider factory → `open_stream(file_id, range)`, forwarding the browser's `Range` header to the provider.
- **FR-1.3** The response streams the provider's response body (not buffered) with `Content-Type`, `Content-Length`, `Content-Range`, and `Accept-Ranges: bytes` headers forwarded from the provider.
- **FR-1.4** Status code mirrors the provider's: `200` for full content, `206` for partial content (Range request).
- **FR-1.5** If the provider returns `401 Unauthorized`, the proxy refreshes the token once and retries. If the refresh fails, returns `502 Bad Gateway`.
- **FR-1.6** If the video doesn't exist, returns `404 Not Found`. If the provider isn't configured, returns `503 Service Unavailable`.
- **FR-1.7** The route is authenticated (session required) but does not require CSRF (safe GET method).
- **FR-1.8** `GET /api/videos/{id}/download` behaves identically but adds `Content-Disposition: attachment; filename="{video_name}"`.

### FR-2: Provider `open_stream()`

- **FR-2.1** `Provider::open_stream(&self, file_id: &str, range: Option<&str>) -> ProviderResult<StreamResponse>` is added to the `Provider` trait.
- **FR-2.2** `StreamResponse` contains: `status` (200 or 206), `content_type`, `content_length`, `content_range`, and a streaming `body`.
- **FR-2.3** Google Drive: `GET files/{id}?alt=media` with bearer + Range via a redirect-following `http_download` client.
- **FR-2.4** Dropbox: `POST content.dropboxapi.com/2/files/download` with bearer + `Dropbox-API-Arg` + Range.
- **FR-2.5** OneDrive: two-step — fetch `@microsoft.graph.downloadUrl`, then GET that URL with Range (no auth, follows redirect).
- **FR-2.6** Each provider handles `200` (full content, Range ignored) and `206` (partial content) responses.
- **FR-2.7** Provider-not-found returns `ProviderError::NotFound`. Expired token returns `ProviderError::Unauthorized`.

### FR-3: Playback progress

- **FR-3.1** `POST /api/videos/{id}/progress` with body `{ position_seconds: f64, duration_seconds?: f64, completed?: bool }` upserts the owner's playback progress for the video. Requires CSRF.
- **FR-3.2** `GET /api/videos/{id}/progress` returns `{ position_seconds: f64, duration_seconds: f64 | null, completed: bool, updated_at: string }` or `404` if no progress exists.
- **FR-3.3** Progress is owner-scoped (single-owner schema with `owner_id` in the PK).
- **FR-3.4** Disconnecting a provider cascades to delete the connection's videos, which cascades to delete their progress (`ON DELETE CASCADE`).
- **FR-3.5** `GET /api/videos?in_progress=true` filters to videos with `position_seconds > 0 AND completed = 0` for the current owner, sorted by `playback_progress.updated_at DESC`.

### FR-4: Video detail

- **FR-4.1** `GET /api/videos/{id}` returns full video metadata: `id`, `name`, `provider`, `size_bytes`, `mime_type`, `duration_ms`, `width`, `height`, `sources[]`, `created_at`, `path`, `is_favorite`, `my_rating`, `thumbnail_status`, `position_seconds`, `duration_seconds`, `completed`, `subtitle_tracks[]`.
- **FR-4.2** `subtitle_tracks[]` contains `{ id, language, filename }` for each detected sidecar subtitle.
- **FR-4.3** Returns `404` if the video doesn't exist.

### FR-5: Subtitle detection

- **FR-5.1** `ListPage` gains `subtitles: Vec<DiscoveredSubtitle>` (default empty). `DiscoveredSubtitle` = `{ provider_file_id, name, path, language }`.
- **FR-5.2** Each provider captures `.srt`/`.vtt` files during the same listing pass as videos. Google Drive modifies its `q` parameter; Dropbox and OneDrive capture from the existing listing response.
- **FR-5.3** The scanner matches subtitles to videos by base name (strip video/subtitle extensions + language suffixes) and upserts into `video_subtitles`.
- **FR-5.4** `video_subtitles` table: `(id TEXT PRIMARY KEY, video_id TEXT REFERENCES videos(id) ON DELETE CASCADE, connection_id TEXT REFERENCES provider_connections(id) ON DELETE CASCADE, provider_file_id TEXT NOT NULL, language TEXT, filename TEXT NOT NULL, format TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(video_id, provider_file_id))`.
- **FR-5.5** Re-scans update the subtitle list (upsert by `UNIQUE(video_id, provider_file_id)`). Subtitles for deleted videos are cascaded.

### FR-6: Subtitle serving

- **FR-6.1** `GET /api/videos/{id}/subtitles` returns `[{ id, language, filename }]` for the video's subtitle tracks.
- **FR-6.2** `GET /api/videos/{id}/subtitles/{track_id}` serves the subtitle content with `Content-Type: text/vtt`.
- **FR-6.3** `.srt` files are converted to WebVTT on the fly: replace `,` with `.` in timestamps, prepend `WEBVTT\n\n`.
- **FR-6.4** The subtitle content is fetched from the provider via the same connection/token/factory pipeline as the stream proxy (with 401-refresh retry).
- **FR-6.5** Returns `404` if the video or subtitle track doesn't exist.

### FR-7: Watch page

- **FR-7.1** `/watch/:id` is a protected route (session required, redirected to `/login` if unauthenticated).
- **FR-7.2** The page fetches `GET /api/videos/{id}` for video detail and renders a `<video>` element sourcing from `/api/videos/{id}/stream`.
- **FR-7.3** If `canPlayType(mime)` reports the format is unsupported, the page shows an "unsupported format" message with a download link instead of the `<video>` element.
- **FR-7.4** Loading, error, and not-found states are handled.
- **FR-7.5** PosterCard click navigates to `/watch/:id` with the sibling video IDs (from the current browse context) passed as router state for the ephemeral queue.

### FR-8: Player controls

- **FR-8.1** Play/pause button (clicks the `<video>` element or the button).
- **FR-8.2** Seek scrubber: draggable progress bar showing current position and buffered range. Click-to-seek and drag-to-seek.
- **FR-8.3** Volume slider + mute toggle.
- **FR-8.4** Time display: current position / total duration (formatted as `M:SS` or `H:MM:SS`).
- **FR-8.5** Playback speed selector: 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x.
- **FR-8.6** Fullscreen toggle.
- **FR-8.7** Subtitle track toggle: off / available languages.
- **FR-8.8** Buffering indicator (spinner) while waiting for data.
- **FR-8.9** Controls auto-hide after 3s of inactivity during playback; reappear on mouse move or keypress.
- **FR-8.10** Keyboard shortcuts: space (play/pause), ←/→ (±10s), j/l (±10s), ↑/↓ (volume ±5%), f (fullscreen), m (mute).

### FR-9: Resume

- **FR-9.1** On player load, if saved `position_seconds > 30` and `completed = false`, the player seeks to the saved position and shows a "Resume from X:XX?" toast for 5 seconds.
- **FR-9.2** Progress is saved every 15 seconds during playback via `POST /api/videos/{id}/progress`.
- **FR-9.3** Progress is saved on pause, seek, and ended events.
- **FR-9.4** Progress is saved on page unload via `navigator.sendBeacon` (survives tab close).
- **FR-9.5** When playback reaches 95% of duration, `completed` is set to `true` and the video drops off the continue-watching shelf.

### FR-10: Ephemeral queue

- **FR-10.1** When the user clicks a video from a browse context (grid, shelf, search results), the sibling video IDs from that context are passed to `/watch/:id` as router state.
- **FR-10.2** The player shows next/previous skip controls when a queue exists.
- **FR-10.3** On video ended, the player auto-advances to the next video in the queue.
- **FR-10.4** An "up next" list shows the remaining queue items.
- **FR-10.5** The queue is not persisted — reloading `/watch/:id` without router state starts with no queue.

### FR-11: Continue-watching shelf

- **FR-11.1** The browse page shows a "Continue Watching" shelf when the owner has in-progress videos (`position_seconds > 0 AND completed = 0`).
- **FR-11.2** The shelf shows up to 20 in-progress videos, sorted by `updated_at DESC`.
- **FR-11.3** Each card shows a progress-bar overlay indicating playback position.
- **FR-11.4** Clicking a card navigates to `/watch/:id` and resumes from the saved position.
- **FR-11.5** The shelf is hidden when no in-progress videos exist.

## Non-functional requirements

| Category    | Requirement                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Performance | Stream startup < 3 s from click to first frame (VISION: "video starts within 3 seconds"). |
| Performance | Seek latency < 500 ms (Range request round-trip through the proxy). |
| Performance | Proxy throughput ≥ 50 Mbps (sufficient for 1080p streaming on a self-hosted LAN). |
| Performance | Progress save is fire-and-forget (< 100 ms, non-blocking UI). |
| Performance | Subtitle load < 1 s (sidecar file fetch + .srt→.vtt conversion). |
| Security    | Stream/subtitle endpoints require authenticated session. Progress mutation requires CSRF. Provider tokens never exposed to the browser. |
| Reliability | Token refresh on 401 mid-session (before first byte). Network drops mid-stream: browser re-requests Range, proxy re-resolves. |
| Portability | No new system library dependencies. No frontend player library. Native `<video>` + custom controls only. |
| Operability | Progress saves are idempotent upserts — safe to retry. Subtitle detection is scan-time, not per-play. |
| Accessibility | Player controls are keyboard-accessible (tab + enter/space). ARIA labels on all controls. Keyboard shortcuts don't trap focus. |

## Acceptance criteria (milestone-level)

- [ ] Clicking a video opens the player and playback starts within 3 seconds
- [ ] Seek scrubber works: click/drag to a position, video resumes from there
- [ ] Playback speed (0.5x–2x) works
- [ ] Keyboard shortcuts work (space, arrows, f, m, j, l)
- [ ] Resume: closing and reopening a video seeks to the last position
- [ ] Continue-watching shelf appears on the browse page after partial playback
- [ ] Next/previous skip works when navigating from a browse context
- [ ] Auto-advance to the next video on ended
- [ ] Subtitles render when sidecar `.srt`/`.vtt` files exist
- [ ] Subtitle toggle menu shows available languages
- [ ] Unsupported formats show a download link instead of a broken player
- [ ] `GET /api/videos/{id}/stream` returns 206 with correct `Content-Range` for Range requests
- [ ] `GET /api/videos/{id}/download` triggers a file download
- [ ] `POST /api/videos/{id}/progress` saves position; `GET /api/videos/{id}/progress` returns it
- [ ] Provider tokens are never exposed to the browser (all provider calls go through the backend proxy)
- [ ] M0/M1/M2 e2e tests still pass (auth flow + catalog + browse)
- [ ] New e2e tests cover: play, seek, resume, skip, subtitle display, progress persistence

## Dependencies

- **M1 — Connect & Catalog** (complete): provider connections, token management, scanner, catalog.
- **M2 — Browse** (complete): poster grid, enriched `VideoSummary`, thumbnail proxy (template for stream proxy), `ProviderFactory` trait, `AppState::factory_for()`.
- **External:** provider APIs must support Range requests for video downloads (all three do — verified by the M1 prefix-hash implementations).

## Risks

| Risk                                        | Impact | Mitigation                                                                                                          |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| Google Drive `alt=media` redirects to CDN   | Med    | Add a redirect-following `http_download` client to `GoogleDriveClient` (mirroring OneDrive's split). Verified in T2. |
| Proxy bandwidth bottleneck              | Low    | Single-owner app on LAN — bandwidth is not a constraint. The T12 per-provider strategy routes OneDrive + Dropbox bytes browser-direct, so only Drive flows through the proxy. |
| `<track>` element doesn't attach cookies    | Low    | Same-origin `<track>` requests include cookies by default. Fallback: fetch via `apiFetch` + `TextTrack.addCue()` if testing reveals issues. |
| Subtitle base-name matching false positives | Low    | Conservative matching: strip known extensions + language codes only. Edge cases (unusual naming) degrade to no subtitle, not wrong subtitle. |
| Large file Range request timeouts           | Low    | reqwest streaming body forwards bytes as they arrive. Browser handles buffering. No server-side timeout beyond the initial connection. |
| Progress write race (multiple tabs)         | Low    | Single-owner app — multiple tabs are an edge case. Upsert is last-write-wins, which is acceptable. |
| E2e mock video bytes insufficient for `<video>` | Low  | Mock returns minimal MP4 header bytes sufficient for `loadedmetadata` event. E2e tests assert metadata load, not full playback. |

## Open questions resolved

- **Streaming architecture**: **Per-provider strategy** (T12 revision). The M3 baseline locked a universal backend proxy as "the only approach that works for all three providers." That reasoning held for Drive (bearer-auth on every download) but was over-conservative for OneDrive + Dropbox: both expose short-lived preauthenticated CDN URLs (`@microsoft.graph.downloadUrl` ~1hr; Dropbox `get_temporary_link` ~4hr) that the browser fetches directly with no auth header. T12 splits the strategy: OneDrive + Dropbox return `strategy: "direct"` from `GET /api/videos/{id}/stream-url`, the browser sets `<video src>` to the CDN URL, and our backend never touches a video byte. Drive keeps the proxy (`strategy: "proxy"` → existing `/stream`). The proxy path stays as the Drive fallback + token-failure retry. The browser shoulders the byte transfer for 2/3 providers; the server stops being a video proxy.
- **Format fallback**: **Native `<video>` + download link.** No ffmpeg.wasm in M3. Covers MP4/WebM (the majority of cloud videos). Unsupported formats show a download link. Client-side transcoding is a future enhancement.
- **Player UI**: **Native `<video>` + custom controls.** Zero dependencies, full design control, matches the app's Tailwind-based aesthetic. ~600 LOC for controls.
- **Playlist scope**: **Ephemeral session queue only.** The sibling videos from the browse context become the "up next" queue. Not persisted. Persistent named playlists are a future enhancement.
- **Subtitles**: **Scan-time sidecar detection.** `.srt`/`.vtt` files alongside videos are detected during the same listing pass (zero extra API calls for Dropbox/OneDrive; modified `q` for Google Drive). Served via backend proxy with .srt→.vtt conversion. `<track>` element for display.
- **Resume**: **Server-side progress in SQLite.** `playback_progress` table with position, duration, completion. Saved every 15s + on key events. Auto-mark completed at 95%. Drives the continue-watching shelf.
- **Personal data storage**: **SQLite (single-owner model).** Same as M2 — playback progress lives alongside the catalog in the server's SQLite database.
