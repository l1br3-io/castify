# Castify task runner. See https://github.com/casey/just
#
# Quiet-on-success contract: recipes emit output ONLY for errors/failures —
# token economy for AI agents (AGENTS.md routes agents through these recipes).
# Enforced by `just quiet-audit`. Genuinely interactive recipes (dev, api/web,
# deploy, upload*, logs, ps) are exempt; their lines carry a
# `# quiet-audit: allow` marker.

# Load `.env` (root-level) into every recipe's environment, so `cargo run`,
# `npm run dev`, etc. inherit provider creds without manual `source`. The same
# file is read by `docker-compose.yml` via `env_file:` — single source of truth.
# See `.env.example` for the full list of keys.
set dotenv-load := true

# Plain `docker compose` (default stack). E2E recipes use COMPOSE_E2E.
COMPOSE := "docker compose"
# `--progress quiet`: suppress the build stream on success (errors still print).
COMPOSE_E2E := "docker compose --progress quiet -f docker-compose.yml -f docker-compose.e2e.yml"
# Strip libtest per-binary boilerplate ("running N tests" / blanks / ok lines).
# sed (unlike grep -v) always exits 0, so pipefail still yields cargo's status;
# FAILED results, panics and failures lists pass through untouched.
QUIET_TEST := "sed -E '/^running [0-9]+ tests$/d; /^$/d; /^test result: ok[.]/d'"

# Default: list available recipes.
default:
    @just --list

# Guardrail for the quiet-on-success contract above: fail if an agent-facing
# command appears without its quiet flag. Exempt a line by appending
# `# quiet-audit: allow`. Extend the pattern list when adopting new tooling.
quiet-audit:
    #!/usr/bin/env bash
    set -euo pipefail
    fail=0
    audit() { # <regex over justfile lines> <required token>
        local hit n line
        while IFS= read -r hit; do
            n="${hit%%:*}"; line="${hit#*:}"
            if [[ "$line" == *"quiet-audit: allow"* ]]; then continue; fi
            if [[ "$line" != *"$2"* ]]; then
                echo "quiet-audit: justfile:$n missing '$2': ${line##\# }" >&2
                fail=1
            fi
        done < <(grep -nE "$1" justfile | grep -vE '^[0-9]+:[[:space:]]*#' | grep -v "audit '" || true)
    }
    audit 'cargo (test|clippy|run|build)'  '--quiet'
    audit 'npm ci'                         '--silent'
    audit 'npm run'                        '--silent'
    audit 'npx playwright install'         '/dev/null'
    audit 'npx playwright test'            '--reporter=dot'
    audit 'COMPOSE_E2E :='                 '--progress quiet'
    audit 'up --build'                     'COMPOSE_E2E'
    if [ "$fail" = 1 ]; then
        echo "quiet-audit: FAILED — add the quiet flag, or '# quiet-audit: allow' if genuinely interactive" >&2
        exit 1
    fi
    echo "quiet-audit: OK"

# Auto-fix what CI checks: formatting, clippy, and frontend lint.
fix:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "== backend: fmt ==";   cargo fmt --all
    echo "== backend: clippy =="; cargo clippy --fix --allow-dirty --all-targets --all-features --quiet
    echo "== frontend: lint =="; ( cd frontend && npm run lint --silent -- --fix )

# Run the same checks CI runs, locally. Fails fast on the first failing step.
ci:
    #!/usr/bin/env bash
    set -euo pipefail
    # cargo's --quiet hides build progress AND collapses passing tests to dots
    # (it forwards the flag to libtest — don't pass `-- --quiet` too). Failures
    # still print in full.
    echo "== backend: fmt ==";   cargo fmt --all -- --check
    echo "== backend: clippy =="; cargo clippy --all-targets --all-features --quiet -- -D warnings
    echo "== backend: test ==";  cargo test --all --quiet 2>&1 | {{QUIET_TEST}}
    echo "== backend: test (e2e feature) =="; cargo test -p castify-api --features e2e --quiet -- --test-threads=1 2>&1 | {{QUIET_TEST}}
    echo "== frontend: install =="; ( cd frontend && npm ci --silent --no-fund --no-audit )
    echo "== frontend: typecheck =="; ( cd frontend && npm run typecheck --silent )
    echo "== frontend: lint =="; ( cd frontend && npm run lint --silent )
    echo "== frontend: test =="; ( cd frontend && npm run test --silent -- --reporter=dot )
    echo "== frontend: build =="; ( cd frontend && npm run build --silent -- --logLevel error )

# Run all tests reliably in one go, single-threaded backend (per deviation #18)
# plus frontend type/lint/test. Use as a pre-manual-testing baseline.
preflight:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "== backend: test (single-threaded) =="; cargo test -p castify-api --quiet -- --test-threads=1 2>&1 | {{QUIET_TEST}}
    echo "== backend: test (e2e feature, single-threaded) =="; cargo test -p castify-api --features e2e --quiet -- --test-threads=1 2>&1 | {{QUIET_TEST}}
    echo "== frontend: typecheck =="; ( cd frontend && npm run typecheck --silent )
    echo "== frontend: lint =="; ( cd frontend && npm run lint --silent )
    echo "== frontend: test =="; ( cd frontend && npm run test --silent -- --reporter=dot )

# Run all tests: backend (Rust) and frontend (Vitest).
test:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "== backend: test ==";  cargo test --all --quiet 2>&1 | {{QUIET_TEST}}
    echo "== frontend: test =="; ( cd frontend && npm run test --silent -- --reporter=dot )

# Run the Rust API in the foreground (backend on 127.0.0.1:8427 by default).
api:
    cargo run -p castify-api # quiet-audit: allow (interactive dev server)

# Like `api`, named for the split-terminal Vite dev workflow (pair with `dev-web`).
dev-api:
    cargo run -p castify-api # quiet-audit: allow (interactive dev server)

# Run the Vite dev server in the foreground (frontend on http://localhost:5173,
# proxies /api to the backend declared by CASTIFY_BACKEND_URL, default 127.0.0.1:8427).
web:
    cd frontend && npm run dev # quiet-audit: allow (interactive dev server)

# Paired with `dev-api`: same as `web`, named for the split-terminal dev flow.
dev-web:
    cd frontend && npm run dev # quiet-audit: allow (interactive dev server)

# E2e smoke test: cold-boot the Docker stack, run Playwright, tear down.
# Pass CASTIFY_E2E_REUSE=1 to keep the stack running after tests (for debugging).
e2e:
    #!/usr/bin/env bash
    set -euo pipefail

    cleanup() {
        if [ -n "${CASTIFY_E2E_REUSE:-}" ]; then
            echo "== teardown skipped (CASTIFY_E2E_REUSE=1) =="
        else
            echo "== docker: teardown =="
            {{COMPOSE_E2E}} down -v --remove-orphans 2>/dev/null || true
        fi
    }
    trap cleanup EXIT

    echo "== e2e: install deps =="
    ( cd e2e && npm ci --silent --no-fund --no-audit )
    echo "== e2e: install chromium =="
    # --with-deps installs system libraries (libnss3, etc.) via sudo.
    # Fall back to browser-only if sudo is unavailable. stdout is redirected:
    # download progress is pure token cost; errors land on stderr.
    if ! ( cd e2e && npx playwright install --with-deps chromium >/dev/null ); then
        echo "note: --with-deps failed (no sudo?); installing browser only" >&2
        ( cd e2e && npx playwright install chromium >/dev/null )
    fi

    echo "== docker: cold boot (fresh volume, e2e build) =="
    {{COMPOSE_E2E}} down -v --remove-orphans 2>/dev/null || true
    {{COMPOSE_E2E}} up --build -d

    echo "== waiting for health on :8427 =="
    ready=0
    for _ in $(seq 1 120); do
        if curl -sf http://localhost:8427/api/health >/dev/null 2>&1; then
            ready=1; break
        fi
        sleep 1
    done
    if [ "$ready" = 0 ]; then
        echo "error: stack did not become healthy within 120s" >&2
        {{COMPOSE_E2E}} logs --tail=50
        exit 1
    fi
    echo "stack healthy"

    echo "== playwright: running e2e tests =="
    ( cd e2e && npx playwright test --reporter=dot )

# Run ONE e2e test (or a filtered subset) instead of the whole suite —
# the fast inner loop when debugging a failing spec. Same lifecycle as
# `e2e` (cold boot → health gate → run → teardown, CASTIFY_E2E_REUSE=1
# keeps the stack). The filter is Playwright's positional argument: a
# file path (`tests/browse.spec.ts`), file:line (`tests/play.spec.ts:164`),
# or a path regex (`library-folders`).
e2e-one filter:
    #!/usr/bin/env bash
    set -euo pipefail

    cleanup() {
        if [ -n "${CASTIFY_E2E_REUSE:-}" ]; then
            echo "== teardown skipped (CASTIFY_E2E_REUSE=1) =="
        else
            echo "== docker: teardown =="
            {{COMPOSE_E2E}} down -v --remove-orphans 2>/dev/null || true
        fi
    }
    trap cleanup EXIT

    echo "== e2e: install deps =="
    ( cd e2e && npm ci --silent --no-fund --no-audit )
    echo "== e2e: install chromium =="
    if ! ( cd e2e && npx playwright install --with-deps chromium >/dev/null ); then
        echo "note: --with-deps failed (no sudo?); installing browser only" >&2
        ( cd e2e && npx playwright install chromium >/dev/null )
    fi

    echo "== docker: cold boot (fresh volume, e2e build) =="
    {{COMPOSE_E2E}} down -v --remove-orphans 2>/dev/null || true
    {{COMPOSE_E2E}} up --build -d

    echo "== waiting for health on :8427 =="
    ready=0
    for _ in $(seq 1 120); do
        if curl -sf http://localhost:8427/api/health >/dev/null 2>&1; then
            ready=1; break
        fi
        sleep 1
    done
    if [ "$ready" = 0 ]; then
        echo "error: stack did not become healthy within 120s" >&2
        {{COMPOSE_E2E}} logs --tail=50
        exit 1
    fi
    echo "stack healthy"

    echo "== playwright: running e2e filter: {{filter}} =="
    ( cd e2e && npx playwright test --reporter=dot {{filter}} )

# --- Performance benchmark (T13) ---

# Full performance benchmark: build release, boot API, seed 10K videos,
# run HTTP latency checks, tear down. Override the data dir or URL via
# CASTIFY_BENCH_DIR / CASTIFY_BENCH_URL. Pass CASTIFY_BENCH_DEV=1 to use
# debug builds (faster compile, pessimistic numbers).
bench:
    #!/usr/bin/env bash
    set -euo pipefail

    BENCH_DIR="${CASTIFY_BENCH_DIR:-/tmp/castify-bench}"
    BASE_URL="${CASTIFY_BENCH_URL:-http://localhost:8427}"

    if [ -n "${CASTIFY_BENCH_DEV:-}" ]; then
        PROFILE_DIR="debug"
        BUILD_ARGS=""
    else
        PROFILE_DIR="release"
        BUILD_ARGS="--release"
    fi

    echo "== bench: building ($PROFILE_DIR) =="
    cargo build -p castify-api $BUILD_ARGS --quiet
    cargo build -p castify-bench $BUILD_ARGS --quiet

    echo "== bench: fresh data dir ($BENCH_DIR) =="
    rm -rf "$BENCH_DIR" && mkdir -p "$BENCH_DIR"

    echo "== bench: starting API =="
    CASTIFY_DATA_DIR="$BENCH_DIR" CASTIFY_LOG=warn \
        ./target/$PROFILE_DIR/castify &
    API_PID=$!

    cleanup() {
        echo "== bench: stopping API =="
        kill "$API_PID" 2>/dev/null || true
        wait "$API_PID" 2>/dev/null || true
    }
    trap cleanup EXIT

    echo "== bench: waiting for health =="
    ready=0
    for _ in $(seq 1 120); do
        if curl -sf "$BASE_URL/api/health" >/dev/null 2>&1; then
            ready=1; break
        fi
        sleep 0.5
    done
    [ "$ready" = 1 ] || { echo "error: API not healthy within 60s" >&2; exit 1; }
    echo "  healthy"

    echo "== bench: setup (create owner) =="
    curl -sf -c "$BENCH_DIR/cookies.txt" \
        -X POST "$BASE_URL/api/setup" \
        -H "Content-Type: application/json" \
        -d '{"display_name":"Bench","password":"benchpass123"}' >/dev/null
    SESSION=$(awk '$6=="castify_session"{print $7}' "$BENCH_DIR/cookies.txt")
    [ -n "$SESSION" ] || { echo "error: no session cookie" >&2; exit 1; }

    echo "== bench: seeding 10K catalog =="
    CASTIFY_DATA_DIR="$BENCH_DIR" ./target/$PROFILE_DIR/bench-seed

    echo
    echo "== bench: HTTP latency benchmark =="
    ./target/$PROFILE_DIR/bench-run --base-url "$BASE_URL" --session "$SESSION"

# Seed 10K benchmark videos into CASTIFY_DATA_DIR (assumes API is already
# running and POST /api/setup has been called).
bench-seed:
    cargo run -p castify-bench --bin bench-seed --quiet

# Run HTTP latency benchmark against a running API. Requires BENCH_SESSION
# (the castify_session cookie value).
bench-run:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo run -p castify-bench --bin bench-run --quiet -- \
        --session "${BENCH_SESSION:?BENCH_SESSION is required (castify_session cookie)}" \
        --base-url "${CASTIFY_BENCH_URL:-http://localhost:8427}"

# --- Docker stack (prod-like; reads the same .env as the recipes above) ---

# Start the Docker stack in the background.
up:
    {{COMPOSE}} up -d

# Stop the Docker stack (data survives in the named volume).
down:
    {{COMPOSE}} down

# Rebuild images and restart the stack (use after code changes).
rebuild:
    {{COMPOSE}} up -d --build

# Tail Docker stack logs (Ctrl-C to detach).
logs:
    {{COMPOSE}} logs -f

# Show Docker stack container status.
ps:
    {{COMPOSE}} ps

# --- Remote deploy (ship image over SSH; docs/deploy-do-r2.md § 9) ---

# Build locally, ship the image to the droplet, restart the container.
#   just deploy root@[public ipv4 droplet ip] [domain]
# Example:
#   just deploy root@203.0.113.10 media.mydomain.com
# Or set CASTIFY_DEPLOY_HOST / CASTIFY_DEPLOY_DOMAIN in .env and run bare `just deploy`.
deploy host="" domain="":
    #!/usr/bin/env bash
    set -euo pipefail
    HOST="{{host}}"
    DOMAIN="{{domain}}"
    [ -n "$HOST" ] || HOST="${CASTIFY_DEPLOY_HOST:-}"
    [ -n "$DOMAIN" ] || DOMAIN="${CASTIFY_DEPLOY_DOMAIN:-https://castify.example.com}"
    if [ -z "$HOST" ]; then
        echo "error: no deploy target — run 'just deploy root@<ip> <domain>'" >&2
        echo "       or set CASTIFY_DEPLOY_HOST (and CASTIFY_DEPLOY_DOMAIN) in .env" >&2
        exit 1
    fi
    # Bare IP/hostname → assume root@. Plain ssh would fall back to the local
    # username ($USER) and fail with "Permission denied (publickey)" — DO
    # droplets ship with only the root user (docs/deploy-do-r2.md § 3).
    case "$HOST" in
        *@*) ;;
        *) HOST="root@$HOST" ;;
    esac
    echo "== deploy: ssh preflight =="
    if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null; then
        echo "error: cannot ssh to $HOST (publickey)" >&2
        echo "       check the user part — droplets usually only have 'root'." >&2
        exit 1
    fi
    echo "== deploy: build image (ffmpeg variant) =="
    docker build --target e2e-runtime -t castify:ffmpeg .
    echo "== deploy: ship image to $HOST =="
    docker save castify:ffmpeg | gzip | ssh "$HOST" 'gunzip | docker load'
    echo "== deploy: restart container =="
    ssh "$HOST" "docker rm -f castify && docker run -d --name castify \
        --restart unless-stopped \
        -p 127.0.0.1:8427:8427 \
        -v castify-data:/data \
        -e CASTIFY_APP_BASE_URL=$DOMAIN \
        -e CASTIFY_TRANSCODE_CACHE_MAX_BYTES=5368709120 \
        castify:ffmpeg"
    echo "== deploy: waiting for health =="
    for _ in $(seq 1 60); do
        if ssh "$HOST" 'curl -sf http://127.0.0.1:8427/api/health' >/dev/null 2>&1; then
            echo "healthy — serving $DOMAIN"
            exit 0
        fi
        sleep 1
    done
    echo "error: container not healthy within 60s — check: ssh $HOST docker logs castify" >&2
    exit 1

# Dev mode: backend + frontend concurrently, with hot-reload on the frontend.
# Ctrl-C kills both. Requires `cargo-watch` for backend auto-reload; falls back
# to plain `cargo run` if it's not installed.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    if cargo watch --version >/dev/null 2>&1; then
        # `-i frontend`: the Rust backend has no reason to watch TS sources, and
        # ignoring them prevents the editor's TS language server (which rewrites
        # frontend/tsconfig.tsbuildinfo every second) from triggering an endless
        # backend restart loop.
        ( cargo watch -i frontend -x "run -p castify-api" ) &
    else
        echo "note: cargo-watch not installed; backend won't auto-reload. 'cargo install cargo-watch' to enable." >&2
        ( cargo run -p castify-api ) & # quiet-audit: allow (interactive dev server)
    fi
    if ! command -v npm >/dev/null 2>&1; then
        echo "error: npm is required to run the frontend" >&2
        exit 1
    fi
    # Trap SIGINT/TERM and kill both children.
    trap 'kill 0' INT TERM
    # Don't expose the frontend until the backend is actually serving, so the
    # page is never reachable before /api answers (avoids ECONNREFUSED proxy
    # errors during a cold backend compile).
    if command -v curl >/dev/null 2>&1; then
        printf 'waiting for backend on :8427 …\n' >&2
        ready=0
        for _ in $(seq 1 120); do
            if curl -sf -o /dev/null http://127.0.0.1:8427/api/health; then
                ready=1; break
            fi
            sleep 0.5
        done
        if [ "$ready" = 1 ]; then
            printf 'backend ready\n' >&2
        else
            printf 'warn: backend not responding after 60s; starting frontend anyway\n' >&2
        fi
    else
        printf 'note: curl not found; skipping backend readiness gate\n' >&2
    fi
    ( cd frontend && npm run dev ) & # quiet-audit: allow (interactive dev server)
    wait

# --- R2 media upload (rclone; see docs/deploy-do-r2.md § Uploading media) ---

# One-time rclone setup: install rclone (user-local, no sudo) and write the
# `castify` remote from R2_* env vars (CLOUDFLARE_CASTIFY_* also accepted).
upload-setup:
    #!/usr/bin/env bash
    set -euo pipefail

    RCLONE="${HOME}/.local/bin/rclone"
    ACCESS="${R2_ACCESS_KEY_ID:-${CLOUDFLARE_CASTIFY_ACCESS_KEY:-}}"
    SECRET="${R2_SECRET_ACCESS_KEY:-${CLOUDFLARE_CASTIFY_SECRET_KEY:-}}"
    ENDPOINT="${R2_ENDPOINT:-${CLOUDFLARE_CASTIFY_S3_URL:-}}"
    BUCKET="${R2_BUCKET:-castify}"

    [ -n "$ACCESS" ] && [ -n "$SECRET" ] && [ -n "$ENDPOINT" ] || {
        echo "error: set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT (see .env.example)" >&2
        exit 1
    }

    if [ ! -x "$RCLONE" ]; then
        echo "== rclone: installing to ~/.local/bin =="
        TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
        curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o "$TMP/rclone.zip"
        unzip -oq "$TMP/rclone.zip" -d "$TMP"
        mkdir -p "${HOME}/.local/bin"
        cp "$TMP"/rclone-*-linux-amd64/rclone "$RCLONE"
    fi
    "$RCLONE" version | head -1

    echo "== rclone: writing remote 'castify' =="
    # no_check_bucket: R2 answers rclone's bucket probe oddly and it trips a
    # denied CreateBucket attempt on every upload otherwise.
    mkdir -p "${HOME}/.config/rclone"
    {
        printf '%s\n' \
            '[castify]' \
            'type = s3' \
            'provider = Cloudflare' \
            "access_key_id = ${ACCESS}" \
            "secret_access_key = ${SECRET}" \
            "endpoint = ${ENDPOINT}" \
            'acl = private' \
            'no_check_bucket = true'
    } > "${HOME}/.config/rclone/rclone.conf"
    chmod 600 "${HOME}/.config/rclone/rclone.conf"

    echo "== rclone: verifying read access to bucket '${BUCKET}' =="
    "$RCLONE" lsd "castify:${BUCKET}"
    echo "remote ready — 'just upload-mount' for a drop-in folder, or 'just upload <dir>'"

# Upload a directory of media to R2 (incremental: only new/changed files).
#   just upload /path/to/movies
upload dir:
    #!/usr/bin/env bash
    set -euo pipefail
    RCLONE="${HOME}/.local/bin/rclone"
    BUCKET="${R2_BUCKET:-castify}"
    [ -x "$RCLONE" ] || { echo "error: run 'just upload-setup' first" >&2; exit 1; }
    [ -d "{{dir}}" ] || { echo "error: no such directory: {{dir}}" >&2; exit 1; }
    "$RCLONE" copy "{{dir}}" "castify:${BUCKET}" \
        --progress --transfers 4 --checkers 8 \
        --s3-chunk-size 64M --s3-upload-concurrency 8
    echo "done — rescan the connection in Castify to pick up new items"

# Mount the R2 bucket as a local folder (systemd user service; auto-starts at
# login). Videos dropped into the folder upload on close.
upload-mount:
    #!/usr/bin/env bash
    set -euo pipefail
    RCLONE="${HOME}/.local/bin/rclone"
    BUCKET="${R2_BUCKET:-castify}"
    MOUNT_DIR="${R2_MOUNT:-${HOME}/R2-castify}"
    UNIT_DIR="${HOME}/.config/systemd/user"
    UNIT="castify-r2-mount.service"
    [ -x "$RCLONE" ] || { echo "error: run 'just upload-setup' first" >&2; exit 1; }

    # Take over from an earlier manual mount of the same directory.
    if mountpoint -q "$MOUNT_DIR"; then
        echo "== rclone: replacing existing mount at ${MOUNT_DIR} =="
        fusermount3 -u "$MOUNT_DIR" 2>/dev/null || fusermount -u "$MOUNT_DIR" || true
    fi
    mkdir -p "$MOUNT_DIR" "$UNIT_DIR"
    # rclone refuses to mount over a non-empty directory; stranded files from
    # an unmounted VFS would wedge the service in a restart loop.
    if [ -n "$(ls -A "$MOUNT_DIR")" ]; then
        echo "error: ${MOUNT_DIR} is not empty — move these aside first:" >&2
        ls -A "$MOUNT_DIR" >&2
        exit 1
    fi

    echo "== systemd: installing ${UNIT} =="
    {
        printf '%s\n' \
            '[Unit]' \
            'Description=Castify R2 media mount (rclone)' \
            '' \
            '[Service]' \
            'Type=notify' \
            "ExecStart=${RCLONE} mount castify:${BUCKET} ${MOUNT_DIR} --vfs-cache-mode writes" \
            'Restart=on-failure' \
            'RestartSec=5' \
            '' \
            '[Install]' \
            'WantedBy=default.target'
    } > "${UNIT_DIR}/${UNIT}"
    systemctl --user daemon-reload
    systemctl --user enable --now "${UNIT}"
    sleep 2
    systemctl --user is-active "${UNIT}"
    echo "mounted: ${MOUNT_DIR} — drop videos there, then rescan in Castify"

# Stop and disable the R2 folder mount.
upload-unmount:
    #!/usr/bin/env bash
    set -euo pipefail
    MOUNT_DIR="${R2_MOUNT:-${HOME}/R2-castify}"
    systemctl --user disable --now castify-r2-mount.service 2>/dev/null || true
    mountpoint -q "$MOUNT_DIR" && fusermount3 -uz "$MOUNT_DIR" 2>/dev/null || true
    echo "unmounted ${MOUNT_DIR}"
