# AGENTS.md

## Overview

Castify is a free, open-source personal media server (Rust workspace + Vite/React SPA).
Connect cloud providers, unify them into one catalog, browse, and play. See
[`docs/VISION.md`](docs/VISION.md) for the *why* and [`docs/ROADMAP.md`](docs/ROADMAP.md)
for direction + the delivery lifecycle. No effort is active; start the next with
`/spec` (candidates in [`docs/ROADMAP.md`](docs/ROADMAP.md) § Future directions).

## Commands

All recipes via [`just`](./justfile). Key ones:

- `just preflight` — format/clippy/typecheck sweep before committing
- `just test` — workspace tests + frontend tests
- `just dev` — boot backend + frontend locally
- `just e2e` — Playwright suite against the docker stack
- `just bench` — catalog/stream benchmarks

Commands must be quiet on success — output only for errors/failures (token
economy). The justfile enforces this via `just quiet-audit` in CI; apply the
same to direct invocations: `cargo … --quiet` (plus `-- --quiet` to collapse
passing tests to dots), `npm … --silent`, vitest `--reporter=dot`.

## Tech

Two stacks, kept separate at the boundary:

- **Rust** — `crates/` workspace (api, core, storage, auth, catalog, cache, bench).
- **TypeScript / React** — `frontend/` SPA (Vite + React + Tailwind + TanStack Query).

Before writing or editing code in either stack, confirm its conventions are in recent
context. The `.opencode/` harness carries stack-specific conventions; load the matching
files for the stack you are touching.

## Skill-driven execution

Non-trivial work is driven by skills rather than ad-hoc steps. Notably: new efforts run
through `/spec` → `/planning` → `/build` → `/test` → `/review` → `/ship`
(see [`docs/ROADMAP.md`](docs/ROADMAP.md) § How we plan). Match the skill to the task —
e.g. test-driven-development for behavior changes, debugging-and-error-recovery for
failures, code-review-and-quality before merge.

## Orchestration

One directory per effort, in place forever: each effort lives at
`docs/specs/<effort-slug>/` with `spec.md` + `plan.md` + `todo.md`. Status lives in the
spec.md frontmatter (`status: draft | active | shipped`) and the todo.md checkboxes —
not in a duplicate table elsewhere. Shipped efforts stay put; their spec.md frontmatter
flips to `status: shipped` (no archive step). All efforts shipped (M0–M9, Lossless
Reconnect, Sharing) live under [`docs/specs/`](docs/specs/); nothing is active — the
next effort starts with `/spec` (candidates in [`docs/ROADMAP.md`](docs/ROADMAP.md) §
Future directions).

## Boundaries

- **Data storage.** Before adding server-side storage, API endpoints, or recurring
  server requests, consult
  [`docs/data-storage-principles.md`](docs/data-storage-principles.md). Default to
  client-side storage (IndexedDB) for per-device data; justify every server-side write.
- **ADR immutability.** `docs/adrs/` (when present) is immutable; supersede a decision
  with a new ADR, never rewrite one.
- **`.opencode/` is out of scope** here — the harness is replaced separately. This file
  intentionally carries no harness-internal path references.
