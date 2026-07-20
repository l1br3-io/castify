# AGENTS.md

## Tech conventions

Each name in `rules/tech.md` maps directly to `tech/<name>/` (e.g. `rust` →
`tech/rust/`). Skills use this declaration to load language-specific
conventions.

Before writing or editing code, confirm the relevant tech is in recent
context. If unsure, re-read the appropriate `tech/<name>/` files.

## Data storage

Before adding server-side storage, API endpoints, or recurring server
requests, consult
[`docs/data-storage-principles.md`](docs/data-storage-principles.md).
Default to client-side storage (IndexedDB) for per-device data; justify
every server-side write.
