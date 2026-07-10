# ---- Stage 1: Frontend build ----
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: Backend build (musl static binary) ----
FROM rust:1-alpine AS backend
RUN apk add --no-cache build-base musl-dev
WORKDIR /app

# Pre-built frontend dist — build.rs skips npm via this env var.
COPY --from=frontend /app/frontend/dist ./frontend/dist
ENV CASTIFY_SKIP_FRONTEND_BUILD=1

COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/

RUN cargo build --release -p castify-api && \
    strip target/release/castify

# Create /data owned by nonroot (uid 65532 in distroless) so Docker named
# volumes inherit the correct ownership on first mount. Distroless has no
# shell, so we prepare this directory here and COPY it in the final stage.
RUN mkdir -p /data && chown 65532:65532 /data && touch /data/.dockerkeep

# ---- Stage 3: Runtime (distroless static, nonroot) ----
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=backend /app/target/release/castify /castify
COPY --from=backend --chown=65532:65532 /data /data

ENV CASTIFY_HOST=0.0.0.0
ENV CASTIFY_PORT=3000
ENV CASTIFY_DATA_DIR=/data

EXPOSE 3000
USER 65532:65532

ENTRYPOINT ["/castify"]
