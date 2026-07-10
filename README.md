# Castify

> *One home for all your cloud media. Unified, organized, and yours. Free, by [l1br3](https://github.com/l1br3).*

Castify is a free, open-source **personal media hub** that connects to the cloud storage you already pay for and unifies your scattered videos into one organized, searchable library. The media never leaves your cloud.

- **Vision:** [`docs/VISION.md`](./docs/VISION.md)
- **Roadmap:** [`docs/ROADMAP.md`](./docs/ROADMAP.md)
- **Current milestone:** M0 — Foundation (see [`docs/prds/m0-foundation.md`](./docs/prds/m0-foundation.md))

## Status

Greenfield. M0 (Foundation) is under active development. Nothing is shipped yet.

## Repository layout

```
castify/
├── crates/         # Rust workspace (api, core, storage, auth)
├── frontend/       # Vite + React SPA
├── docs/           # Config, deployment, and PRDs
├── tasks/          # Implementation plans and checklists
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
