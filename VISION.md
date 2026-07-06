# Vision

> **Status:** Living document — the "why" behind Castify.
> **Owner:** Castify Team — **l1br3** *(pronounced "libre")*
> **Tagline:** *"One home for all your cloud media."*

Castify is a free, open-source **personal media hub** — a product of the **l1br3** organization (pronounced "libre") — that connects to the cloud storage users *already pay for* and unifies scattered photos, videos, and audio into one organized, searchable library. It brings together the best parts of Google Drive, Google Photos, iCloud, and pCloud: bring-your-own-cloud aggregation, organized browsing, instant sharing, and direct playback — without ever moving or re-hosting the user's media.

Castify ships in two ways from a single product: a **vendor-hosted service** for the average user (no install, no signup — just connect a cloud provider and your library appears), and a **self-hosted** option for power users who want full control, privacy, or have outgrown the free service's limits.

The app is free. Cloud storage is already paid for. That's the disruption: competitors charge $10–30/mo for storage lock-in; Castify charges nothing for the app and lets your existing cloud do the heavy lifting. The hosted service stays sustainable through per-owner usage limits that funnel power users toward self-hosting — costs stay bounded while the product stays free for everyone.

**Product positioning:** *"One home for all your cloud media. Unified, organized, and yours. Free, by l1br3."*

---

## The problem

Users increasingly store personal media (photos, videos, music) in cloud storage — often across multiple providers (Google Drive, Dropbox, OneDrive, Backblaze B2). But there is **no unified home** for that media. Each provider offers part of the experience — Drive aggregates files but doesn't organize them; Google Photos organizes but locks you into its storage; iCloud is Apple-only; pCloud stores but offers little polish — and none of them unifies the others.

Existing solutions all extract a recurring cost or impose friction:

- **Google Photos / Apple Photos** — Polished, but you must store media in *their* cloud. You re-buy storage you may already have, and lose data sovereignty. ($9.99–$29.99/mo for 2 TB.)
- **Immich / PhotoPrism** — Open source and self-hosted, but require you to buy and run server hardware for storage. No bring-your-own-cloud.
- **Plex** — Great media management, but needs an always-on media server, advanced features need a paid pass, and every viewer must create an account and be invited.
- **Infuse** — Apple-only, paid.
- **Google Drive / iCloud / pCloud** — Reliable storage, but no unified library view, no cross-provider aggregation, no unified browse/share experience.

The core pains:

1. **Storage lock-in** — you pay again for space you already have.
2. **Media fragmentation** — content scattered across providers with no unified home.
3. **No unified library** — each provider silos your media.
4. **Manual organization** — no help to group, tag, dedupe, or surface memories.
5. **Cost** — recurring subscriptions for features that should be free.
6. **Sharing friction** — watching together means every household member must create an account on the same platform, or be admin-provisioned.

Castify solves this by connecting to the cloud storage users *already pay for*, unifying every provider into one home, and making that media easy to browse, organize, and share.

---

## Goals

| Goal | Target |
|------|--------|
| Unify every connected provider into one browsable library | Set up and see a unified catalog in under 10 minutes |
| Fastest possible onboarding | From landing page to first unified library view in under 2 minutes (no install, no signup) |
| Major cloud providers from day one | 3 providers at launch (Google Drive, Dropbox, OneDrive) |
| Snappy unified library | Renders across all connected providers in under 500 ms |
| Deduplicate across providers | A majority of libraries deduplicated |
| Direct cloud playback | Video starts within 3 seconds |
| Frictionless household sharing | From guest receiving a link to browsing in under 30 seconds |
| Genuinely free | $0 monthly app cost |
| Community adoption | Growing pulls, stars, and signups |

### Non-goals (explicitly out of scope)

**At launch — NOT shipping:**

- Individual viewer accounts / per-user profiles — launch uses account-less **guest links** instead.
- Photo management / browsing.
- Auto-grouped memories and stories.
- Face recognition / people albums.
- Semantic / natural-language search.

**Across all phases — NOT building:**

- Our own cloud media storage service — always bring-your-own-cloud; the user's media stays in their cloud.
- Paid subscription tiers — the app is always free; sustainability comes from usage limits + a self-host path, never paywalls.
- Email/password accounts — signing in happens through the user's cloud provider.
- Server-side video transcoding — ever.

---

## Who it's for

| Persona | Description | Key need |
|---------|-------------|----------|
| **The Average Joe** *(primary)* | Non-technical; wants "it just works"; will never self-host or run server software | Hosted service: no install, no signup, no config — connect a cloud provider and the library appears |
| The Self-Hoster | Runs a NAS or home server; values data sovereignty | Self-host at their own domain; full control, no limits, no lock-in |
| The Media Hoarder | Has movies/shows across cloud storage; wants one organized library | Free, unified hub — organized catalog, browse and play from one place |
| The Multi-Cloud User | Media scattered across Drive, Dropbox, B2 | One unified library across all providers |
| The Family | Multiple household members on different devices | Guest link sharing, no viewer accounts at launch |
| The Traveler | Accesses the library from anywhere | Remote browse from cloud |

---

## Where this fits

This vision is the top of the planning hierarchy. Direction and milestones live in [`ROADMAP.md`](./ROADMAP.md).

```text
VISION   "What problem does this project solve?"     VISION.md  (this)
  │
ROADMAP  "What directions / milestones?"              ROADMAP.md
  │
PRDs     "Detailed requirements per area"            docs/prds/   (forthcoming)
  │
EPICS    "Trackable feature groups"
  │
ISSUES   "Specific, actionable work items"
  │
PRs      "Implementation against issues"
  │
RELEASES "Ship it, tag it, communicate it"
```
