# Roadmap

> **Companion:** [`VISION.md`](./VISION.md) — the problem and goals. This roadmap
> communicates direction and sequencing only; per-effort requirements live in
> [`docs/specs/<effort-slug>/spec.md`](./specs/) — one directory per effort.

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
SPEC     "Current effort requirements"    docs/specs/<effort-slug>/spec.md
```

### Each effort ships through the harness lifecycle

```text
DEFINE → /spec       spec-driven-development             → docs/specs/<slug>/spec.md (status: draft)
PLAN   → /planning   planning-and-task-breakdown         → docs/specs/<slug>/{plan.md, todo.md, tasks/00N-*.md}
BUILD  → /build      incremental-implementation + TDD    → source + tests (flips spec status: draft → active)
VERIFY → /test       debugging-and-error-recovery        → pnpm verify green
REVIEW → /review     code-review-and-quality             → sign-off
SHIP   → /ship       shipping-and-launch                 → merge PR; spec status flips to shipped (dir stays in place)
```

When an effort ships, its spec.md frontmatter flips to status: shipped with the merge
date. The directory stays at `docs/specs/<slug>/` forever — no archive step, no move.
Git is the full history; the filesystem is the browsable index. The next effort starts
on a fresh branch with a fresh `docs/specs/<new-slug>/` directory.

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

> **Last shipped: Lossless Reconnect** — disconnect is now a soft-delete; reconnecting the same account revives in place, preserving every video UUID + resume position. See [`docs/specs/lossless-reconnect/spec.md`](./specs/lossless-reconnect/spec.md). All planned milestones (M0–M8) are shipped.

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

Dependency sequencing for the self-hosted arc: M3.5 → M4 → M5 → M6 (needs M4+M5) →
{M7, M8} (each needs M6; M7 and M8 are independent of each other).

---

## Future directions *(not current priorities)*

Revisited once the core hub is shipped and adopted:

- **Sharing** — read-only access for family and friends via link, password-optional, expiring, revocable.
- **Media intelligence** — memories and stories, face and place search, smart organization and cleanup.
- **Platform & ecosystem** — cross-platform mobile, desktop, and CLI apps, TV apps, casting, watch parties, multi-user household profiles, audio/music support.
