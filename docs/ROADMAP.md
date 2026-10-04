# Roadmap

> **Companion:** [`VISION.md`](./VISION.md) — the problem and goals. This roadmap
> communicates direction and sequencing only; per-effort requirements, decisions,
> and outcomes live in the effort's anchor commit message —
> `git log --grep='<effort-slug>'`.

Castify is a free, open-source **personal media server**: connect the cloud storage
you already pay for, unify every provider into one library, organize and browse your
videos, and play any video directly from the cloud. The media never leaves your cloud.
You run it on your own hardware — a NAS, a home server, a VPS, anything that runs
Docker.

---

## How we plan

### Scope decomposes top-down

```text
VISION   "What problem are we solving?"   docs/VISION.md
  │
ROADMAP  "What directions / milestones?"  docs/ROADMAP.md  (this)
  │
RECORD   "Current effort requirements"    anchor commit message (git log --grep=<slug>)
```

### Each effort ships through the harness lifecycle

```text
DEFINE → plan scope   planning-and-task-breakdown     → decisions recorded at landing time
BUILD  → /build       incremental-implementation + TDD → source + tests (one commit per task)
VERIFY → /test        debugging-and-error-recovery     → just ci green
REVIEW → /review      code-review-and-quality          → sign-off
SHIP   → /ship        shipping-and-launch              → merge PR; anchor message finalized
```

When an effort ships, the anchor commit — the commit that landed the feature —
carries its Context/Decisions/Deviations/Outcome block (see AGENTS.md "Git is
the documentation"). Git is the full history and the browsable index; the next
effort starts on a fresh branch.

---

## Themes

| Theme | What it means |
|-------|---------------|
| **Unify** | Bring-your-own-cloud aggregation across providers — one library from many clouds |
| **Browse** | A clean, organized library of your videos that's easy to navigate |
| **Play** | Direct cloud playback — click any video and it streams straight from your provider |
| **Run it yourself** | Single binary, durable storage, low ops — install in one command, run forever |

---

## Milestones

> **Last shipped: Share management** — generated share names, searchable/filtered
> shares list, add-to-existing from the share dialog, and hard-delete (purge).
> See `git log --grep=share-management`.

| Milestone | State |
|-----------|-------|
| M0 — Foundation | Shipped |
| M1 — Connect & Catalog | Shipped |
| M2 — Browse | Shipped |
| M3 — Play | Shipped (launch) |
| M3.5 — Streaming posture refactor | Shipped |
| M4 — Hot video disk cache | Shipped |
| M5 — Codec model (ffprobe) | Shipped |
| M6 — Server-side transcoding | Shipped (reduced scope) |
| M7 — Adaptive bitrate | Shipped |
| M8 — Advanced subtitles | Shipped |
| Lossless Reconnect | Shipped (corrective) |
| Sharing | Shipped |
| M9 — Redesign the home page | Shipped |
| Reset password | Shipped |
| Identity pass | Shipped |
| Mutable share list | Shipped |
| Share manage page | Shipped |
| Share management | Shipped |

Dependency sequencing for the self-hosted arc: M3.5 → M4 → M5 → M6 (needs M4+M5) →
{M7, M8} (each needs M6; M7 and M8 are independent of each other).

---

## Future directions *(not current priorities)*

Revisited once the core hub is shipped and adopted:

- **Media intelligence** — memories and stories, face and place search, smart organization and cleanup.
- **Platform & ecosystem** — cross-platform mobile, desktop, and CLI apps, TV apps, casting, watch parties, multi-user household profiles, audio/music support.
- **Library folders** — Google Drive-style folders the owner creates inside Castify to organize the whole library, layered on the auto-detected cloud-provider folders (new files land at the top level until filed). Reuses the share-folders components; see `git log --grep=share-folders`.
