# Harness How-To Guide

Consolidated answers to common questions about this harness. Use via
`/how-to-guide` (which converses with you) or read directly. Each entry gives
the direct answer, the practical "so what," and a pointer to the source file
that governs it.

## Table of Contents

1. [Resuming after a break](#1-resuming-after-a-break)
2. [What an "effort" means](#2-what-an-effort-means)
3. [File roles: spec, plan, todo, tasks](#3-file-roles-spec-plan-todo-tasks)
4. [Vertical slicing](#4-vertical-slicing)
5. [Project-agnostic? agile-coupled?](#5-project-agnostic-agile-coupled)
6. [Where `/spec` gets its inputs](#6-where-spec-gets-its-inputs)
7. [ROADMAP.md / VISION.md compatibility](#7-roadmapmd--visionmd-compatibility)
8. [Commit messages](#8-commit-messages)
9. [Open-source developers](#9-open-source-developers)

---

## 1. Resuming after a break

**Single source of truth: the current effort's `todo.md`.** Its checkboxes are
the project's status (principle: one status source).

Resume flow:

1. Identify the active effort — it's the branch you're on. The effort's docs
   live at `docs/specs/<effort-slug>/`.
2. Read `docs/specs/<effort-slug>/todo.md` → find the next unchecked task.
3. Read **only that task's detail file** at
   `docs/specs/<effort-slug>/tasks/00N-<task-slug>.md` (not the whole plan —
   `.opencode/commands/build.md:16`).
4. `git log --oneline -10` for recent commits; `git status` for a clean
   baseline.
5. Run `/build` — it does all of the above automatically and stops at the next
   pending task with a RED test ready (`.opencode/commands/build.md:14-25`).

**If no `docs/specs/<effort-slug>/` directory exists on this branch:** the prior
effort shipped (or this is a fresh branch). Browse `docs/specs/` for shipped
efforts (their `spec.md` will show `status: shipped` with the merge date), then
run `/spec` to start a new effort on this branch.

**Monitoring signals:** checkbox progress in the current `todo.md` (effort
health), `ls docs/specs/` (shipped efforts and their statuses), recent
`git log` (velocity), and ADRs in `docs/adrs/` — the highest-numbered ADR you
haven't seen = decisions made in your absence.

**Caveat:** no frozen `VISION.md` or `ROADMAP.md` re-anchors you on the
*project's* purpose across efforts. Only shipped effort specs + ADRs preserve
that trail (see entry 7).

---

## 2. What an "effort" means

A scope-bounded unit of work that fits in one branch and one
`docs/specs/<effort-slug>/` directory. The word "phase" is overloaded at two
granularities (not files — granularities):

- **Level 1 (effort)** = one whole feature/change scope. Owns four artifacts
  together inside one directory: `spec.md` + `plan.md` + `todo.md` + `tasks/`.
  When complete, `spec.md` frontmatter flips to `status: shipped` in the merge
  commit; the directory stays in place at `docs/specs/<slug>/` forever. There
  is no archive directory.
- **Level 2 (internal sub-phase)** = a section heading *inside* `plan.md`
  (e.g. `### Phase 1: Foundation`, `### Phase 2: Core Features`). A grouping
  of tasks with a checkpoint between groups.

All four files (`spec.md` + `plan.md` + `todo.md` + `tasks/`) belong to ONE
effort directory. Level-2 sub-phases are sections within `plan.md`, not
separate files.

**Lifecycle:** branch created → `/spec` writes `spec.md` (status: `draft`) →
`/planning` writes `plan.md` + `todo.md` + `tasks/*` → `/build` flips to
`status: active` and executes → checkpoint passes → PR merges, `spec.md`
flips to `status: shipped`. Next effort starts on a fresh branch with a fresh
directory.

**Agile equivalent:** level 1 ≈ an **Epic** (scope-bounded, decomposed);
level 2 ≈ a **milestone within an epic**. NOT a Sprint — sprints are
timeboxed, efforts are scope-bounded. Done when the checkpoint passes, not
when the calendar says so.

**Typical size:** ~6-15 tasks across 2-4 internal sub-phases, ~600-1500 LOC,
roughly 1-2 weeks solo or a couple of days for a small team.

---

## 3. File roles: spec, plan, todo, tasks

### Mental model — four files, four jobs

One effort = one branch = one directory at `docs/specs/<effort-slug>/`. Inside
that directory, four files do four distinct jobs. The split exists so each
file stays thin — a thick plan bloats every `/build` step that has to read it.

| File                          | Metaphor                    | Answers                              | Belongs to        |
| ----------------------------- | --------------------------- | ------------------------------------ | ----------------- |
| `spec.md`                       | **Destination**                 | What does done look like?            | One effort        |
| `plan.md`                       | **Route** (outline)            | What are the major steps in order?   | One effort        |
| `todo.md`                       | **Progress**                    | Which steps are checked off?         | One effort        |
| `tasks/00N-<slug>.md`           | **Turn-by-turn directions**     | What exactly does this step entail?  | One task in the effort |

If you find yourself writing acceptance criteria or file lists inside
`plan.md`, stop — that content belongs in the corresponding `tasks/00N-*.md`
file. The plan is the outline; the task files are the body.

### Directory layout per effort

```
docs/specs/<effort-slug>/
  spec.md                   ← what & why (frontmatter: status, started, shipped)
  plan.md                   ← thin index (overview + architecture + task list + checkpoints + risks)
  todo.md                   ← flat checkboxes only — the single status source
  tasks/
    001-<task-slug>.md      ← per-task detail (acceptance, files, verify, deps)
    002-<task-slug>.md
    ...

docs/adrs/                  ← permanent cross-cutting decisions (append-only)
  0001-<slug>.md
  0002-<slug>.md

docs/gotchas.md             ← project-wide gotchas (referenced by #gN anchors)
```

### Lifecycle (no archive, no move)

`spec.md` carries a `status` frontmatter field that tracks the effort's
phase. **Nothing moves when the status changes** — the directory stays at
`docs/specs/<slug>/` forever:

```
draft  ──→  active  ──→  shipped
                              ↘
                               abandoned   (branch deleted before shipping)
```

`docs/specs/` accumulates shipped and abandoned efforts alongside active ones.
Git is the full history; the filesystem is the browsable index. There is no
`archive/` directory.

See `planning-and-task-breakdown` § Effort File Lifecycle for the canonical
explanation.

---

## 4. Vertical slicing

Slicing work by **complete user-facing path per task**, not by architectural
layer (`planning-and-task-breakdown/SKILL.md:57-77`).

**Bad (horizontal):** all DB schema → all API endpoints → all UI components →
wire everything. Nothing works until the final wiring task.

**Good (vertical):** Task 1 = full register flow (schema + API + UI); Task 2 =
full login flow; Task 3 = full task-create flow. Each task ships working,
testable functionality end-to-end.

**Why it matters:**
- Earlier working software — you can demo after task 1.
- Smaller blast radius per task — easier to review, revert, debug.
- Dependencies surface immediately rather than at the wire-up task.
- You can stop after any task and the system still runs.

---

## 5. Project-agnostic? agile-coupled?

**No to both** — the harness is a bespoke synthesis with clear opinions.

**Methodology.** NOT coupled to Scrum, Kanban, or SAFe (no sprints, standups,
retros, story points, PO/SM roles). But DOES couple to engineering practices
that overlap with agile:

- TDD (RED → GREEN → IMROVE) — `test-driven-development` skill, mandatory in
  the `/build` loop.
- Trunk-based development — `git-workflow-and-versioning/SKILL.md:18-32`,
  explicitly DORA-cited.
- Vertical slicing (see entry 4).
- Atomic commits, incremental delivery.

Plus a gated SDLC: `DEFINE → /spec → PLAN → /planning → BUILD → /build →
VERIFY → /test → REVIEW → /review → SHIP → /ship`. Closer to a lightweight
gated SDLC per feature than to a sprint cadence.

**Project fit.** Multi-stack via the tech router (Rust, Python, TS/JS, C++,
Go, Java, Kotlin, etc. + frameworks: React, Vue, Angular, Nuxt, Svelte, Solid,
Astro, React Native, ArkTS) but opinionated *within* each stack. Domain skews
web-app / production software — skills lean frontend
(`frontend-ui-engineering`, `browser-testing-with-devtools`,
`web-performance-auditor`, `performance-optimization`).

**Team-size fit.** The docs layout is multi-scale — solo developers, small
teams, and large teams all use the same `docs/specs/<effort-slug>/` structure.
Each effort lives on its own branch in its own directory, so concurrent efforts
don't collide. For very large projects (hundreds of efforts), an optional
grouping layer (e.g. `docs/specs/<area>/<effort>/`) keeps the directory
scannable — the harness doesn't enforce it, just allows it. Open-contribution
projects that need formal proposal acceptance can extend the `status` enum
(`draft | active | shipped | abandoned`) with intermediate states like
`provisional | implementable` to match a KEP/RFC-style governance process;
that's an additive extension, not a different model.

**Poor fits:** ML research, data pipelines, game dev, embedded/firmware,
hardware, academic publishing, CLI-only utilities with no UI.

---

## 6. Where `/spec` gets its inputs

`/spec` is NOT based on an upstream doc — it's an **interview**
(`spec-driven-development/SKILL.md` § Phase 1). The spec is generated from a
clarifying-question loop with the user.

**Grounding inputs it does use:**

- The user (primary) — the interview itself.
- `AGENTS.md` + `.opencode/harness/rules/tech.md` — always-loaded project
  conventions (the spec inherits the declared stack and conventions).
- Existing shipped efforts in `docs/specs/` — prior efforts' `spec.md` files
  may be read for context if this effort is a continuation. (Active efforts
  on other branches are NOT read — they're isolated per branch.)
- The codebase — patterns to mirror.
- ADRs in `docs/adrs/` — past decisions, so it doesn't re-decide.

**Output:** `docs/specs/<effort-slug>/spec.md` with `status: draft` frontmatter.

**What it does NOT read** — because they don't exist in the harness:
`VISION.md`, `ROADMAP.md`, `PRD.md`. So `/spec` re-derives the "why" from
scratch each invocation. That's the principles gap noted in entry 7.

---

## 7. ROADMAP.md / VISION.md compatibility

**Yes, essentially inert.** Adding them as plain docs doesn't conflict with
the harness.

- `.opencode/harness/scripts/lint-frontmatter.py` scans only
  `.opencode/{skills,agents,commands,tech}/` — root-level `.md` files are
  invisible to it.
- `.opencode/harness/scripts/check-refs.py` scans all `.md` files but only
  validates **internal** refs (paths starting with `.opencode/`, `tests/`, or
  `./` / `../`). Links from ROADMAP to `docs/foo.md` are skipped; relative
  relative links (e.g. ROADMAP linking to its sibling VISION.md) are checked
  but resolve fine if the file exists.
- **Not auto-loaded.** Always-loaded context is `AGENTS.md` + `tech.md` only.
  ROADMAP/VISION sit alongside README/CHANGELOG/CONTRIBUTING as standalone
  docs and don't bloat agent context.

In downstream projects that adopt the harness, the validators don't run
unless explicitly invoked — so ROADMAP/VISION are 100% free-form.

**Caveat:** adding the *files* doesn't enforce the *principles* (ROADMAP = thin
index, VISION = frozen narrative). Those conventions are voluntary. If you
want the harness to *prescribe* that shape, that's the principles 4 & 7 gap —
not closed by merely adding the files.

---

## 8. Commit messages

**For the resume mechanism: no.** `/build` resumes from
`docs/specs/<effort-slug>/todo.md` + `git status --porcelain`, not from commit
messages (`.opencode/commands/build.md:16,32`). Terse messages don't break
resume.

**For harness convention: yes.** `git-workflow-and-versioning` § 3 prescribes
Conventional Commits:

```
<type>: <short description>

<optional body explaining why, not what>
```

Types: `feat | fix | refactor | test | docs | chore`.
`.opencode/commands/build.md:24` floors it at "Commit with a descriptive
message." Red flag (`git-workflow-and-versioning/SKILL.md:283`): messages
like `"fix"`, `"update"`, `"misc"`.

**Bottom line:** format is a project-quality convention, not a
resume-dependency.

---

## 9. Open-source developers

**Yes.**

- **MIT licensed** (`LICENSE`), public repo, install via
  `curl … | python3 -` (one command). No fee, no proprietary deps.
- **Non-invasive adoption.** `install.py` copies `.opencode/`, `install.py`,
  and the validators. Your application code keeps its own license; harness
  files retain MIT (per the LICENSE inclusion clause). MIT is
  GPL/LGPL/Apache/AGPL-compatible — doesn't contaminate copyleft projects.
- **Fits OSS patterns.** Spec-driven (good for async contributors), gated
  human review (PRs), atomic commits (clean history), ADRs (governance
  trail), `/ship` fan-out review (peer review automation).
- **Multi-scale layout.** The `docs/specs/<effort-slug>/` structure scales
  from solo maintainers to large OSS teams. Each effort on its own branch
  means concurrent contributor work doesn't collide; merge brings the effort
  directory into main where it stays as browseable history (no archive to
  maintain). Trusted-committer projects (Cargo, Django, FastAPI style) work
  as-is; open-contribution projects (Rust, Kubernetes style) can extend the
  `status` enum and add a grouping layer (`docs/specs/<area>/<effort>/`)
  without changing the core model.

**Caveats:**

- `AGENTS.md` becomes part of your repo — contributors using opencode get the
  full workflow; those on other editors see only the markdown and must follow
  it manually.
- Reviewer-gate patterns (single reviewer, multi-reviewer, steering committee)
  are layered on top via your platform's PR tooling — the harness doesn't
  prescribe a specific reviewer model.
- Contributors get the skill/command orchestration only inside opencode.
  Outside it, the workflow is just markdown instructions.
