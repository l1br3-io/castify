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
| `CASTIFY_APP_BASE_URL` | _(none)_ | The app's external URL (e.g. `https://media.example.com`). Used to construct OAuth redirect URIs for provider connections. Required only when connecting a cloud provider. |
| `CASTIFY_COOKIE_SECURE` | _(auto)_ | Whether session and CSRF cookies carry the `Secure` flag. When unset, auto-detected from `CASTIFY_APP_BASE_URL` (`https://` → `true`, otherwise `false`). Set explicitly (`true`/`false`) to override. |
| `CASTIFY_TOKEN_KEY` | _(auto-generated)_ | Base64- or raw-byte AES-256 key for encrypting OAuth tokens at rest. Auto-generated and persisted to the database on first boot; override to share across instances. |
| `CASTIFY_GOOGLE_CLIENT_ID` | _(none)_ | Google Drive OAuth client ID. Obtain from Google Cloud Console. |
| `CASTIFY_GOOGLE_CLIENT_SECRET` | _(none)_ | Google Drive OAuth client secret. |
| `CASTIFY_DROPBOX_CLIENT_ID` | _(none)_ | Dropbox OAuth app key. Obtain from Dropbox App Console. |
| `CASTIFY_DROPBOX_CLIENT_SECRET` | _(none)_ | Dropbox OAuth app secret. |
| `CASTIFY_MS_CLIENT_ID` | _(none)_ | Microsoft (OneDrive) Azure AD app client ID. Obtain from Azure portal. |
| `CASTIFY_MS_CLIENT_SECRET` | _(none)_ | Microsoft (OneDrive) Azure AD app client secret. |

## Errors

Misconfiguration aborts startup with an actionable error that names the offending key and links back to this file. Example:

```
error: failed to load configuration

Caused by:
    CASTIFY_PORT must be a valid port number (1..=65535); got "abc". See docs/config.md for the full reference.
```

## Local development (`.env`)

For local work, put values in a root-level `.env` (copy from [`.env.example`](../.env.example)). It is the single source of truth shared by every run path:

- **`just`** recipes load it automatically (`set dotenv-load := true` in the justfile), so `cargo run` / `npm run dev` inherit it with no manual `source`.
- **`docker compose`** injects it into the container via `env_file:` in `docker-compose.yml`.

Both `just dev` (local, hot reload) and `just up` (Docker, prod-like) therefore read the same keys. `.env` is gitignored; production sets real env vars in the deployment platform.

## Basic mode

M0 ships without external service keys. Provider OAuth credentials (Google Drive, Dropbox, OneDrive) arrive in M1 — until then, no keys are required. When a provider's credentials are absent it is hidden on the Connections page; if none are configured, an empty state points to [`docs/providers.md`](./providers.md) for setup.

## Provider setup

To connect a cloud provider you register an OAuth app with the provider and set the client ID/secret as environment variables (see the table above). The full step-by-step walkthrough for Google Drive, Dropbox, and OneDrive — the redirect-URI format, the consent-screen setup, and troubleshooting — lives in [`docs/providers.md`](./providers.md).

## Development with `npm run dev`

When using Vite's dev server (`npm run dev`, port 5173) instead of the embedded production bundle, the API proxy runs from `:5173` to the Rust backend on `:8427`.

```sh
# Terminal 1: backend on :8427
cargo run -p castify-api

# Terminal 2: Vite dev server on :5173
cd frontend && npm run dev
```

The production single-port serve (`cargo run` alone, serving the embedded SPA on `:8427`) needs no separate frontend process.
