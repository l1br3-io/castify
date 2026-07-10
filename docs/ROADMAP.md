# Roadmap

> **Status:** Directional overview — no dates, no calendar. Business-level; no technical detail.
> **Companion:** [`VISION.md`](./VISION.md) — the problem and goals. This roadmap does not duplicate requirements; it communicates direction and sequencing.

Castify is a free, open-source **personal media hub**: connect the cloud storage you already pay for, unify every provider into one library, organize and browse your videos, share it with a single link, and play any video directly from the cloud. The media never leaves your cloud.

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

The launch scope is **locked to the media hub core**: connect, catalog, browse, play, share, and dual deployment. Everything else is deferred.

---

## Themes

Four strategic directions make up the launch:

| Theme | What it means |
|-------|---------------|
| **Unify** | Bring-your-own-cloud aggregation across providers — one library from many clouds |
| **Browse** | A clean, organized library of your videos that's easy to navigate |
| **Share** | Account-less access for family and friends — one link, no viewer accounts |
| **Deploy anywhere** | One product — run it yourself, or use the hosted service |

---

## Launch — Media Hub Core

Six milestones, each shipping a demoable increment built on the last. The product is built **self-host-first** through M0–M4 (the run-it-yourself experience), then M5 generalizes it to the hosted multi-user service.

| # | Milestone | Ships (user-visible) |
|---|-----------|----------------------|
| M0 | **Foundation** | The app installs and runs, stores its data durably, validates its setup, and signs you in securely — working out of the box in a basic mode with no external dependencies |
| M1 | **Connect & Catalog** | Connect Google Drive, Dropbox, or OneDrive; the app scans your cloud and shows every video in one unified list, flagging duplicates across providers |
| M2 | **Browse** | The catalog becomes a clean, organized library — hero showcase, scrollable rows, poster grid, search, filters, favorites, and ratings |
| M3 | **Play** | Click any video and it plays straight from your cloud — seek, skip, change speed and subtitles, and resume where you left off |
| M4 | **Share** | Send one link and family browses instantly — no viewer accounts, read-only, password-optional, expiring, revocable |
| M5 | **Deploy Anywhere** | The same product runs self-hosted *or* as a hosted service; each owner's personal data stays private in their own cloud |

### M0 — Foundation
The app installs and runs. It boots up, stores its data durably so nothing is lost across restarts, validates its setup and tells you clearly if something's missing, and signs you in securely. Out of the box it works in a basic mode without requiring any external service keys.

### M1 — Connect & Catalog
Connect your cloud providers — Google Drive, Dropbox, or OneDrive — securely, several at once. The app scans your cloud for videos and shows them in one unified list, flagging duplicates across providers so the same file in two clouds only appears once. Connect and disconnect anytime, with a first-run guide to smooth over any setup.

### M2 — Browse
The catalog becomes a clean, organized library. A hero showcase, scrollable rows (recent, favorites, by genre, by provider), a poster grid, search, filters, sorting, favorites, and ratings — everything you need to navigate and organize your unified library.

### M3 — Play
Click any video and it plays straight from your cloud — no waiting for the file to be moved or re-hosted. Seek, skip, change playback speed and subtitles, and resume exactly where you left off. The app handles common formats gracefully and plays whatever your browser supports, with a client-side fallback for tricky ones.

### M4 — Share
Share your whole library with a single link — no viewer accounts, no app install for your guests. Family and friends get read-only access to browse and search your library using your connected cloud, with no exposure of your credentials. Links can be password-protected, set to expire, capped to a number of simultaneous viewers, and revoked instantly. Guests never reach your settings, connections, or admin areas.

### M5 — Deploy Anywhere
The same product runs either self-hosted on your own hardware or as a hosted service anyone can use without installing anything. On the hosted service, anyone can become an owner just by connecting a cloud provider — no signup form, no email, no password. Sensible per-owner limits keep the service sustainable and point power users toward self-hosting. Each owner's personal data — favorites, history, preferences — stays private in their own cloud, never on the host's servers.

---

## Future directions *(not current priorities)*

Revisited once the core hub is shipped and adopted:

- **Media intelligence** — memories and stories, face and place search, smart organization and cleanup.
- **Platform & ecosystem** — cross-platform mobile, desktop, and CLI apps, TV apps, casting, watch parties, subtitles, multi-user household profiles, audio/music support.

---

## Status

Greenfield — no source yet. [`VISION.md`](./VISION.md) holds the problem and goals; this roadmap is directional and will be updated as milestones ship and PRDs land under `docs/prds/`.
