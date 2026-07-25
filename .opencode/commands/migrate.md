---
description: Relocate a legacy harness layout to the current one — dry-run plan, then apply, then validate. One command, no hand-edits
---

# /migrate

Upgrades a project stuck on an older harness layout to the current one. The
deterministic engine (`install.py migrate`) owns the moves; this command
orchestrates **plan → approval → apply → validate** so nothing is hand-edited.

## When to run

- `.opencode/rules/` or `.opencode/tech/` exist (they moved under
  `.opencode/harness/`).
- The config `instructions` still points at `.opencode/rules/tech.md`.
- After pulling a harness update that changed layout — run `/migrate` to catch
  up, then `/adopt` to reconcile.

If `.opencode/harness/` is already present and no `.opencode/{rules,tech}/`
remain, there's nothing to do — say so and stop.

## What it preserves

The engine never deletes files that aren't its own legacy orphans:

- `AGENTS.md` — untouched (reconcile separately via `/adopt`).
- Custom commands/skills/agents you authored — kept (no `--delete` semantics).
- `.opencode/{node_modules,package.json,package-lock.json,bun.lock,.gitignore}`
  and every key in your opencode config (MCP servers, etc.) — preserved
  verbatim. Only the `instructions` tech-router path is rewritten.

## Steps

1. **Plan (read-only).** Run the engine dry-run and show the user the
   file-by-file plan (MOVE / DELETE / ADD / UPDATE / EDIT / PORT / PRESERVE):
   ```
   python3 install.py migrate --from <harness-repo-or-clone> --dry-run
   ```
   Surface any **unmapped stacks** (listed in the old `tech.md` but with no
   matching `tech/<name>/` dir upstream) — these are skipped from the router
   and flagged for the user.

2. **Guard.** The working tree should be clean (commit or stash first) so the
   move is reviewable and reversible. Refuse to apply on a dirty tree unless
   the user explicitly accepts the risk.

3. **Approve.** Get explicit confirmation. Do not apply on the user's behalf
   from a dry-run alone.

4. **Apply.**
   ```
   python3 install.py migrate --from <harness-repo-or-clone> --force
   ```
   The engine relocates `rules/` + `tech/` under `harness/`, removes the
   legacy orphans, syncs `agents/`/`commands/`/`skills/` to the source,
   rewrites the config path, ports the tech router stacks deterministically,
   and records the migration in `.opencode/harness/harness.json`.

5. **Validate.** Run the harness's own gates:
   ```
   python3 install.py migrate --check
   python3 .opencode/harness/scripts/check-refs.py
   python3 .opencode/harness/scripts/lint-frontmatter.py
   ```
   `migrate --check` asserts no legacy dirs remain and the config path is
   current; exit code is the verdict.

6. **Hand off.** Remind the user to **restart opencode** (config loads once at
   startup), then suggest `/adopt` to reconcile `AGENTS.md` and verify the tech
   router is active. If stacks were unmapped, run `init-tech-declaration` (or
   `/adopt`) to detect and add them.

## Notes

- **Idempotent.** Re-running is a no-op once the legacy markers are gone.
- **Not a substitute for `/adopt`.** `/migrate` fixes layout; `/adopt` wires
  config + scaffolds the agent map. Run migrate first, then adopt.
