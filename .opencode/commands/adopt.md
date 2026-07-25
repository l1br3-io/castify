---
description: Adopt the harness into a project — detect tech, wire config, scaffold the agent map. Run once on setup, re-run as a health check
---

# /adopt

The front door. Bring the harness into a project (or reconcile an existing
setup), then hand off to `/spec`. Idempotent — safe to re-run; it fills gaps
and reports drift rather than overwriting.

## What it reconciles

Fill each, never silently overwrite (the `init-tech-declaration` rule: show a
diff first):

1. **Tech router** — via `init-tech-declaration` (detect →
   `.opencode/harness/rules/tech.md` router). Injected into every session.
2. **Config wiring** — `instructions` must include the tech router path.
   The skill owns the config filename variants and preserves other keys.
3. **Agent map** — scaffold `AGENTS.md` from
   `.opencode/skills/init-tech-declaration/AGENTS.template.md`
   ([agents.md](https://agents.md/) standard), kept as a lean index (see
   `context-engineering` § Rules File Lifecycle).

## AGENTS.md handling (non-destructive)

- **Absent** → scaffold a project map from the template; fill the
  `<PLACEHOLDER>`s by asking the user for the project name, build/test/lint
  commands, and boundaries.
- **Present + matches the stock-harness signature** (H1 `# OpenCode Agent
  Harness` together with the phrase `no multi-harness fragmentation`) → it's
  the harness's own map, not this project's. Offer to replace it with a
  project map; show the diff; write only on explicit confirmation.
- **Present + already customized** → preserve it. Note any missing
  agents.md-standard sections; do not rewrite.

## Steps

1. **Legacy layout check.** Two relocations have happened — detect both and
   delegate to the deterministic engine (`install.py migrate`) rather than
   moving files by hand. Show what will change; write only on confirmation.
   - **Pre-0.1** — harness folders at the project root (`agents/`,
     `commands/`, `skills/` instead of under `.opencode/`): offer to move them
     under `.opencode/` and fix root-relative references.
   - **Pre-harness-tree** — `rules/` or `tech/` at the `.opencode/` root
     instead of under `.opencode/harness/` (the 0.1 layout move): run
     `python3 install.py migrate --from <this-repo> --dry-run`, show the plan,
     and on approval apply it (add `--force`). The engine relocates the dirs,
     removes the legacy orphans, fixes the config path, ports the tech router,
     and writes the manifest. Do **not** relocate these by hand.
   If `.opencode/` already has the modern layout (`harness/rules/` present, no
   `.opencode/rules/`), skip.
2. **Guard.** Confirm `.opencode/` has the harness folders (`agents/`,
   `commands/`, `skills/`, `harness/rules/`). If not, stop — `/adopt`
   configures an *existing* harness, it doesn't fetch one. Point the user to
   the installer: `python3 install.py install` (or see README § Quick start).
3. **Tech + config.** Run `init-tech-declaration` (detect-tech →
   `.opencode/harness/rules/tech.md` router → config `instructions` wiring),
   following its diff-first rule.
4. **Agent map.** Reconcile `AGENTS.md` per the handling above.
5. **Health summary.** Collect the `init-tech-declaration` report, then add:
   - `AGENTS.md` status (absent / stock-harness / customized).
   - Manifest: if `.opencode/harness/harness.json` exists, show installed
     version and whether an update is available. Note that `install.py` is the
     *installer* — it lives in the harness source repo, not under `.opencode/`,
      so it is never copied into downstream projects; to run `update`/`status`,
      invoke it by absolute path with the project as cwd, e.g.
     `python3 /path/to/opencode-agent-harness/install.py status`. A version of
     `local` only means it was installed from a local clone (`--from <dir>`)
     rather than a GitHub tag — it is not an error. If the manifest is absent,
     it wasn't written (manual install); the manifest enables
     `install.py update`/`status`.
6. **Post-adopt verification.** Remind the user to restart opencode (config
   loads once at startup), then in a new session verify the router is active:
   ask "what tech conventions should I load?" — the agent should cite the
   stacks from `.opencode/harness/rules/tech.md`.
7. **Hand off.** Suggest `/spec` to define what to build, or `/planning` if a
   spec already exists. Run `python3 .opencode/harness/scripts/check-refs.py`
   if any `.md` was added or moved.
