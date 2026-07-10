# Configuration

Castify is configured through environment variables. Defaults are chosen so the app boots in basic mode (no external service keys) on a single command.

## Variables

| Variable              | Default            | Description                                                                              |
| --------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `CASTIFY_HOST`        | `0.0.0.0`          | Network interface to bind to.                                                            |
| `CASTIFY_PORT`        | `8427`             | TCP port to listen on.                                                                   |
| `CASTIFY_LOG`         | `info`             | Tracing filter directive (e.g. `info`, `debug`, `castify=trace`). Falls back to `RUST_LOG`. |
| `CASTIFY_DATA_DIR`    | `./data`           | Directory holding the SQLite database and any other local state. Must exist or be creatable. |
| `CASTIFY_DB_PATH`     | `<DATA_DIR>/castify.db` | Override the SQLite database file location.                                       |
| `CASTIFY_SESSION_SECRET` | _(auto-generated)_ | Base64- or raw-byte HMAC secret for signing session cookies. Auto-generated and persisted to the database on first boot; override to share sessions across instances. |

## Errors

Misconfiguration aborts startup with an actionable error that names the offending key and links back to this file. Example:

```
error: failed to load configuration

Caused by:
    CASTIFY_PORT must be a valid port number (1..=65535); got "abc". See docs/config.md for the full reference.
```

## Basic mode

M0 ships without external service keys. Provider OAuth credentials (Google Drive, Dropbox, OneDrive) arrive in M1 — until then, no keys are required.

## Development with `npm run dev`

When using Vite's dev server (`npm run dev`, port 5173) instead of the embedded production bundle, the API proxy runs from `:5173` to the Rust backend on `:8427`.

```sh
# Terminal 1: backend on :8427
cargo run -p castify-api

# Terminal 2: Vite dev server on :5173
cd frontend && npm run dev
```

The production single-port serve (`cargo run` alone, serving the embedded SPA on `:8427`) needs no separate frontend process.
