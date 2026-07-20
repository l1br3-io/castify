# Castify

> *One home for all your cloud media. Unified, organized, and yours. Free, by [l1br3](https://github.com/l1br3).*

Castify is a free, open-source **personal media server** that connects to the cloud storage you already pay for and unifies your scattered videos into one organized, searchable library. You run it on your own hardware; the media never leaves your cloud.

- **Vision:** [`docs/VISION.md`](./docs/VISION.md)
- **Roadmap:** [`docs/ROADMAP.md`](./docs/ROADMAP.md) · **Self-hosted media server arc:** [`docs/ROADMAP-self-hosted-media-server.md`](./docs/ROADMAP-self-hosted-media-server.md)
- **Current milestone:** M3 — Play (see [`docs/prds/m3-play.md`](./docs/prds/m3-play.md))

## Status

M0 (Foundation), M1 (Connect & Catalog), and M2 (Browse) are complete. M3 (Play) is the final launch milestone.

Post-launch, the **self-hosted media server arc** is in progress:
- **M3.5** (streaming posture refactor) — ✅ complete
- **M4** (hot video disk cache) — ✅ complete
- **M5** (codec model via ffprobe) — ✅ complete
- **M6** (server-side transcoding via ffmpeg) — ✅ complete
- **M7** (adaptive bitrate) — not started
- **M8** (advanced subtitles) — not started

## Repository layout

```
castify/
├── crates/         # Rust workspace (api, core, storage, auth, catalog, cache, bench)
├── frontend/       # Vite + React SPA
├── docs/           # Config, deployment, PRDs, and roadmap
├── tasks/          # Implementation plans, checklists, and audit reports
├── Dockerfile      # Multi-stage build (Node → Rust → distroless)
└── docker-compose.yml
```

## Quick start

```sh
docker compose up -d
```

Open `http://localhost:8427` and follow the setup wizard. See [`docs/deploy.md`](./docs/deploy.md) for full deployment instructions.

## License

Copyright (C) 2026 l1br3. Licensed under [AGPL-3.0](./LICENSE).
