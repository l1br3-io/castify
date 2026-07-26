# Castify

> *One home for all your cloud media. Unified, organized, and yours. Free, by [l1br3](https://github.com/l1br3).*

Castify is a free, open-source **personal media server** that connects to the cloud storage you already pay for and unifies your scattered videos into one organized, searchable library. You run it on your own hardware; the media never leaves your cloud.

- **Vision:** [`docs/VISION.md`](./docs/VISION.md)
- **Roadmap:** [`docs/ROADMAP.md`](./docs/ROADMAP.md)
- **Current phase:** M8 — Advanced subtitles (see [`SPEC.md`](./SPEC.md))

## Status

M0–M7 are complete (launch core M0–M3, plus the self-hosted media server arc M3.5–M7).
M8 (Advanced subtitles) is the current phase. Finished phases are archived as units
under [`tasks/archive/`](./tasks/archive/).

## Repository layout

```
castify/
├── crates/         # Rust workspace (api, core, storage, auth, catalog, cache, bench)
├── frontend/       # Vite + React SPA
├── docs/           # Config, deployment, vision, and roadmap
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
