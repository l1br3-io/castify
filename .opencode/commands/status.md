---
description: Snapshot of project state — milestone, task progress, resume notes, working tree, with the next task front and center. Add "verify" to also run cargo test + build.
---

# /status

Produce a read-only snapshot of where the Castify project is right now. The
**next task** is the hero of the output — everything else is context for it.

## Modes

- `/status` — parse docs + git only. Fast (~1s). Default.
- `/status verify` — additionally run `cargo test`, `cargo check`, and the
  frontend build. Slower, but exposes stale "done" checkboxes. Treat `verify`
  (canonical) as the verify mode; anything else (or empty) is the default.

## What to read, in order

1. `docs/ROADMAP.md` → identify the **current milestone** (the one whose tasks are
   in flight) and its theme, for the headline.
2. `tasks/todo.md` → the live checklist:
   - The first `[ ]` task is **the next task** — promote it to the top.
   - Count `[x]` vs total to get progress and the current phase.
   - Note checkpoint states (✅/⬜).
   - If every task is checked, the milestone is complete — say so and point
     at `docs/ROADMAP.md` for the next milestone instead of printing a next task.
3. `tasks/plan.md` → two things:
   - The "Resuming" section (as-of state, completed work, deviations) —
     summarized, not copy-pasted. Mention the deviation count explicitly so
     the reader knows to consult the file before continuing.
   - The next task's full entry (the one matched in step 2) for its detail
     line and dependencies.
4. `docs/prds/<current-milestone>.md` → confirm the milestone name only; do
   not regurgitate the PRD.
5. `git status --porcelain` → working-tree cleanliness.
6. `git log --oneline -1` → the most recent commit only (last hash + subject).

## Output template

```markdown
## Castify status — <M# Milestone> (<theme>)

### ▶ Next task
**<T#> — <title>**
<one-line description from tasks/plan.md>

**To proceed:** `/build`        **Re-plan:** `/planning`

---

### Progress
- Tasks: <done>/<total> done — <Phase #> (<phase name>)
- Checkpoints: A <✅/⬜>  B <✅/⬜>  C <✅/⬜>  D <✅/⬜>

### Resume notes (from tasks/plan.md)
- <as-of line>
- <N> deviations on record — read before continuing.

### Working tree
- <clean | N uncommitted files>
- last: <hash> <subject>
```

When `/status verify` is invoked, append a `### Verification` block after the
template with a one-line pass/fail for each command:

```markdown
### Verification
- `cargo check --workspace`: ✅
- `cargo test --workspace`: ✅ (N tests)
- `npm run build` (frontend): ✅
```

## Rules

1. **Read-only.** Never edit files, never commit, never push. `/status`
   observes and reports.
2. **The next task leads.** If the output had to be one line, it would be the
   next task's title and the `/build` suggestion. Everything else is
   supporting context.
3. **Graceful degradation.** If `tasks/plan.md` has no "Resuming" section,
   skip that block. If `tasks/todo.md` has no pending task, replace the
   Next-task block with a milestone-complete notice pointing at
   `docs/ROADMAP.md`. Never error out on a missing file — note it and continue.
4. **Verify never blocks.** If a verify-mode command fails, report the
   failure inline; do not abort the snapshot. Failures are signal, not
   exceptions.
5. **No speculation.** If a source is ambiguous (e.g. two milestones look
   in-flight), say so and ask the user rather than guessing the next task.
6. **Suggested next action is always the footer of the Next-task block:**
   `/build` to implement, or `/planning` to re-plan. Nothing else.
