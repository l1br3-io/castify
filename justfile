# Castify task runner. See https://github.com/casey/just

# Load `.env` (root-level) into every recipe's environment, so `cargo run`,
# `npm run dev`, etc. inherit provider creds without manual `source`. The same
# file is read by `docker-compose.yml` via `env_file:` — single source of truth.
# See `.env.example` for the full list of keys.
set dotenv-load := true

# Plain `docker compose` (default stack). E2E recipes use COMPOSE_E2E.
COMPOSE := "docker compose"
COMPOSE_E2E := "docker compose -f docker-compose.yml -f docker-compose.e2e.yml"

# Default: list available recipes.
default:
    @just --list

# Auto-fix what CI checks: formatting, clippy, and frontend lint.
fix:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "== backend: fmt ==";   cargo fmt --all
    echo "== backend: clippy =="; cargo clippy --fix --allow-dirty --all-targets --all-features
    echo "== frontend: lint =="; ( cd frontend && npm run lint -- --fix )

# Run the same checks CI runs, locally. Fails fast on the first failing step.
ci:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "== backend: fmt ==";   cargo fmt --all -- --check
    echo "== backend: clippy =="; cargo clippy --all-targets --all-features -- -D warnings
    echo "== backend: test ==";  cargo test --all
    echo "== frontend: install =="; ( cd frontend && npm ci )
    echo "== frontend: typecheck =="; ( cd frontend && npm run typecheck )
    echo "== frontend: lint =="; ( cd frontend && npm run lint )
    echo "== frontend: test =="; ( cd frontend && npm run test )
    echo "== frontend: build =="; ( cd frontend && npm run build )

# Run all tests reliably in one go, single-threaded backend (per deviation #18)
# plus frontend type/lint/test. Use as a pre-manual-testing baseline.
preflight:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "== backend: test (single-threaded) =="; cargo test -p castify-api -- --test-threads=1
    echo "== frontend: typecheck =="; ( cd frontend && npm run typecheck )
    echo "== frontend: lint =="; ( cd frontend && npm run lint )
    echo "== frontend: test =="; ( cd frontend && npm run test )

# Run all tests: backend (Rust) and frontend (Vitest).
test:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "== backend: test ==";  cargo test --all
    echo "== frontend: test =="; ( cd frontend && npm run test )

# Run the Rust API in the foreground (backend on 127.0.0.1:8427 by default).
api:
    cargo run -p castify-api

# Like `api`, named for the split-terminal Vite dev workflow (pair with `dev-web`).
dev-api:
    cargo run -p castify-api

# Run the Vite dev server in the foreground (frontend on http://localhost:5173,
# proxies /api to the backend declared by CASTIFY_BACKEND_URL, default 127.0.0.1:8427).
web:
    cd frontend && npm run dev

# Paired with `dev-api`: same as `web`, named for the split-terminal dev flow.
dev-web:
    cd frontend && npm run dev

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
    ( cd e2e && npm ci )
    echo "== e2e: install chromium =="
    # --with-deps installs system libraries (libnss3, etc.) via sudo.
    # Fall back to browser-only if sudo is unavailable.
    if ! ( cd e2e && npx playwright install --with-deps chromium ); then
        echo "note: --with-deps failed (no sudo?); installing browser only" >&2
        ( cd e2e && npx playwright install chromium )
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
    ( cd e2e && npx playwright test )

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
    cargo run -p castify-bench --bin bench-seed

# Run HTTP latency benchmark against a running API. Requires BENCH_SESSION
# (the castify_session cookie value).
bench-run:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo run -p castify-bench --bin bench-run -- \
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
        ( cargo run -p castify-api ) &
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
    ( cd frontend && npm run dev ) &
    wait
