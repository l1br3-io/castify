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
Stop the container, delete the volume, and start fresh:
```sh
docker compose down -v
docker compose up -d
```
