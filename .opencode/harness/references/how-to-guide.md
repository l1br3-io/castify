# Harness How-To Guide

Consolidated answers to common questions about this harness. Use via
`/how-to-guide` (which converses with you) or read directly. Each entry gives
the direct answer, the practical "so what," and a pointer to the source file
that governs it.

## Table of Contents

1. [Resuming after a break](#1-resuming-after-a-break)
2. [What "phase" means](#2-what-phase-means)
3. [File roles: SPEC, plan, todo, archive](#3-file-roles-spec-plan-todo-archive)
4. [Vertical slicing](#4-vertical-slicing)
5. [Project-agnostic? agile-coupled?](#5-project-agnostic-agile-coupled)
6. [Where `/spec` gets its inputs](#6-where-spec-gets-its-inputs)
7. [ROADMAP.md / VISION.md compatibility](#7-roadmapmd--visionmd-compatibility)
8. [Commit messages](#8-commit-messages)
9. [Open-source developers](#9-open-source-developers)

---

## 1. Resuming after a break

**Single source of truth: `tasks/todo.md`.** Its checkboxes are the project's
status (principle 3: one status source).

Resume flow:

1. Read `tasks/todo.md` → find the next unchecked task.
2. Read **only that task's section** in `tasks/plan.md` (not the whole file —
   `.opencode/commands/build.md:16`).
3. `git log --oneline -10` for recent commits; `git status` for a clean
   baseline.
4. Run `/build` — it does all of the above automatically and stops at the next
   pending task with a RED test ready (`.opencode/commands/build.md:14-25`).

**If `tasks/todo.md` is missing:** the prior phase completed and was archived.
Browse `tasks/archive/YYYY-MM-DD-<slug>/` to see what shipped, then run `/spec`
for the next phase.

**Monitoring signals:** todo checkbox progress (phase health),
`tasks/archive/` (completed phases), recent `git log` (velocity), and ADRs in
`docs/decisions/` — the highest-numbered ADR you haven't seen = decisions made
in your absence.

**Caveat:** no frozen `VISION.md` or `ROADMAP.md` re-anchors you on the
*project's* purpose across phases. Only archived phase specs + ADRs preserve
that trail (see entry 7).

---

## 2. What "phase" means

A scope-bounded unit of work that fits in one plan. The word is overloaded at
two granularities (not files — granularities):

- **Level 1 (archive-level phase)** = one whole plan's scope, i.e. one
  feature/effort. Owns three artifacts together: `SPEC.md` +
  `tasks/plan.md` + `tasks/todo.md`. When complete, all three archive to
  `tasks/archive/YYYY-MM-DD-<slug>/` (principle 2: archive as a unit).
- **Level 2 (internal sub-phase)** = a section heading *inside* `plan.md`
  (e.g. `### Phase 1: Foundation`, `### Phase 2: Core Features`). A grouping
  of tasks with a checkpoint between groups.

All three files (`SPEC.md` + `plan.md` + `todo.md`) belong to ONE level-1
phase. Level-2 sub-phases are sections within `plan.md`, not separate files.

**Lifecycle:** `/spec` → `/planning` → `/build` → checkpoint passes → archive
the trio together → fresh spec for the next phase.

**Agile equivalent:** level 1 ≈ an **Epic** (scope-bounded, decomposed);
level 2 ≈ a **milestone within an epic**. NOT a Sprint — sprints are
timeboxed, phases are scope-bounded. Done when the checkpoint passes, not when
the calendar says so (`.opencode/skills/planning-and-task-breakdown/SKILL.md:201-204`).

**Typical size:** ~6-15 tasks across 2-4 internal sub-phases, ~600-1500 LOC,
roughly 1-2 weeks solo or a couple of days for a small team.

---

## 3. File roles: SPEC, plan, todo, archive

| File                                              | What it is                                                                       | Belongs to          |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------- |
| `SPEC.md` (or `spec/<name>.md`)                   | What this phase builds + why + success criteria                                 | One level-1 phase   |
| `tasks/plan.md`                                   | Breakdown of this phase: overview, architecture decisions, task list grouped into level-2 sub-phases, checkpoints | One level-1 phase |
| `tasks/todo.md`                                   | Flat checkbox list — the **single status source** (principle 3)                  | One level-1 phase   |
| `tasks/archive/YYYY-MM-DD-<slug>/`                | History paired with its spec; archived trio per finished phase                   | Prior phases        |

All three live artifacts (`SPEC.md` + `plan.md` + `todo.md`) archive
**together** when the phase completes. Archival is a plain filesystem move,
suggested by the agent, confirmed by the human — never automatic
(`planning-and-task-breakdown/SKILL.md:222-224`).

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
`web-performance-auditor`, `performance-optimization`). Solo / small-team
assumptions throughout (single human-reviewer gate, 1-3 day branches).

**Poor fits:** ML research, data pipelines, game dev, embedded/firmware,
hardware, academic publishing, CLI-only utilities with no UI.

---

## 6. Where `/spec` gets its inputs

`/spec` is NOT based on an upstream doc — it's an **interview**
(`.opencode/commands/spec.md:9-13`, `spec-driven-development/SKILL.md:36`).
The spec is generated from a clarifying-question loop with the user.

**Grounding inputs it does use:**

- The user (primary) — the interview itself.
- `AGENTS.md` + `.opencode/harness/rules/tech.md` — always-loaded project
  conventions (the spec inherits the declared stack and conventions).
- Existing `SPEC.md` / `spec/<name>.md` — continuation of a prior phase.
- The codebase — patterns to mirror.
- ADRs in `docs/decisions/` — past decisions, so it doesn't re-decide.

**What it does NOT read** — because they don't exist in the harness:
`VISION.md`, `ROADMAP.md`, `PRD.md`. So `/spec` re-derives the "why" from
scratch each invocation. That's the principles 4 & 7 gap.

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

**For the resume mechanism: no.** `/build` resumes from `tasks/todo.md` +
`git status --porcelain`, not from commit messages
(`.opencode/commands/build.md:16,32`). Terse messages don't break resume.

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
  trail), `/ship` fan-out review (peer review automation). Solo maintainers
  and small OSS teams are the sweet spot.

**Caveats:**

- `AGENTS.md` becomes part of your repo — contributors using opencode get the
  full workflow; those on other editors see only the markdown and must follow
  it manually.
- No multi-maintainer coordination patterns — the harness assumes a single
  reviewer gate. Layer your own release process on top.
- Contributors get the skill/command orchestration only inside opencode.
  Outside it, the workflow is just markdown instructions.
