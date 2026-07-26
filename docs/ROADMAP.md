# Roadmap

> **Companion:** [`VISION.md`](./VISION.md) — the problem and goals. This roadmap
> communicates direction and sequencing only; per-phase requirements live in
> [SPEC.md](../SPEC.md) (root) for the current phase and under
> [`tasks/archive/`](../tasks/archive/) for shipped phases.

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
SPEC     "Current phase requirements"     SPEC.md  (root, one per phase)
```

### Each milestone ships through the harness lifecycle

```text
DEFINE → /spec       spec-driven-development             → SPEC.md
PLAN   → /planning   planning-and-task-breakdown          → tasks/plan.md + tasks/todo.md
BUILD  → /build      incremental-implementation + TDD     → source + tests
VERIFY → /test       debugging-and-error-recovery         → pnpm verify green
REVIEW → /review     code-review-and-quality              → sign-off
SHIP   → /ship       shipping-and-launch                  → tasks/archive/<date>-<slug>/{SPEC.md, plan.md, todo.md}
```

When a phase ships, its SPEC.md + plan.md + todo.md archive **together** under
`tasks/archive/YYYY-MM-DD-<slug>/`, and the next phase starts fresh at `/spec`. A plan
never outlives its phase; a spec never outlives its plan.

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

> **Current phase: M8 — Advanced subtitles** (see [`SPEC.md`](../SPEC.md)).

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
| **M8 — Advanced subtitles** | **Current** |

Dependency sequencing for the self-hosted arc: M3.5 → M4 → M5 → M6 (needs M4+M5) →
{M7, M8} (each needs M6; M7 and M8 are independent of each other).

---

## Future directions *(not current priorities)*

Revisited once the core hub is shipped and adopted:

- **Sharing** — read-only access for family and friends via link, password-optional, expiring, revocable.
- **Media intelligence** — memories and stories, face and place search, smart organization and cleanup.
- **Platform & ecosystem** — cross-platform mobile, desktop, and CLI apps, TV apps, casting, watch parties, multi-user household profiles, audio/music support.
