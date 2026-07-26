# AGENTS.md

## Overview

Castify is a free, open-source personal media server (Rust workspace + Vite/React SPA).
Connect cloud providers, unify them into one catalog, browse, and play. See
[`docs/VISION.md`](docs/VISION.md) for the *why* and [`docs/ROADMAP.md`](docs/ROADMAP.md)
for direction + the delivery lifecycle. Current-phase requirements live in
[`SPEC.md`](SPEC.md); current work in [`tasks/plan.md`](tasks/plan.md) +
[`tasks/todo.md`](tasks/todo.md).

## Commands

All recipes via [`just`](./justfile). Key ones:

- `just preflight` — format/clippy/typecheck sweep before committing
- `just test` — workspace tests + frontend tests
- `just dev` — boot backend + frontend locally
- `just e2e` — Playwright suite against the docker stack
- `just bench` — catalog/stream benchmarks

## Tech

Two stacks, kept separate at the boundary:

- **Rust** — `crates/` workspace (api, core, storage, auth, catalog, cache, bench).
- **TypeScript / React** — `frontend/` SPA (Vite + React + Tailwind + TanStack Query).

Before writing or editing code in either stack, confirm its conventions are in recent
context. The `.opencode/` harness carries stack-specific conventions; load the matching
files for the stack you are touching.

## Skill-driven execution

Non-trivial work is driven by skills rather than ad-hoc steps. Notably: new phases run
through `/spec` → `/planning` → `/build` → `/test` → `/review` → `/ship`
(see [`docs/ROADMAP.md`](docs/ROADMAP.md) § How we plan). Match the skill to the task —
e.g. test-driven-development for behavior changes, debugging-and-error-recovery for
failures, code-review-and-quality before merge.

## Orchestration

Single-phase, single-plan: `tasks/plan.md` + `tasks/todo.md` hold the **current phase
only** (M8). Finished phases live as units under [`tasks/archive/`](tasks/archive/) —
do not split an archive's SPEC.md from its plan.md/todo.md. Status lives in the
checklist, not in a duplicate table elsewhere.

## Boundaries

- **Data storage.** Before adding server-side storage, API endpoints, or recurring
  server requests, consult
  [`docs/data-storage-principles.md`](docs/data-storage-principles.md). Default to
  client-side storage (IndexedDB) for per-device data; justify every server-side write.
- **ADR immutability.** `docs/adr/` (when present) is immutable; supersede a decision
  with a new ADR, never rewrite one.
- **`.opencode/` is out of scope** here — the harness is replaced separately. This file
  intentionally carries no harness-internal path references.
