# Deployment

Castify ships as a single Docker image — a static Rust binary serving both the API and the embedded React SPA on one port. No external databases or service keys are required.

## Quick start (Docker Compose)

```sh
docker compose up -d
```

That's it. The app builds from source (if not cached), starts on port **8427**, and persists data to a named Docker volume.

Verify it's running:

```sh
curl localhost:8427/api/health
# {"status":"ok","version":"0.1.0","uptime_seconds":2,"db":"ok"}
```

Open `http://localhost:8427` in your browser. On first boot you'll see the setup wizard — enter a display name and password to create the owner account.

## Common operations

```sh
docker compose up -d          # start in background
docker compose up -d --build  # rebuild after code changes
docker compose logs -f        # follow logs (JSON to stdout)
docker compose down           # stop (data survives in volume)
docker compose down -v        # stop AND delete all data
docker compose restart        # restart (data survives)
```

## Plain Docker (no compose)

```sh
docker build -t castify .

docker run -d \
  --name castify \
  -p 8427:8427 \
  -v castify-data:/data \
  --restart unless-stopped \
  castify
```

## Reverse proxy & HTTPS

Castify serves plain HTTP and never reads `X-Forwarded-*` headers — everything it knows about its external URL comes from `CASTIFY_APP_BASE_URL`. To expose it beyond your LAN, put a TLS-terminating proxy in front and do two things:

1. **Set the external URL:**

   ```yaml
   environment:
     CASTIFY_APP_BASE_URL: https://media.example.com
   ```

   OAuth redirect URIs are built from it, and session/CSRF cookies get the `Secure` flag automatically when the URL is `https://` (see [`docs/config.md`](./config.md)).

2. **Stop publishing the backend port publicly** — bind it to loopback so the only way in is through the proxy:

   ```yaml
   ports:
     - "127.0.0.1:8427:8427"
   ```

Each provider console must register the exact redirect URI `{CASTIFY_APP_BASE_URL}/api/connections/{provider}/callback` — see [`docs/providers.md`](./providers.md) for per-provider walkthroughs.

### Caddy (recommended — automatic TLS)

```caddyfile
media.example.com {
    reverse_proxy 127.0.0.1:8427
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name media.example.com;

    ssl_certificate     /etc/letsencrypt/live/media.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/media.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8427;
        proxy_http_version 1.1;

        # Video streams and HLS segments are long-lived responses; disable
        # buffering so playback starts immediately, and allow long reads.
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

No WebSocket upgrade is needed — all streaming is plain HTTP.

## Configuration

All configuration is via environment variables. See [`docs/config.md`](./config.md) for the full reference.

### Local dev `.env` (shared with `just`)

For local/dev stacks, put provider credentials and overrides in a root-level `.env` (copy from [`.env.example`](../.env.example)). It is read by **both** the `just` recipes (via `dotenv-load`) and `docker compose` (via `env_file:` in `docker-compose.yml`), so `just dev` and `just up` see the same keys. The file is gitignored; production should set real env vars in the deployment platform instead.

| Variable                 | Default                  | Notes                                          |
| ------------------------ | ------------------------ | ---------------------------------------------- |
| `CASTIFY_HOST`           | `0.0.0.0`                | Bind interface                                |
| `CASTIFY_PORT`           | `8427`                   | Listen port                                    |
| `CASTIFY_LOG`            | `info`                   | Log level (`debug`, `info`, `warn`, `error`)  |
| `CASTIFY_DATA_DIR`       | `/data` (in image)       | SQLite database + local state                  |
| `CASTIFY_DB_PATH`        | `<DATA_DIR>/castify.db`  | Override database file location                |
| `CASTIFY_SESSION_SECRET` | _(auto-generated)_       | HMAC secret for session cookies. Auto-generated on first boot and persisted to the database. Override only if running multiple instances. |

Override via `environment` in `docker-compose.yml`:

```yaml
services:
  castify:
    environment:
      CASTIFY_PORT: "8080"
      CASTIFY_LOG: "debug"
```

## Transcoding & ffmpeg

Codec probing (`ffprobe`) and server-side transcoding (`ffmpeg`) shell out to system binaries found on `PATH`. The stock image is distroless and ships **neither binary** — deliberately, to keep it small and minimize attack surface. In practice that means:

- Browser-compatible videos (H.264/AAC MP4, most WebM) play fine — direct streaming, no ffmpeg involved.
- Codec-incompatible videos (HEVC, WMV, MPEG-2 …) hit the "download instead" wall instead of being transcoded on the fly.
- Probing logs `ffprobe binary not found; install ffmpeg to enable codec probing` and leaves codec info empty. Nothing crashes; the features just degrade.

`CASTIFY_TRANSCODE_ENABLED` defaults to `true`, but on the stock image there is no ffmpeg for it to act through.

### Docker: build the ffmpeg-capable image

The Dockerfile carries an alpine + ffmpeg runtime stage. Its internal name is `e2e-runtime` (it was added for the test suite), but with the `E2E` build arg unset — the default — it contains the **production binary**, just on alpine with ffmpeg. Build it via a compose override, e.g. `docker-compose.ffmpeg.yml`:

```yaml
services:
  castify:
    build:
      context: .
      target: e2e-runtime
```

```sh
docker compose -f docker-compose.yml -f docker-compose.ffmpeg.yml up -d --build
```

Trade-off: a larger image and a bigger attack surface than distroless. For a personal media server that wants transcodes and subtitle burn-in, it's usually worth it.

### Without Docker

The release binary is fully static (musl) and runs on any Linux. Install ffmpeg on the host and run it directly:

```sh
cargo build --release -p castify-api
CASTIFY_DATA_DIR=/var/lib/castify ./target/release/castify
```

## First-run setup flow

1. Navigate to `http://localhost:8427`
2. The setup wizard appears (no owner exists yet)
3. Enter a display name and password (min 8 chars)
4. You're signed in and redirected to the home page

Subsequent boots skip the wizard and show the login page directly.

## Data persistence

All state (SQLite database, session secret, WAL files) lives in the `CASTIFY_DATA_DIR` directory, which maps to the `castify-data` Docker volume by default.

**Backup:**
```sh
docker run --rm -v castify_castify-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/castify-backup.tar.gz -C /data .
```

**Restore:**
```sh
docker volume create castify_castify-data
docker run --rm -v castify_castify-data:/data -v $(pwd):/backup alpine \
  tar xzf /backup/castify-backup.tar.gz -C /data
```

## Upgrading

No image is published to a registry today — Compose builds from your local checkout. Upgrading is therefore: back up, pull, rebuild.

```sh
# 1. Back up (see "Data persistence" above)

# 2. Pull and rebuild — same volume, new image
git pull
docker compose up -d --build   # or: just rebuild
```

What happens on boot after an upgrade:

- The named volume (`castify-data`) is untouched by the rebuild — your database, sessions, and caches survive.
- SQLite schema migrations run automatically at startup.
- Migrations are **forward-only**: there is no downgrade path. If a new version goes wrong, roll back the *code* (`git checkout <previous-tag>` + rebuild) and, only if the new version already migrated your database, restore the volume from the backup taken in step 1.

Expect brief downtime while the container is recreated. The health check (`curl localhost:8427/api/health`) confirms the new version is serving.

## Image details

- **Base:** `gcr.io/distroless/static-debian12:nonroot`
- **Size:** ~16 MB
- **User:** `nonroot` (uid 65532)
- **Binary:** Fully static (musl), zero shared library dependencies
- **Architecture:** Currently builds for the host architecture (amd64). Multi-arch (amd64 + arm64) via `docker buildx` is planned.

## Troubleshooting

**Port already in use:**
Change `CASTIFY_PORT` or update the host-side port mapping: `-p 9090:8427`.

**Permission denied writing to /data:**
The container runs as uid 65532. If mounting a host directory instead of a named volume, ensure it's writable:
```sh
mkdir -p ./data && chown 65532:65532 ./data
```
Then mount it: `-v $(pwd)/data:/data`.

**Forgot password:**
Don't delete the volume — that destroys your whole library. Use the built-in recovery subcommand (non-interactive; revokes all sessions and prints a one-time temp password):

```sh
docker compose exec castify /castify reset-password
# (absolute path: the distroless image has no shell / PATH resolution)
```

Sign in with the printed temp password, then immediately set a new one from the in-app settings page.
