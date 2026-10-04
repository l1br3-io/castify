# Castify

> *One home for all your cloud media. Unified, organized, and yours. Free, by [l1br3](https://github.com/l1br3).*

Castify is a free, open-source **personal media server** that connects to the cloud storage you already pay for and unifies your scattered videos into one organized, searchable library. You run it on your own hardware; the media never leaves your cloud.

- **Vision:** [`docs/VISION.md`](./docs/VISION.md)
- **Roadmap:** [`docs/ROADMAP.md`](./docs/ROADMAP.md)
- **Effort history:** in the git log — anchor commit messages carry each effort's context, decisions, and outcome (`git log --grep='<effort>'`)

## Status

M0–M7 are complete (launch core M0–M3, plus the self-hosted media server arc M3.5–M7).
M8 (Advanced subtitles) shipped. Every finished effort is documented by its landing
commit: run `git log --grep='<effort-slug>'` to read its context, decisions,
deviations, and outcome.

## Repository layout

```
castify/
├── crates/         # Rust workspace (api, core, storage, auth, catalog, cache, bench)
├── frontend/       # Vite + React SPA
├── docs/           # Vision, roadmap, deploy, and provider guides
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
