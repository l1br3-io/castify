# PRD: M0 — Foundation

> **Status:** Approved baseline — first milestone of the Media Hub Core.
> **Companion:** [`VISION.md`](../VISION.md), [`ROADMAP.md`](../ROADMAP.md), [`tasks/plan.md`](../../tasks/plan.md).

## Purpose

M0 lays the spine of Castify: a single-binary application that installs, runs, persists data, validates its setup, and signs the owner in securely — with no external service keys required. Everything in later milestones builds on this foundation.

## In scope

- Single Rust binary serves the React SPA and the HTTP API on one port.
- Durable storage in SQLite (WAL); data survives process restarts.
- Configuration loaded from environment + optional file, validated at startup with clear errors.
- First-run setup wizard: owner creates credentials via **password** (Argon2id).
- Login, logout, durable sessions.
- Protected API endpoints reject unauthenticated requests; CSRF protection on mutations.
- Structured JSON logging with per-request tracing spans.
- Single Docker image runs the whole thing.

## Out of scope (deferred)

- Cloud provider connections (M1).
- Catalog scanning, dedupe, browse UI (M1–M2).
- Video playback (M3).
- OAuth provider login (linked in M1; M0 owner identity is local).
- Email, telemetry, password reset flows.

## Architecture decisions (locked)

| Area             | Choice                                                                |
| ---------------- | --------------------------------------------------------------------- |
| Packaging        | Single Rust binary, embedded React SPA (`rust-embed`), one port        |
| Backend          | `axum` + `tokio` + `tower` + `tracing`                                      |
| Frontend         | Vite + React + TypeScript + React Router + TanStack Query + Tailwind  |
| API              | REST + JSON                                                            |
| Database         | SQLite (WAL) via `sqlx`                                                  |
| Owner auth       | First-run wizard: password (`argon2`)                                    |
| Sessions         | Signed HttpOnly cookies, SameSite=Lax, server-side session rows in SQLite |
| CSRF             | Double-submit token cookie + header                                    |
| Background work  | In-process `tokio` tasks (none needed in M0)                            |
| License          | AGPL-3.0                                                               |
| Telemetry        | Off by default                                                         |

## Functional requirements

### FR-1: Boot and serve
- **FR-1.1** `cargo run` (and the published Docker image) starts the app on a configurable port.
- **FR-1.2** One port serves both `/api/*` JSON endpoints and the React SPA.
- **FR-1.3** `/api/health` returns `{ "status": "ok", "version": <semver>, "uptime_seconds": <u64> }`.
- **FR-1.4** Client-side SPA routes deep-link correctly (catch-all serves `index.html`).

### FR-2: Configuration
- **FR-2.1** Configuration is read from environment variables (and optional TOML file), with documented defaults.
- **FR-2.2** Missing required config aborts startup with a human-readable error naming the key and a hint.
- **FR-2.3** App boots in "basic mode" with zero external service keys.

### FR-3: Persistence
- **FR-3.1** SQLite database file path is configurable; default `./data/castify.db`.
- **FR-3.2** WAL journal mode enabled.
- **FR-3.3** Migrations run on startup and are idempotent.
- **FR-3.4** Data written before restart is readable after restart.

### FR-4: Owner setup (first-run)
- **FR-4.1** On first boot (no owner record exists), the API exposes `POST /api/setup`.
- **FR-4.2** `POST /api/setup` sets an Argon2id password; creates the owner row; issues a session cookie.
- **FR-4.3** After an owner exists, `POST /api/setup` returns `409 Conflict`.

### FR-5: Login and session
- **FR-5.1** `POST /api/session` authenticates the owner (password verify) and issues a signed HttpOnly cookie.
- **FR-5.2** `DELETE /api/session` invalidates the server-side session row and clears the cookie.
- **FR-5.3** Sessions persist across server restart.
- **FR-5.4** `GET /api/session` returns the current owner or `401`.

### FR-6: Protected resources
- **FR-6.1** All `/api/*` routes require a valid session except the allowlist: `/api/health`, `POST /api/setup`, `POST /api/session`.
- **FR-6.2** Mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) must include a CSRF token header matching the CSRF cookie.
- **FR-6.3** Unauthenticated requests to protected routes return `401`.

### FR-7: Observability
- **FR-7.1** Logs are JSON, written to stdout.
- **FR-7.2** Each HTTP request emits a span with method, path, status, and latency.
- **FR-7.3** Log level is configurable via `CASTIFY_LOG`.

## Non-functional requirements

| Category    | Requirement                                                                              |
| ----------- | ---------------------------------------------------------------------------------------- |
| Performance | Cold start < 2s; `/api/health` p99 < 50ms                                                 |
| Security    | Passwords hashed with Argon2id; cookies `Secure` in prod, `HttpOnly`, `SameSite=Lax`      |
| Reliability | Graceful shutdown on SIGTERM drains in-flight requests within 10s                          |
| Portability | Single static binary (musl) for Linux x86_64 + arm64; Docker image based on distroless     |
| Operability | Logs parseable by `jq`; config documented in `docs/config.md`                              |

## Acceptance criteria (milestone-level)

- [ ] Single `cargo run` (or single Docker image) starts the app
- [ ] One port serves both API and SPA
- [ ] `/api/health` returns 200 with version + uptime
- [ ] First boot with no config → setup wizard appears
- [ ] Owner can create credentials via password
- [ ] Subsequent boots skip wizard, show login
- [ ] Login persists across server restart (session durable in SQLite)
- [ ] Protected endpoints reject unauthenticated requests
- [ ] Bad config → app refuses to boot with a clear human-readable error
- [ ] App boots and is usable with **zero** external service keys
- [ ] Structured logs, request tracing span per request
- [ ] One Docker command runs the whole thing

## Dependencies

None external. M0 is the base everything else builds on.

## Risks

| Risk                                                  | Impact | Mitigation                                                                                |
| ----------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `rust-embed` cross-compile issues in Docker           | Med    | Multi-stage Dockerfile builds frontend in Node stage, copies assets into Rust build stage.  |
| SQLite migration runner race on first boot            | Low    | Single-writer pool; M0 is single-user.                                                    |
| SPA deep-linking under embedded serve                 | Low    | Catch-all route returns `index.html` for non-API paths.                                   |
| CSRF false positives breaking setup                   | Low    | Allowlist setup endpoints; document the token flow.                                       |

## Open questions resolved

- License: **AGPL-3.0**
- Default credential: **password** (Argon2id)
- UI state: **React Context** (Zustand deferred until proven necessary)
- Tests: **Rust unit + integration, Vitest, Playwright**
- CLI surface: **wizard only** for M0 (headless CLI considered post-M0)
- Telemetry: **off by default**
