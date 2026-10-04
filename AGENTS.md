# Castify — Agent Skills

This project uses the [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) pack, installed under `.agents/` and `.opencode/`. Reusable workflows (skills), shared checklists (references), lifecycle slash commands, and specialist personas are all wired up and auto-discovered.

## Locations

| Asset | Path |
|-------|------|
| Skills | `.agents/skills/<name>/SKILL.md` |
| Shared checklists | `.agents/references/*.md` |
| Slash commands | `.opencode/commands/*.md` |
| Personas (subagents) | `.opencode/agents/*.md` |

## Core rules

- If a task matches a skill, load it with the `skill` tool before acting.
- Follow the skill workflow strictly — do not partially apply it.
- Never skip required steps (plan, test) a skill demands.
- Every change clears the project-wide Definition of Done in `.agents/references/definition-of-done.md`.
- Commands are silent on success and announce on failure: justfile recipes echo nothing on success (see `set quiet` in the justfile) and fail loudly; slash commands give a concise result on success and surface failures prominently instead of burying them.

## Intent → skill mapping

- New feature / significant change → `planning-and-task-breakdown`, then `incremental-implementation` + `test-driven-development`
- Planning / breakdown → `planning-and-task-breakdown`
- Bug / failure / unexpected behavior → `debugging-and-error-recovery`
- Code review → `code-review-and-quality`
- Refactoring / simplification → `code-simplification`
- API or module boundary design → `api-and-interface-design`
- Rust code / review → `rust-best-practices`
- Security-sensitive input, auth, secrets, dependencies → `security-and-hardening`
- Performance requirements or suspected regressions → `performance-optimization`
- Making a change (always) → `git-workflow-and-versioning`

## Slash commands

`/build [auto]`, `/test`, `/review`, `/constraints`, `/code-simplify`, `/ship`, `/webperf`. Run `/ship` before merge for a parallel fan-out review.

## Personas

`code-reviewer`, `security-auditor`, `test-engineer`, `web-performance-auditor` — single-role subagents invoked by `/ship` / `/webperf` (or directly). **Personas do not invoke other personas**; orchestration belongs to slash commands and the main session (see `.agents/references/orchestration-patterns.md`).

## Project notes

- Rust (`crates/`): run `cargo clippy` and `cargo fmt --check` before a change counts as done; `cargo test` is the verification gate.
- Frontend (`frontend/`, Vite + React + TypeScript): `npm run lint`, `npm run typecheck`, and `npm run test` (vitest) are the gates; e2e (`e2e/`) is Playwright in TypeScript.
## Git is the documentation (spec trail)

- There are no spec/plan/todo files — not in the tree, not in history. An
  effort's context, decisions, deviations, and outcome live in the message
  of its **anchor commit** (the commit that landed the feature), in this
  shape:

  ```
  ---
  Context: why this work existed (1-3 lines)
  Decisions:
  - key choice — and the reason it was made
  Deviations:
  - where implementation diverged from plan (omit section if none)
  Outcome: what shipped, and how it was verified
  ```

- Lookup idiom: `git log --grep='<effort-slug>'` (e.g.
  `git log --grep=share-folders`). Every anchor names its slug in the
  Context line; the milestone efforts (m0–m9) use their milestone ids.
- When landing a feature, write the anchor commit's message this way — it
  is the permanent record reviewers and future agents will read.
- PRs copy the Context/Decisions/Outcome block into the PR body.
- `docs/` holds durable guides only: VISION, ROADMAP, CHANGELOG, config,
  deploy, providers, data-storage-principles, extending-providers.
- Historical note: migrations under `crates/storage/migrations/` still cite
  pre-rewrite `docs/specs/` paths in header comments — sqlx verifies
  migration checksums, so those files are immutable; the citations resolve
  via `git log --grep`.
