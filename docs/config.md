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

## Basic mode

M0 ships without external service keys. Provider OAuth credentials (Google Drive, Dropbox, OneDrive) arrive in M1 — until then, no keys are required. When provider credentials are absent, the corresponding "Connect" buttons in the UI are disabled with a setup hint.

## Provider setup (M1)

To connect a cloud provider, you need to register an OAuth app with that provider and supply the client ID and secret via environment variables. The OAuth redirect URI is:

```
{CASTIFY_APP_BASE_URL}/api/connections/{provider}/callback
```

For example, if `CASTIFY_APP_BASE_URL=https://media.example.com`, the Google Drive redirect URI is:

```
https://media.example.com/api/connections/google_drive/callback
```

For local development (`CASTIFY_APP_BASE_URL=http://localhost:8427`):

```
http://localhost:8427/api/connections/google_drive/callback
```

### Google Drive

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials.
2. Create an OAuth 2.0 Client ID (Web application).
3. Add the redirect URI above to "Authorized redirect URIs".
4. Enable the Google Drive API.
5. Set `CASTIFY_GOOGLE_CLIENT_ID` and `CASTIFY_GOOGLE_CLIENT_SECRET`.

### Dropbox

1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps).
2. Create an app with Dropbox API access.
3. Add the redirect URI above to "Redirect URIs".
4. Set `CASTIFY_DROPBOX_CLIENT_ID` and `CASTIFY_DROPBOX_CLIENT_SECRET`.

### OneDrive

1. Go to [Azure portal](https://portal.azure.com/) → App registrations → New registration.
2. Add the redirect URI above as a Web redirect URI.
3. Add Microsoft Graph permissions: `Files.Read.All`, `offline_access`.
4. Set `CASTIFY_MS_CLIENT_ID` and `CASTIFY_MS_CLIENT_SECRET`.

## Development with `npm run dev`

When using Vite's dev server (`npm run dev`, port 5173) instead of the embedded production bundle, the API proxy runs from `:5173` to the Rust backend on `:8427`.

```sh
# Terminal 1: backend on :8427
cargo run -p castify-api

# Terminal 2: Vite dev server on :5173
cd frontend && npm run dev
```

The production single-port serve (`cargo run` alone, serving the embedded SPA on `:8427`) needs no separate frontend process.
