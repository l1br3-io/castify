---
description: Break work into small verifiable tasks with acceptance criteria and dependency ordering
---

# /planning

Invoke the planning-and-task-breakdown skill.

Read the existing spec at `docs/specs/<effort-slug>/spec.md` and the relevant codebase sections. Then:

1. Enter plan mode — read only, no code changes
2. Identify the dependency graph between components
3. Slice work vertically (one complete path per task, not horizontal layers)
4. Write tasks with acceptance criteria and verification steps
5. Add checkpoints between phases
6. Present the plan for human review

Save outputs inside the effort directory:

- `docs/specs/<effort-slug>/plan.md` — thin index (overview, architecture decisions, task pointers, checkpoints, risks). See `planning-and-task-breakdown` § Plan Document Template.
- `docs/specs/<effort-slug>/todo.md` — flat checkbox list, one line per task (the single status source the project resumes from).
- `docs/specs/<effort-slug>/tasks/00N-<task-slug>.md` — one file per task, holding the acceptance criteria, files, verification step, and dependencies. This per-task split is what keeps `plan.md` thin.

If `plan.md` already exists for this effort and all its tasks are complete, the effort is done — open a PR. To start a new effort, create a fresh branch and run `/spec`. Do not archive or move files; past efforts stay in `docs/specs/` with their `spec.md` status flipped to `shipped` on merge. See `planning-and-task-breakdown` § Effort File Lifecycle.