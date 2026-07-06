# Castify

> *One home for all your cloud media. Unified, organized, and yours. Free, by [l1br3](https://github.com/l1br3).*

Castify is a free, open-source **personal media hub** that connects to the cloud storage you already pay for and unifies your scattered videos into one organized, searchable library. The media never leaves your cloud.

- **Vision:** [`VISION.md`](./VISION.md)
- **Roadmap:** [`ROADMAP.md`](./ROADMAP.md)
- **Current milestone:** M0 — Foundation (see [`docs/prds/m0-foundation.md`](./docs/prds/m0-foundation.md))

## Status

Greenfield. M0 (Foundation) is under active development. Nothing is shipped yet.

## Repository layout

```
castify/
├── crates/         # Rust workspace (api, core, storage, auth)
├── frontend/       # Vite + React SPA
├── docs/prds/      # Product requirements per milestone
├── tasks/          # Implementation plans and checklists
└── ops/            # Docker, deploy
```

## License

Copyright (C) 2026 l1br3. Licensed under [AGPL-3.0](./LICENSE).
