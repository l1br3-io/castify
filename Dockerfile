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

# E2E=true builds with the `e2e` cargo feature, which enables test-only mock
# provider factories and seed endpoints. Production builds leave it false.
ARG E2E=false
RUN if [ "$E2E" = "true" ]; then \
      cargo build --release -p castify-api --features e2e; \
    else \
      cargo build --release -p castify-api; \
    fi && \
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
ENV CASTIFY_PORT=8427
ENV CASTIFY_DATA_DIR=/data

EXPOSE 8427
USER 65532:65532

ENTRYPOINT ["/castify"]

# ---- Stage 4: E2E runtime (alpine + ffmpeg; test-only) ----
# Built via `--target e2e-runtime` (docker-compose.e2e.yml). The transcode
# pipeline shells out to system ffmpeg/ffprobe (sharing task 013:
# the e2e suite plays a genuinely transcode-needing item end to end), and the
# distroless production stage has neither binary. Alpine runs the same musl
# static binary and carries ffmpeg, so strategy override → ffmpeg → HLS →
# hls.js is exercised for real in Playwright. Production images never build
# this stage (BuildKit skips it without --target).
FROM alpine:3.22 AS e2e-runtime

# ca-certificates: the S3-compatible-storage client (aws-sdk-s3) loads TLS
# roots from the system store on this stage; bare alpine has none. The
# reqwest-based provider clients bundle webpki roots and don't need this,
# but S3-over-HTTPS from an alpine runtime does.
RUN apk add --no-cache ffmpeg ca-certificates

COPY --from=backend /app/target/release/castify /castify
COPY --from=backend --chown=65532:65532 /data /data

ENV CASTIFY_HOST=0.0.0.0
ENV CASTIFY_PORT=8427
ENV CASTIFY_DATA_DIR=/data

EXPOSE 8427
USER 65532:65532

ENTRYPOINT ["/castify"]
