# Roadmap

> **Status:** Directional overview — no dates, no calendar. Business-level; no technical detail.
> **Companion:** [`VISION.md`](./VISION.md) — the problem and goals. This roadmap does not duplicate requirements; it communicates direction and sequencing.

Castify is a free, open-source **personal media server**: connect the cloud storage you already pay for, unify every provider into one library, organize and browse your videos, and play any video directly from the cloud. The media never leaves your cloud. You run it on your own hardware — a NAS, a home server, a VPS, anything that runs Docker.

This is the **top-level overview** of where Castify is heading — the journey, not the spec.

---

## How we plan

Each layer decomposes the one above it:

```text
VISION   "What problem does this project solve?"     VISION.md
  │
ROADMAP  "What directions / milestones?"   (this)     ROADMAP.md
  │
PRDs     "Detailed requirements per area"             docs/prds/   (forthcoming)
  │
EPICS    "Trackable feature groups"
  │
ISSUES   "Specific, actionable work items"
  │
PRs      "Implementation against issues"
  │
RELEASES "Ship it, tag it, communicate it"
```

The launch scope is **locked to the personal media hub core**: connect, catalog, browse, and play. Everything else is deferred.

---

## Themes

Three strategic directions make up the launch:

| Theme | What it means |
|-------|---------------|
| **Unify** | Bring-your-own-cloud aggregation across providers — one library from many clouds |
| **Browse** | A clean, organized library of your videos that's easy to navigate |
| **Play** | Direct cloud playback — click any video and it streams straight from your provider |
| **Run it yourself** | Single binary, durable storage, low ops — install in one command, run forever |

---

## Launch — Personal Media Hub

Three milestones, each shipping a demoable increment built on the last.

| # | Milestone | Ships (user-visible) |
|---|-----------|----------------------|
| M0 | **Foundation** | The app installs and runs, stores its data durably, validates its setup, and signs you in securely — working out of the box in a basic mode with no external dependencies |
| M1 | **Connect & Catalog** | Connect Google Drive, Dropbox, or OneDrive; the app scans your cloud and shows every video in one unified list, flagging duplicates across providers |
| M2 | **Browse** | The catalog becomes a clean, organized library — hero showcase, scrollable rows, poster grid, search, filters, favorites, and ratings |
| M3 | **Play** | Click any video and it plays straight from your cloud — seek, skip, change speed and subtitles, and resume where you left off |

### M0 — Foundation
The app installs and runs. It boots up, stores its data durably so nothing is lost across restarts, validates its setup and tells you clearly if something's missing, and signs you in securely. Out of the box it works in a basic mode without requiring any external service keys.

### M1 — Connect & Catalog
Connect your cloud providers — Google Drive, Dropbox, or OneDrive — securely, several at once. The app scans your cloud for videos and shows them in one unified list, flagging duplicates across providers so the same file in two clouds only appears once. Connect and disconnect anytime, with a first-run guide to smooth over any setup.

### M2 — Browse
The catalog becomes a clean, organized library. A hero showcase, scrollable rows (recent, favorites, by genre, by provider), a poster grid, search, filters, sorting, favorites, and ratings — everything you need to navigate and organize your unified library.

### M3 — Play
Click any video and it plays straight from your cloud — no waiting for the file to be moved or re-hosted. Seek, skip, change playback speed and subtitles, and resume exactly where you left off. The app handles common formats gracefully and plays whatever your browser supports, with a client-side fallback for tricky ones.

---

## Future directions *(not current priorities)*

Revisited once the core hub is shipped and adopted:

- **Sharing** — read-only access for family and friends via link, password-optional, expiring, revocable.
- **Media intelligence** — memories and stories, face and place search, smart organization and cleanup.
- **Platform & ecosystem** — cross-platform mobile, desktop, and CLI apps, TV apps, casting, watch parties, subtitles, multi-user household profiles, audio/music support.

---

## Status

**M0 (Foundation), M1 (Connect & Catalog), and M2 (Browse) are complete.** M3 (Play) PRD is approved and task breakdown is ready for execution — M3 is the final launch milestone. PRDs live under [`docs/prds/`](./prds/); task breakdown in [`tasks/plan.md`](../tasks/plan.md).

---

## What's next: self-hosted media server arc

After launch (M0–M3), Castify grows into a real self-hosted media server — Plex/Jellyfin-class features that leverage the user's own hardware. Six milestones (M3.5 through M8) add disk caching, codec probing, transcoding, adaptive bitrate, and advanced subtitle support. The user owns the server; server bandwidth, CPU, and disk are free.

**M3.5–M6 are now implemented.** M7 (adaptive bitrate) and M8 (advanced subtitles) are next.

Full arc: [`ROADMAP-self-hosted-media-server.md`](./ROADMAP-self-hosted-media-server.md). Per-milestone PRDs: [`docs/prds/`](./prds/).
