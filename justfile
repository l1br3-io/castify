# Castify task runner. See https://github.com/casey/just

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

# Run the Rust API in the foreground (backend on 127.0.0.1:3000 by default).
api:
    cargo run -p castify-api

# Like `api`, but pre-set for the Vite dev workflow (WebAuthn origin :5173).
dev-api:
    CASTIFY_PUBLIC_URL=http://localhost:5173 cargo run -p castify-api

# Run the Vite dev server in the foreground (frontend on http://localhost:5173,
# proxies /api to the backend declared by CASTIFY_BACKEND_URL, default 127.0.0.1:3000).
web:
    cd frontend && npm run dev

# Paired with `dev-api`: same as `web`, named for the split-terminal dev flow.
dev-web:
    cd frontend && npm run dev

# Dev mode: backend + frontend concurrently, with hot-reload on the frontend.
# Ctrl-C kills both. Requires `cargo-watch` for backend auto-reload; falls back
# to plain `cargo run` if it's not installed. WebAuthn origin is pinned to the
# Vite dev server (http://localhost:5173); use `api` for other workflows.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    export CASTIFY_PUBLIC_URL=http://localhost:5173
    if cargo watch --version >/dev/null 2>&1; then
        ( cargo watch -x "run -p castify-api" ) &
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
    ( cd frontend && npm run dev ) &
    wait
