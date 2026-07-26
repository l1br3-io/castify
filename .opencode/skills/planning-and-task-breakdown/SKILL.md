---
name: planning-and-task-breakdown
description: Breaks work into ordered tasks. Use when you have a spec or clear requirements and need to break work into implementable tasks. Use when a task feels too large to start, when you need to estimate scope, or when parallel work is possible.
---

# Planning and Task Breakdown

## Overview

Decompose work into small, verifiable tasks with explicit acceptance criteria. Good task breakdown is the difference between an agent that completes work reliably and one that produces a tangled mess. Every task should be small enough to implement, test, and verify in a single focused session.

## When to Use

- You have a spec and need to break it into implementable units
- A task feels too large or vague to start
- Work needs to be parallelized across multiple agents or sessions
- You need to communicate scope to a human
- The implementation order isn't obvious

**When NOT to use:** Single-file changes with obvious scope, or when the spec already contains well-defined tasks.

## The Planning Process

### Step 1: Enter Plan Mode

Before writing any code, operate in read-only mode:

- Read the spec and relevant codebase sections
- Identify existing patterns and conventions
- Map dependencies between components
- Note risks and unknowns

**Do NOT write code during planning.** The output is a plan document, not implementation.

### Step 2: Identify the Dependency Graph

Map what depends on what:

```
Database schema
    │
    ├── API models/types
    │       │
    │       ├── API endpoints
    │       │       │
    │       │       └── Frontend API client
    │       │               │
    │       │               └── UI components
    │       │
    │       └── Validation logic
    │
    └── Seed data / migrations
```

Implementation order follows the dependency graph bottom-up: build foundations first.

### Step 3: Slice Vertically

Instead of building all the database, then all the API, then all the UI — build one complete feature path at a time:

**Bad (horizontal slicing):**
```
Task 1: Build entire database schema
Task 2: Build all API endpoints
Task 3: Build all UI components
Task 4: Connect everything
```

**Good (vertical slicing):**
```
Task 1: User can create an account (schema + API + UI for registration)
Task 2: User can log in (auth schema + API + UI for login)
Task 3: User can create a task (task schema + API + UI for creation)
Task 4: User can view task list (query + API + UI for list view)
```

Each vertical slice delivers working, testable functionality.

### Step 4: Write Tasks

Each task becomes **its own file** under `docs/specs/<effort-slug>/tasks/00N-<task-slug>.md`. This keeps `plan.md` a thin index (cheap for `/build` to scan) and gives each task a dedicated, scoped detail file (cheap for `/build` to load one at a time). See § Effort File Lifecycle below for the full file model.

Per-task file template:

```markdown
# Task 00N: [Short descriptive title]

**Description:** One paragraph explaining what this task accomplishes.

**Acceptance criteria:**
- [ ] [Specific, testable condition]
- [ ] [Specific, testable condition]

**Verification:**
- [ ] Tests pass (quiet run; see `.opencode/harness/rules/verification-commands.md`)
- [ ] Build succeeds
- [ ] Manual check: [description of what to verify]

**Dependencies:** [Task numbers this depends on, or "None"]

**Files likely touched:**
- `src/path/to/file.ts`
- `tests/path/to/test.ts`

**Docs:**
- Gotchas discovered → default to a `/** GOTCHA */` comment in the code next to the trap; use `docs/gotchas.md#gN` only when there's no code home. AGENTS.md gets at most a one-line index pointer — never the full text.

**Estimated scope:** [Small: 1-2 files | Medium: 3-5 files | Large: 5+ files]
```

### Step 5: Order and Checkpoint

Arrange tasks so that:

1. Dependencies are satisfied (build foundation first)
2. Each task leaves the system in a working state
3. Verification checkpoints occur after every 2-3 tasks
4. High-risk tasks are early (fail fast)

Add explicit checkpoints:

```markdown
## Checkpoint: After Tasks 1-3
- [ ] All tests pass
- [ ] Application builds without errors
- [ ] Core user flow works end-to-end
- [ ] Review with human before proceeding
```

## Task Sizing Guidelines

| Size | Files | Scope | Example |
| :--- | :--- | :--- | :--- |
| **XS** | 1 | Single function or config change | Add a validation rule |
| **S** | 1-2 | One component or endpoint | Add a new API endpoint |
| **M** | 3-5 | One feature slice | User registration flow |
| **L** | 5-8 | Multi-component feature | Search with filtering and pagination |
| **XL** | 8+ | **Too large — break it down further** | — |

If a task is L or larger, it should be broken into smaller tasks. An agent performs best on S and M tasks.

**When to break a task down further:**
- It would take more than one focused session (roughly 2+ hours of agent work)
- You cannot describe the acceptance criteria in 3 or fewer bullet points
- It touches two or more independent subsystems (e.g., auth and billing)
- You find yourself writing "and" in the task title (a sign it is two tasks)

## Plan Document Template

The plan is a **thin index**, not a thick document. Per-task detail (acceptance, files, verify, dependencies) lives in `tasks/00N-<task-slug>.md` files (see Step 4 above). The plan just lists tasks in order, names the architecture decisions, and marks the checkpoints.

Save to `docs/specs/<effort-slug>/plan.md`:

```markdown
# Plan: [Effort Name]

## Overview
[One paragraph summary of what we're building]

## Architecture Decisions
- [Key decision 1 and rationale]
- [Key decision 2 and rationale]

## Task Index

### Phase 1: Foundation
- [ ] Task 1: [title] → `tasks/001-<slug>.md`
- [ ] Task 2: [title] → `tasks/002-<slug>.md`

### Checkpoint: Foundation
- [ ] Tests pass, builds clean

### Phase 2: Core Features
- [ ] Task 3: [title] → `tasks/003-<slug>.md`
- [ ] Task 4: [title] → `tasks/004-<slug>.md`

### Checkpoint: Core Features
- [ ] End-to-end flow works

### Phase 3: Polish
- [ ] Task 5: [title] → `tasks/005-<slug>.md`
- [ ] Task 6: [title] → `tasks/006-<slug>.md`

### Checkpoint: Complete
- [ ] All acceptance criteria met
- [ ] Ready for review

## Risks and Mitigations
| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| [Risk] | [High/Med/Low] | [Strategy] |

## Open Questions
- [Question needing human input]
```

The matching flat checkbox list — one line per task, mirroring the index above — lives in `docs/specs/<effort-slug>/todo.md` and is the **single status source** the project resumes from.

## Effort File Lifecycle

### Mental model: four files, four jobs

One effort = one branch = one directory at `docs/specs/<effort-slug>/`. Inside that directory, four files do four distinct jobs. **The split exists so each file stays thin** — a thick plan bloats every `/build` step that has to read it.

| File                          | Metaphor                    | Answers                              | Goes in                                                       | Does NOT go in                                  |
| ----------------------------- | --------------------------- | ------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------- |
| `spec.md`                       | **Destination**                 | What does done look like?            | Problem, user, success criteria, out-of-scope, open questions | Implementation detail, task lists, file paths    |
| `plan.md`                       | **Route** (outline)            | What are the major steps in order?   | Approach, architecture decisions, task *index*, checkpoints, risks | Per-task acceptance criteria, file lists, verify steps |
| `todo.md`                       | **Progress**                    | Which steps are checked off?         | One checkbox per task, mirroring the plan's task index        | Anything that isn't a checkbox                    |
| `tasks/00N-<slug>.md`           | **Turn-by-turn directions**     | What exactly does this one step entail? | Per-task acceptance, files to touch, verification, dependencies | Anything about other tasks                        |

If you find yourself writing acceptance criteria or file lists inside `plan.md`, stop — that content belongs in the corresponding `tasks/00N-*.md` file. The plan is the outline; the task files are the body.

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
```

The `<effort-slug>` is the branch name and the directory name — pick once, use consistently. Use clean slugs (no numeric prefix); order is reconstructed from git history or a `docs/specs/README.md` index if you want one.

### Scope: not every change needs an effort directory

This flow is for **non-trivial work** — anything that benefits from written acceptance criteria before code. Trivial fixes (typos, one-line bugs, obvious single-file changes) go directly on a branch with no `docs/specs/<slug>/` entry; the harness flow is overhead for them. See `spec-driven-development`'s "When NOT to use" for the boundary.

### Status lifecycle (no archive, no move)

`spec.md` carries a `status` field in its frontmatter that tracks the effort's phase. **Nothing moves when the status changes** — the directory stays at `docs/specs/<slug>/` forever.

```
draft  ──→  active  ──→  shipped
                              ↘
                               abandoned   (branch deleted before shipping)
```

- `draft` — `/spec` wrote it; user is reviewing or refining.
- `active` — `/build` is executing the approved plan.
- `shipped` — PR merged to main. The merge commit flips the status and records the shipped date.
- `abandoned` — effort stopped before shipping. Either the branch was deleted (the directory never reached main) or, if it landed on main, the status is flipped explicitly so it's not mistaken for active work.

`docs/specs/` accumulates shipped and abandoned efforts alongside active ones. Git is the history; the filesystem is the index.

### When the effort ships

When the plan's checkpoint passes and the PR merges to main, the merge commit:

1. Flips `spec.md` frontmatter: `status: shipped`, plus `shipped: YYYY-MM-DD`.
2. Leaves the directory in place. **Do not move, rename, or delete it.**

There is no `archive/` directory. Past efforts are browsed by `ls docs/specs/` (current state) or `git log` (full history).

### Carry-over between efforts

If a new effort depends on decisions from a prior one, **link the prior effort's PR or merge SHA** from the new `spec.md`'s "Architecture Decisions" or "Open Questions" section. Don't copy or re-read the prior effort's files — they're history to point at, not context to routinely load.

For cross-cutting decisions that span multiple efforts, write an ADR (see `documentation-and-adrs`) at `docs/adrs/`. ADRs are the permanent record; effort specs are the per-effort record.

The same linking discipline applies to the always-loaded rules file (AGENTS.md): each effort adds **at most a one-line index pointer** for new gotchas (linking to `docs/gotchas.md#gN` or an inline code comment), never the full detail. The rules file is linked-to, not pasted-into, per milestone — otherwise it grows linearly and never trims.

### After shipping: start the next effort

A new effort starts on a fresh branch with a fresh `docs/specs/<slug>/` directory:

1. `git checkout -b <new-effort-slug>`
2. `/spec` writes the new `docs/specs/<new-effort-slug>/spec.md` (status: `draft`).
3. `/planning` generates `plan.md`, `todo.md`, and `tasks/*`.
4. `/build` executes.

The presence of prior shipped directories in `docs/specs/` is irrelevant to the new effort — `/spec` always writes to a new directory, `/build` always reads from the current branch's directory.

### `/build`'s safety net

`/build auto` requires an active spec at `docs/specs/<effort-slug>/spec.md`. If no such directory exists on the current branch, it stops and asks the user to run `/spec` first — that's the intended safety net, not a failure. `/build` (single-task mode) is less strict: it operates on whatever `todo.md` is present, useful for small focused work that skipped the spec flow.

## Parallelization Opportunities

When multiple agents or sessions are available:

- **Safe to parallelize:** Independent feature slices, tests for already-implemented features, documentation
- **Must be sequential:** Database migrations, shared state changes, dependency chains
- **Needs coordination:** Features that share an API contract (define the contract first, then parallelize)

## Common Rationalizations

| Rationalization | Reality |
| :--- | :--- |
| "I'll figure it out as I go" | That's how you end up with a tangled mess and rework. 10 minutes of planning saves hours. |
| "The tasks are obvious" | Write them down anyway. Explicit tasks surface hidden dependencies and forgotten edge cases. |
| "Planning is overhead" | Planning is the task. Implementation without a plan is just typing. |
| "I can hold it all in my head" | Context windows are finite. Written plans survive session boundaries and compaction. |
| "One plan per project" | One directory per effort. Effort-scoped plans keep the active files small and every `/build` step cheap. Past efforts stay in `docs/specs/` as shipped; the next effort starts fresh on its own branch. |
| "Put everything in one big plan" | A thick plan bloats every `/build` step that reads it. Keep `plan.md` a thin index; put per-task detail in `tasks/00N-*.md` files. |

## Red Flags

- Starting implementation without a written task list
- Tasks that say "implement the feature" without acceptance criteria
- No verification steps in the plan
- All tasks are XL-sized
- No checkpoints between tasks
- Dependency order isn't considered
- `plan.md` growing thick with per-task detail (acceptance criteria, file lists) — that content belongs in `tasks/00N-*.md`, not the plan index
- An effort's `spec.md` left at `status: draft` or `status: active` after the PR merged — flip to `shipped` in the merge commit

## Verification

Before starting implementation, confirm:

- [ ] Every task has a corresponding `tasks/00N-<slug>.md` file with acceptance criteria
- [ ] Every task file has a verification step
- [ ] Task dependencies are identified and ordered correctly
- [ ] No task touches more than ~5 files
- [ ] Checkpoints exist between major phases
- [ ] The human has reviewed and approved the plan
- [ ] `plan.md` is a thin index (overview + decisions + task pointers + checkpoints + risks), not a thick document
- [ ] If the effort has shipped, `spec.md` frontmatter reads `status: shipped` with the merge date; new efforts start on fresh branches

Acceptance criteria are per-task and answer "did we build the right thing?". They sit on top of the project-wide Definition of Done, the standing bar every task clears before it counts as done. See `@rules/definition-of-done.md`.
