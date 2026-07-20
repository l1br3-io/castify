# PRD: M8 — Advanced Subtitles

> **Status:** Baseline — sixth milestone of the self-hosted media server arc.
> **Companion:** [`ROADMAP-self-hosted-media-server.md`](../ROADMAP-self-hosted-media-server.md), [`m6-transcoding.md`](./m6-transcoding.md).

## Purpose

M8 makes Castify render every subtitle format correctly. Today the catalog supports only sidecar SRT/VTT files (M3). Real video libraries have far more: ASS/SSA with full styling (positions, fonts, effects), image-based PGS (Blu-ray) and VobSub (DVD), and embedded tracks muxed into MKV/MP4 containers.

M8 routes each format to the right rendering path:
- **Text-based sidecar (SRT/VTT/ASS/SSA)**: serve to browser. ASS/SSA renders with full styling via libass.js.
- **Image-based sidecar (PGS/VobSub)**: burn into video frame during transcode.
- **Embedded/muxed tracks** (any format inside MKV/MP4): extracted at probe time (M5), routed to sidecar logic above based on extracted format.

ASS gets libass.js (browser-side, full styling, toggleable). PGS/VobSub gets burn-in (server-side, no browser option exists). Embedded tracks are extracted once at probe time and then treated as sidecars.

## In scope

- **Schema migration `0010_subtitle_formats.sql`** — relax `video_subtitles.format` CHECK constraint to allow `ass`, `ssa`, `pgs`, `vobsub`. Add `format_family` and `embedded_track_id` columns.
- **libass.js integration** for ASS/SSA rendering in the browser (lazy-loaded when an ASS track is selected).
- **Burn-in pipeline**: when a user enables an image-based subtitle track during transcode playback, the transcode is restarted with `?burn_subtitles={track_id}`. Burn-in cache key includes `subtitle_track_id`.
- **Embedded subtitle extraction** — at probe time (M5 extension), extract sidecar-style files from MKV/MP4 containers. Text tracks (SRT/ASS) extracted to a `video_subtitles` row with `embedded_track_id` populated. Image tracks (PGS/VobSub) recorded in `video_subtitle_tracks` (already from M5) for burn-in routing.
- **Subtitle track selector UI** — extended from M3 to show format hints ("English (ASS)", "Spanish (PGS — burned)") and surface a "burn subtitles" notice when image-based tracks are selected.
- **Burn-in cache key** — `(video_id, variant, profile, subtitle_track_id)`. Burned and unburned transcodes cached separately.
- **Format detection** — uses M5's probe data (`format_family` column) to route; no runtime probing.

## Out of scope (deferred)

- Streaming text subtitles during transcode (subtitles that appear/disappear based on player position when transcoding). Use embedded `<track>` for now.
- Custom subtitle styling (user-chosen fonts, colors). Use the styling baked into the ASS file.
- Multiple concurrent subtitle tracks (e.g., bilingual). One track at a time.
- Subtitle search (full-text search across subtitle content). Future direction.
- Auto-translation. Future direction.
- Karaoke effects for ASS. libass.js handles these; we just enable it.

## Architecture decisions (locked)

| Area                                | Choice                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ASS rendering**                    | libass.js in the browser. Full styling (positioning, fonts, effects, karaoke). Preserves subtitle toggle without re-transcode. Server CPU not wasted on what browser does well.                                                                                                                |
| **PGS/VobSub rendering**             | Server-side burn-in during transcode. No browser-side option exists for these formats; burning is the only path.                                                                                                                                                                                                |
| **Burn-in trigger**                  | User selects an image-based subtitle track in the player UI → player re-requests transcode with `?burn_subtitles={track_id}` → server restarts transcode with the subtitles filter applied to ffmpeg.                                                                                                                |
| **Burn-in cache key**                | `(video_id, variant, profile, subtitle_track_id)`. Burned and unburned transcodes cached separately. Toggling subtitles doesn't invalidate the main transcode cache.                                                                                                                                                  |
| **Embedded track extraction**        | At probe time (M5). ffprobe already touches the file. Extract text-based tracks (SRT/ASS) to sidecar files in `<data_dir>/extracted-subs/<video_id>/<track_id>.{ext}`. Record in `video_subtitles` with `embedded_track_id` populated. Image tracks (PGS/VobSub) stay muxed; only metadata is extracted (already done in M5 via `video_subtitle_tracks` table). |
| **Format detection**                 | Uses M5 probe data. No runtime format detection (would duplicate work).                                                                                                                                                                                                                                       |
| **Burn-in profile encoding**          | The transcode profile string gains a `+subs-{track_id}` suffix when burning. Distinct cache entry, same worker pool.                                                                                                                                                                                            |
| **libass.js loading**                 | Lazy-loaded only when user selects an ASS track. ~500 KB additional bundle; doesn't affect initial page load for SRT/VTT-only videos.                                                                                                                                                                            |

## Schema migration `0010_subtitle_formats.sql`

SQLite doesn't support `ALTER TABLE ... DROP CHECK`. Migration rebuilds the table:

```sql
-- Schema migration for advanced subtitle formats.
-- SQLite doesn't support ALTER TABLE ... DROP CONSTRAINT, so we rebuild.

BEGIN TRANSACTION;

-- Step 1: Create new table with relaxed CHECK and new columns.
CREATE TABLE video_subtitles_new (
    id                TEXT PRIMARY KEY NOT NULL,
    video_id          TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    connection_id     TEXT REFERENCES provider_connections(id) ON DELETE CASCADE,
    provider_file_id  TEXT,                       -- NULL for embedded-extracted tracks
    embedded_track_id INTEGER,                     -- references video_subtitle_tracks.embedded_index; NULL for sidecars
    language          TEXT,
    filename          TEXT NOT NULL,
    format            TEXT NOT NULL CHECK (format IN ('srt', 'vtt', 'ass', 'ssa', 'pgs', 'vobsub')),
    format_family     TEXT NOT NULL CHECK (format_family IN ('text', 'image')),
    extracted_path    TEXT,                        -- on-disk path for extracted-embedded tracks
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, COALESCE(provider_file_id, '_embedded_' || embedded_track_id))
);

-- Step 2: Migrate existing rows (all are 'srt' or 'vtt', format_family = 'text').
INSERT INTO video_subtitles_new (id, video_id, connection_id, provider_file_id, embedded_track_id, language, filename, format, format_family, extracted_path, created_at)
SELECT id, video_id, connection_id, provider_file_id, NULL, language, filename, format, 'text', NULL, created_at
FROM video_subtitles;

-- Step 3: Drop old, rename new.
DROP TABLE video_subtitles;
ALTER TABLE video_subtitles_new RENAME TO video_subtitles;

CREATE INDEX idx_video_subtitles_video ON video_subtitles(video_id);

COMMIT;
```

**Why `format_family` denormalized**: drives the burn-vs-serve decision without a lookup. `image` → burn-in path; `text` → serve-to-browser path.

**Why `extracted_path`**: extracted-embedded text tracks are bytes on disk. NULL for sidecars (bytes still at provider).

**Why keep `video_subtitle_tracks` separate** (from M5): that table holds the *discovery* of embedded tracks at probe time. `video_subtitles` holds the *routing decision* (sidecar or extracted). M8 may merge them at the API layer; M8 schema keeps them separate.

## Functional requirements

### FR-1: Schema migration

- **FR-1.1** `0010_subtitle_formats.sql` applies cleanly on databases with existing `video_subtitles` rows.
- **FR-1.2** Existing rows preserve all metadata; gain `format_family = 'text'`, `embedded_track_id = NULL`, `extracted_path = NULL`.
- **FR-1.3** New CHECK constraint allows `'srt'`, `'vtt'`, `'ass'`, `'ssa'`, `'pgs'`, `'vobsub'`.

### FR-2: ASS/SSA rendering (libass.js)

- **FR-2.1** `libass.js` added to `frontend/package.json`. Lazy-loaded via React.lazy when an ASS track is selected.
- **FR-2.2** `use-stream-url` returns subtitle track metadata including `format` and `format_family`.
- **FR-2.3** Watch route detects ASS/SSA selection and initializes libass.js with the subtitle URL.
- **FR-2.4** libass.js renders to a canvas overlay positioned over the `<video>` element.
- **FR-2.5** Subtitle toggle works (on/off) without re-transcode.
- **FR-2.6** All ASS features supported: positioning, fonts, effects, karaoke.
- **FR-2.7** Subtitle URL endpoint `GET /api/videos/{id}/subtitles/{track_id}` returns the raw ASS content with `Content-Type: text/plain`.

### FR-3: PGS/VobSub burn-in

- **FR-3.1** When user selects an image-based subtitle track during transcode playback, the player re-requests the transcode master playlist with `?burn_subtitles={track_id}` query parameter.
- **FR-3.2** Server detects the query parameter and routes to a burn-in worker (same pool, different cache key).
- **FR-3.3** Burn-in cache key: `(video_id, variant, profile, subtitle_track_id)`. Burns and unburned transcodes cached independently.
- **FR-3.4** ffmpeg pipeline adds `-vf subtitles={path}` filter (or appropriate filter for the format).
- **FR-3.5** First-segment latency for burn-in may be 1.5–2x baseline (filter setup + first subtitle render). Acceptable.
- **FR-3.6** Burn-in playlist endpoint lists the burned variant as a separate entry in master playlist (so client can switch).
- **FR-3.7** Toggling back to "no subtitles" returns to the unburned transcode cache (instant if cached).

### FR-4: Embedded subtitle extraction (extends M5)

- **FR-4.1** M5's probe worker is extended: when probing a video, also extract text-based embedded tracks (SRT/ASS) to disk via ffmpeg-the-third's demux capability.
- **FR-4.2** Extracted files stored at `<data_dir>/extracted-subs/<video_id>/<track_id>.{ext}`.
- **FR-4.3** A `video_subtitles` row is inserted for each extracted text track: `provider_file_id = NULL`, `embedded_track_id = <stream_index>`, `format = 'srt' | 'ass' | etc.`, `format_family = 'text'`, `extracted_path = '<path>'`.
- **FR-4.4** Image-based embedded tracks (PGS/VobSub) are NOT extracted at probe time (large bytes). Only `video_subtitle_tracks` rows exist; burn-in reads from the source video file directly via ffmpeg.
- **FR-4.5** `GET /api/videos/{id}/subtitles` returns both sidecar and extracted-text tracks in a unified list.
- **FR-4.6** `GET /api/videos/{id}/subtitles/{track_id}` serves extracted text tracks from disk (no provider round-trip).

### FR-5: Subtitle track selector UI

- **FR-5.1** Subtitle selector (existing from M3) is extended to show format hints: "English (ASS)", "Spanish (PGS — burned)", "Off".
- **FR-5.2** When user selects an image-based track during transcode playback, a notice appears: "Subtitles will be burned into the video. Playback may restart."
- **FR-5.3** Confirmation flow: "Restart playback with burned subtitles?" → Yes / Cancel.
- **FR-5.4** Burn-in toggle persists per-session (selecting "Off" returns to unburned transcode).

### FR-6: Format detection

- **FR-6.1** Format detection uses M5's probe data (`format_family` column on `video_subtitles` and `video_subtitle_tracks`).
- **FR-6.2** No runtime probing in M8.
- **FR-6.3** If a track's `format_family` is unknown (edge case), it's treated as text and served to the browser. Failure mode is "subtitle doesn't render correctly", not "playback breaks".

### FR-7: Burn-in cache eviction

- **FR-7.1** Burned transcodes use the same cache pool as unburned (M6's `transcode_cache_entries`).
- **FR-7.2** Cache key includes `subtitle_track_id` (NULL for unburned).
- **FR-7.3** Burned and unburned variants of the same video can coexist in cache.
- **FR-7.4** LRU eviction treats them as separate entries.

## Non-functional requirements

| Category    | Requirement                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Performance | ASS rendering via libass.js: zero impact on video playback framerate.                                                                        |
| Performance | PGS burn-in first-segment latency < 2x baseline (6 sec for default 3 sec target).                                                            |
| Performance | Embedded text track extraction at probe time: < 2 sec additional wall-clock per track.                                                       |
| Reliability | libass.js load failure degrades gracefully (subtitle off, video continues).                                                                  |
| Reliability | Burn-in failure falls back to unburned transcode + warning.                                                                                  |
| Reliability | Subtitle extraction failures don't block probe completion (other tracks still extract).                                                       |
| Security    | All subtitle endpoints require authenticated session. POST/DELETE endpoints require CSRF.                                                    |

## Configuration

No new env vars in M8. All behavior driven by detected subtitle format.

The transcode cache size (M6's `CASTIFY_TRANSCODE_CACHE_MAX_BYTES`) may need adjustment to accommodate burned variants; default 50 GiB is expected to be sufficient.

## Acceptance criteria (milestone-level)

- [ ] Schema migration `0010_subtitle_formats.sql` applies cleanly on existing DBs
- [ ] Existing sidecar SRT/VTT subtitles continue to work unchanged
- [ ] Sidecar ASS file renders with full styling (positioning, fonts) in Chrome + Firefox + Safari via libass.js
- [ ] PGS subtitle track burned into transcode output displays correctly
- [ ] VobSub subtitle track burned into transcode output displays correctly
- [ ] Embedded MKV subtitle tracks (text-based) extract at probe time and serve as expected
- [ ] Embedded MKV subtitle tracks (image-based) burn correctly
- [ ] Subtitle selector shows format hints
- [ ] Burn-in notice + confirmation flow works
- [ ] Burned and unburned transcodes coexist in cache (toggling doesn't re-transcode)
- [ ] Subtitle toggle works without re-transcode for text formats
- [ ] All existing M0–M7 tests pass unchanged
- [ ] `cargo build --workspace && cargo clippy --workspace --all-targets && cargo test --workspace` clean

## Dependencies

- **M5 — Codec Model** (complete): probe extracts embedded subtitle track list, `format_family` drives routing.
- **M6 — Transcoding** (complete): burn-in uses the transcode pipeline; cache key extended.
- **External:** `libass.js` npm package (lazy-loaded).

## Risks

| Risk                                              | Impact | Mitigation                                                                                                                  |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| libass.js bundle size impact                        | Med    | Lazy-loaded only when ASS track selected. Code-split via React.lazy.                                                          |
| libass.js rendering perf on low-end devices         | Med    | libass.js is well-optimized; benchmark on a low-end Chromebook in M8 testing. Fallback to burn-in if perf unacceptable.       |
| Burn-in cache doubles disk usage                    | Med    | Burned variants cached independently; LRU evicts the less-used one. Conservative default cache size (50 GiB).                  |
| Embedded extraction slow for large MKV files         | Low    | Runs in background at probe time; doesn't block playback.                                                                      |
| ASS files with unusual encoding (non-UTF-8)          | Low    | libass.js handles common encodings. Detect encoding via ffmpeg during extraction (convert to UTF-8 on extract).                |
| PGS subtitle formatting issues (positioning, timing) | Med    | ffmpeg's PGS support is mature. Test with real Blu-ray MKV files during M8.                                                   |
| Burn-in toggle latency too high (re-buffer)           | Med    | Burned variant pre-warmed in background when user hovers over an image-based track in selector (M8 ship stretch goal).         |

## Open questions resolved

- **ASS rendering**: libass.js in browser. Full styling, toggleable, no server CPU cost.
- **PGS/VobSub rendering**: server-side burn-in (no browser option exists).
- **Burn-in trigger**: user selects image-based track → player re-requests transcode with `?burn_subtitles={track_id}`.
- **Burn-in cache key**: `(video_id, variant, profile, subtitle_track_id)`. Independent of unburned cache.
- **Embedded track extraction**: at probe time (M5 extension). Text extracted to disk; image stays muxed.
- **Format detection**: from M5 probe data (`format_family` column). No runtime probing.
- **Multiple concurrent subtitle tracks**: not supported in M8. One track at a time.
