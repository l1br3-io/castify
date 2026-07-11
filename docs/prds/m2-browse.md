# PRD: M2 — Browse

> **Status:** Baseline — third milestone of the Media Hub Core.
> **Companion:** [`VISION.md`](../VISION.md), [`ROADMAP.md`](../ROADMAP.md), [`tasks/plan.md`](../../tasks/plan.md).

## Purpose

M2 turns the flat catalog from M1 into a clean, organized library. The owner
can visually browse their videos with poster thumbnails, a hero showcase,
scrollable shelves (recent, favorites, by provider, by folder), a responsive
poster grid, full-text search, rich filters, extended sorting, and
personalization (favorites + 5-star ratings). The catalog goes from "a list of
files" to "your media library."

## In scope

- **Thumbnails**: provider-native thumbnail fetching (Google Drive
  `thumbnailLink`, Dropbox `get_thumbnail_v2`, OneDrive `thumbnails` facet) via
  a lazy backend proxy with filesystem caching. No scan-time overhead — fetched
  on first view.
- **Browse UI**: hero showcase (featured video with backdrop), scrollable
  shelves (Recently Added, Favorites, By Provider, By Folder), responsive poster
  grid replacing the M1 vertical list.
- **Search**: SQLite FTS5 full-text search across video `name` and `path`,
  integrated into the unified dedup-aware query.
- **Filters**: provider (existing), duration range, resolution bucket,
  favorites-only, minimum rating, folder — all as query parameters on
  `GET /api/videos`.
- **Extended sorting**: name ±, size ±, date ±, duration ±, rating desc —
  direction-aware sort enum.
- **Favorites**: per-owner favorite flag (`POST/DELETE
  /api/videos/{id}/favorite`), surfaced as `is_favorite` on video summaries.
- **Ratings**: per-owner 1–5 star rating (`PUT /api/videos/{id}/rating`),
  surfaced as `my_rating` on video summaries.
- **Folder enumeration**: `GET /api/videos/folders` returns top-level folder
  paths with video counts for shelf building.
- **Provider modularization**: extend `Provider` and `ProviderFactory` traits
  with thumbnail + OAuth lifecycle methods; extract shared helpers; eliminate
  `match provider {}` dispatch in shared code; per-provider missing-field
  compensation (Google Drive path resolution, Dropbox MIME inference).

## Out of scope (deferred)

- Video playback — streaming, seeking, subtitles, resume (M3).
- Continue-watching shelf — requires playback history (M3).
- Guest share links (M4).
- Hosted multi-tenant deployment (M5).
- Server-side thumbnail generation via ffmpeg — provider-native thumbnails only.
- Google Drive full-path resolution beyond top-level folder — batch parent-ID
  resolution covers folder names for shelf grouping; deep multi-level paths are
  a future enhancement.
- Smart collections / auto-tagging / AI scene detection (future directions).
- Video detail page — M2 is browse-only; clicking a video opens the player in M3.

## Architecture decisions (locked)

| Area                           | Choice                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search engine**                  | SQLite **FTS5** virtual table (`videos_fts`) mirroring `name` + `path`, populated via triggers on `videos` INSERT/UPDATE/DELETE. Case-insensitive, tokenized. `LIKE '%x%'` fallback not needed — FTS5 covers substring and prefix. |
| **Thumbnails**                     | **Lazy proxy**: `GET /api/videos/{id}/thumbnail` fetches from the provider on first request, caches to `/data/thumbnails/{video_id}.{ext}` on the filesystem, serves cached on subsequent requests. No scan-time thumbnail fetching — zero overhead until a user views the card. |
| **Thumbnail trait method**         | `Provider::fetch_thumbnail(&self, file_id: &str) -> ProviderResult<ThumbnailData>` where `ThumbnailData` is `Bytes { data: Vec<u8>, mime_type: String }`. Each provider encapsulates its own fetch strategy. The proxy normalizes all providers to cached bytes. |
| **Provider trait**                  | Extended with `fetch_thumbnail()`. Each provider (`GoogleDriveProvider`, `DropboxProvider`, `OneDriveProvider`) implements all trait methods independently. No provider-specific conditionals in shared code. |
| **ProviderFactory trait**           | Extended with `authorization_url()`, `exchange_code()`, `fetch_user_info()`, `is_configured()`. Each factory owns its full OAuth lifecycle. Eliminates the 5 `match provider {}` blocks in `connections.rs`. |
| **Missing-field compensation**      | Per-provider, internal to each module: Google Drive resolves `path` via batch `files.list?q=…` parent-ID resolution with a scan-local `HashMap` cache (O(unique folders) API calls per scan); Dropbox infers `mime_type` from file extension. OneDrive already populates all fields. |
| **Shared helpers**                  | `providers/common.rs` extracts `to_hex()`, `classify_token_error()`, `TokenResponse + into_bundle()`, and the refresh-token-preservation logic currently triplicated across all three providers. |
| **Favorites**                       | New `video_favorites` table `(owner_id TEXT REFERENCES owners(id) ON DELETE CASCADE, video_id TEXT REFERENCES videos(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (owner_id, video_id))`. Per-owner (single owner now, M5-ready schema). |
| **Ratings**                         | New `video_ratings` table `(owner_id TEXT REFERENCES owners(id) ON DELETE CASCADE, video_id TEXT REFERENCES videos(id) ON DELETE CASCADE, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, video_id))`. |
| **VideoSummary enrichment**         | Add fields: `created_at` (ISO timestamp), `path` (Option — folder path), `is_favorite` (bool), `my_rating` (Option<i32>), `thumbnail_status` ("pending" / "cached" / "failed" / "unsupported"). |
| **Folder grouping**                 | Top-level segment of the `path` column. `GET /api/videos/folders` returns `[{ folder: String, video_count: i64 }]`. Videos with `NULL` path (e.g., Google Drive before path resolution) appear under "(Unsorted)". |
| **Query refactor**                  | `fetch_video_page` switches from string-concatenated SQL to `sqlx::QueryBuilder` to handle variable filters, search predicates, favorites/ratings joins, and folder predicates cleanly. |
| **Sort expansion**                  | `VideoSort` gains direction-aware variants: `NameAsc`, `NameDesc`, `SizeAsc`, `SizeDesc`, `DateAsc`, `DateDesc`, `DurationAsc`, `DurationDesc`, `RatingDesc`. `order_clause()` returns a whitelisted column+direction pair. |
| **Filter parameters**               | `q` (FTS5 search), `duration_min` / `duration_max` (ms), `min_height` (resolution floor, e.g. 720 for HD+), `favorites_only` (bool), `min_rating` (1–5), `folder` (path prefix). Provider filter (existing) retained. |
| **Browse layout**                   | `/` is redesigned into the browse experience. The M1 `VideoList` component is replaced. No new route — the home page *is* the browse page. |
| **Personal data storage**           | Favorites and ratings stored in SQLite (self-hosted single-owner model). The VISION's "personal data stays in the owner's cloud" applies to M5 hosted; M2 is self-hosted-only. |
| **Migration**                       | `0004_browse.sql` adds `video_favorites` + `video_ratings` tables, the `videos_fts` FTS5 virtual table + triggers, and a `thumbnail_status` column on `videos`. |

## Functional requirements

### FR-1: Thumbnail proxy

- **FR-1.1** `GET /api/videos/{id}/thumbnail` returns the thumbnail image bytes for the specified video (content-type: `image/jpeg` or `image/png`).
- **FR-1.2** On first request, the endpoint resolves the video → connection → token → provider factory → `fetch_thumbnail()`, caches the result to `/data/thumbnails/{video_id}.{ext}`, and serves it.
- **FR-1.3** On subsequent requests, the cached file is served directly (no provider API call).
- **FR-1.4** If the provider returns no thumbnail (unsupported file or format), the endpoint returns `404 Not Found`. The frontend renders a generated placeholder (gradient + initial).
- **FR-1.5** If the provider API call fails (network error, expired token after refresh attempt), the endpoint returns `502 Bad Gateway`. The frontend retries on next page load.
- **FR-1.6** The route is authenticated (session required) but does not require CSRF (safe GET method).

### FR-2: Search

- **FR-2.1** `GET /api/videos?q={query}` performs an FTS5 full-text search across video `name` and `path`, dedup-aware (representatives only).
- **FR-2.2** Search results respect all other filters (provider, duration, resolution, favorites, rating) and sort options.
- **FR-2.3** Empty `q` parameter is treated as no search (same as omitting).
- **FR-2.4** Search is case-insensitive and supports prefix matching (FTS5 default tokenization).

### FR-3: Filters

- **FR-3.1** `GET /api/videos` accepts optional filter parameters: `provider`, `duration_min`, `duration_max`, `min_height`, `favorites_only`, `min_rating`, `folder`.
- **FR-3.2** `duration_min` / `duration_max` filter by `duration_ms` range (inclusive). Null-duration videos are excluded when either duration filter is active.
- **FR-3.3** `min_height` filters by video `height >= min_height` (e.g. 480 for SD+, 720 for HD+, 1080 for FHD+, 2160 for 4K+).
- **FR-3.4** `favorites_only=true` restricts to videos the current owner has favorited.
- **FR-3.5** `min_rating=N` restricts to videos the current owner has rated ≥ N.
- **FR-3.6** `folder={path}` restricts to videos whose top-level path segment matches. The folder parameter matches the first path component (e.g., `folder=Movies` matches `/Movies/Action/movie.mp4`).
- **FR-3.7** All filters compose with each other, with search, and with sort/pagination.

### FR-4: Extended sorting

- **FR-4.1** `GET /api/videos?sort={key}` supports: `name`, `name-desc`, `size`, `size-asc`, `date-desc` (default), `date`, `duration`, `duration-desc`, `rating`.
- **FR-4.2** Sort applies to the dedup representative rows. Null values (null duration, null rating) sort last in ascending order, first in descending order (SQLite `NULLS LAST` / `NULLS FIRST` emulation).
- **FR-4.3** `rating` sort orders by the current owner's `my_rating`.

### FR-5: Favorites

- **FR-5.1** `POST /api/videos/{id}/favorite` marks a video as favorited by the current owner. Idempotent (200 even if already favorited). Requires CSRF.
- **FR-5.2** `DELETE /api/videos/{id}/favorite` removes the favorite. Idempotent (200 even if not favorited). Requires CSRF.
- **FR-5.3** `GET /api/videos` includes `is_favorite: bool` on each video summary (LEFT JOIN `video_favorites` for the current owner).
- **FR-5.4** Favorites survive video re-scans (keyed on `video_id`; upsert preserves the video row's PK).
- **FR-5.5** Disconnecting a provider cascades to delete the connection's videos, which cascades to delete their favorites (`ON DELETE CASCADE`).

### FR-6: Ratings

- **FR-6.1** `PUT /api/videos/{id}/rating` with body `{ "rating": N }` (N = 1–5) sets the current owner's rating for the video. Creates or updates. Requires CSRF.
- **FR-6.2** `DELETE /api/videos/{id}/rating` clears the owner's rating for the video. Idempotent. Requires CSRF.
- **FR-6.3** `GET /api/videos` includes `my_rating: Option<i32>` on each video summary (LEFT JOIN `video_ratings` for the current owner).
- **FR-6.4** Rating must be an integer 1–5; out-of-range returns `400 Bad Request`.

### FR-7: Folder enumeration

- **FR-7.1** `GET /api/videos/folders` returns a JSON array of `{ folder: String, video_count: i64 }`.
- **FR-7.2** `folder` is the top-level path segment (first directory in `path`). Videos with `NULL` path are grouped under `"(Unsorted)"`.
- **FR-7.3** Dedup-aware: counts reflect unique videos (deduplicated), not raw rows.
- **FR-7.4** Sorted by `video_count` descending.

### FR-8: Browse page

- **FR-8.1** The home page (`/`) renders the browse experience when the owner has at least one connection.
- **FR-8.2** **Hero showcase**: a large featured video at the top with thumbnail backdrop, title, metadata (duration, resolution, provider badges, dedup badge), and quick actions (favorite toggle, rating stars). Featured = most recently scanned video (or a random pick from the top 20 if the library is large enough).
- **FR-8.3** **Scrollable shelves** (horizontal rows, Netflix/Plex style):
  - **Recently Added** — sort by `created_at` desc, top 20.
  - **Favorites** — owner's favorited videos (hidden if zero favorites).
  - **By Provider** — one shelf per connected provider, top 20 per provider.
  - **By Folder** — one shelf per top-level folder (from `GET /api/videos/folders`), top 20 per folder (limited to top 5 folders by count).
- **FR-8.4** **Poster grid**: below the shelves, a responsive grid of `PosterCard` components showing all videos with pagination (or "View All" expanding the grid).
- **FR-8.5** Each shelf has a "View All" action that scrolls to the filterable grid with the shelf's filter pre-applied.
- **FR-8.6** Loading, error, and empty states are handled (empty library shows the M1 first-run guide).

### FR-9: Poster cards

- **FR-9.1** `PosterCard` displays: thumbnail (via `GET /api/videos/{id}/thumbnail`), video name, duration badge, resolution badge, provider badge(s), dedup badge ("Also in: X") if applicable.
- **FR-9.2** Hover state reveals favorite heart toggle and rating stars.
- **FR-9.3** If the thumbnail returns 404 (unsupported), a generated placeholder is shown (gradient background + first letter of filename).
- **FR-9.4** Loading skeleton while the thumbnail image loads.

### FR-10: Provider modularization

- **FR-10.1** `Provider` trait gains `fetch_thumbnail(&self, file_id: &str) -> ProviderResult<ThumbnailData>`.
- **FR-10.2** `ProviderFactory` trait gains `authorization_url()`, `exchange_code()`, `fetch_user_info()`, `is_configured()`. Each factory implements its full OAuth lifecycle.
- **FR-10.3** No `match provider {}` dispatch blocks in `connections.rs` (or any non-provider module). All per-provider logic lives inside the provider module.
- **FR-10.4** Google Drive provider resolves `path` via batch parent-ID resolution during scan. Collects unique parent IDs across a page, fetches folder names via `files.list?q=…`, builds full paths using a scan-local `HashMap<folder_id, path>` cache. Folders themselves have parents; resolution recurses up, caching intermediate results.
- **FR-10.5** Dropbox provider infers `mime_type` from file extension when the API doesn't provide one (`.mp4` → `video/mp4`, `.mkv` → `video/x-matroska`, `.webm` → `video/webm`, `.mov` → `video/quicktime`, etc.).
- **FR-10.6** Shared helpers (`to_hex`, `classify_token_error`, `TokenResponse`, refresh-preservation) extracted to `providers/common.rs`.

## Non-functional requirements

| Category    | Requirement                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Performance | `GET /api/videos` with search + filters p99 < 500 ms for catalogs up to 10,000 videos (FTS5 indexed; QueryBuilder parameterized). |
| Performance | Thumbnail proxy first-fetch < 3 s (provider API call + filesystem write); cache hit < 50 ms.                                      |
| Security    | Favorites/ratings mutations require CSRF token + authenticated session. Thumbnail proxy requires session.                         |
| Reliability | Thumbnail fetch failure degrades gracefully (placeholder shown); does not block browse experience.                               |
| Portability | Thumbnails cached to `/data/thumbnails/` (Docker volume persisted). No new system library dependencies.                          |
| Operability | FTS5 index maintained automatically via triggers (no manual reindexing). Folder counts computed on-demand.                      |

## Acceptance criteria (milestone-level)

- [ ] Browse page shows hero showcase + scrollable shelves + poster grid when connections exist
- [ ] Thumbnails render on poster cards (provider-native, cached after first fetch)
- [ ] Search returns relevant results across video name and path (FTS5)
- [ ] Filters (provider, duration, resolution, favorites-only, min-rating, folder) compose correctly
- [ ] Extended sorting (name ±, size ±, date ±, duration ±, rating desc) works
- [ ] Owner can favorite/unfavorite videos; favorite state persists across page reloads
- [ ] Owner can rate videos 1–5 stars; rating state persists across page reloads
- [ ] Favorites shelf appears only when the owner has favorites
- [ ] By Folder shelves group videos by top-level path segment
- [ ] `GET /api/videos/folders` returns correct folder list with dedup-aware counts
- [ ] Provider trait has `fetch_thumbnail()`; each provider implements it independently
- [ ] No `match provider {}` dispatch in `connections.rs` (all via `ProviderFactory` trait)
- [ ] Google Drive videos have populated `path` (batch parent resolution)
- [ ] Dropbox videos have inferred `mime_type` (from file extension)
- [ ] `GET /api/videos` p99 < 500 ms with search + filters on 10K video catalog
- [ ] Thumbnail proxy caches to filesystem; repeat hits served from cache
- [ ] M1 e2e tests still pass (auth flow + catalog flow)
- [ ] New e2e tests cover: search, filter, favorite, rating, thumbnail display

## Dependencies

- **M1 — Connect & Catalog** (complete): unified deduplicated video catalog, provider connections, scanner, dedup, connections UI, video list UI.
- **External:** provider APIs must support thumbnails for connected file types (all three do for common video formats).

## Risks

| Risk                                        | Impact | Mitigation                                                                                                          |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| FTS5 not available in bundled SQLite         | Low    | `libsqlite3-sys` with `bundled` feature enables FTS5 by default. Verified at migration time.                          |
| Google Drive path resolution adds API calls | Med    | Batch per page (not per file) + scan-local cache. Worst case O(unique folders) extra calls per scan.                  |
| Thumbnail CDN URL expiry (Drive, OneDrive)  | Low    | Proxy fetches bytes immediately on first view and caches to disk. Never stores raw CDN URLs long-term.                |
| Large library shelf performance             | Med    | Shelves use `LIMIT 20` queries; grid uses pagination. FTS5 + indexes keep queries fast.                                |
| Provider thumbnail API rate limits          | Low    | Thumbnails fetched lazily (only when card scrolls into view), not batch-fetched.                                     |
| FTS5 index bloat on re-scan                 | Low    | Triggers handle INSERT/UPDATE/DELETE correctly. Re-scan upserts don't trigger redundant FTS updates (ON CONFLICT).   |

## Open questions resolved

- **Thumbnails**: **Provider-native via lazy proxy + filesystem cache.** No ffmpeg, no scan-time fetching. Each provider implements `fetch_thumbnail()` on the `Provider` trait.
- **Folder grouping**: **Top-level `path` segment.** Google Drive resolves paths via batch parent-ID lookup during scan. Dropbox and OneDrive already populate `path`.
- **Genre**: **Not implemented.** No genre metadata exists for arbitrary file-based videos. Folder-based grouping ("by folder") is the practical substitute. Manual collections deferred to future.
- **Personal data storage**: **SQLite for self-hosted (M2 scope).** The VISION's "personal data in owner's cloud" principle applies to M5 hosted. M2 is self-hosted single-owner.
- **Browse route**: **`/` redesigned in place.** No new route. The M1 `VideoList` is replaced by the browse experience. First-run guide still shows with zero connections.
- **Provider modularization**: **Full trait extension.** `Provider` gains `fetch_thumbnail()`. `ProviderFactory` gains OAuth lifecycle methods. All `match provider {}` dispatch eliminated from shared code. Shared helpers extracted to `providers/common.rs`.
