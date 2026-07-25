---
name: init-tech-declaration
description: Detects the project's tech and writes a `.opencode/harness/rules/tech.md`
  router so future sessions skip runtime detection and lazy-load the right conventions.
  Run once when adopting the harness, and again whenever the tech changes. Triggers on
  "init tech", "declare my tech", "refresh tech declaration".
---

# Init Tech Declaration

Generates or refreshes `.opencode/harness/rules/tech.md` — the lazy-load router
for the project's tech conventions. This file is injected into every session via
the config `instructions` array and survives compaction.

## When to Use

- First time adopting this harness on a project
- Adding or removing a tech (e.g. new frontend, dropped service)
- Drift detected ("router says rust, but .py files are being edited")
- Major refactor that restructured directories

## Steps

1. Run detect-tech.md (manifest glob + proximity, Steps 1–3) from this skill's
   directory: `Read .opencode/skills/init-tech-declaration/detect-tech.md`.
2. Map detected tech to dir names (e.g. `Cargo.toml` → `rust`, `package.json`
   with `react` dep → `react`). JS/TS framework detection is inlined in
   detect-tech.md; non-JS/TS uses the manifest → tech-dir table inlined there.
   When a framework is detected inside a language (e.g. FastAPI in Python),
   record it as a hint: `python (fastapi)`.
3. Write the result to `.opencode/harness/rules/tech.md` as a **lazy-load
   router** — each entry tells the agent which files to Read before writing
   code in that stack:
   ```
   ## Tech

   Conventions are loaded lazily — this file is the router, not the content.
   BEFORE writing or modifying code in a stack below, Read the matching files:

   - `rust` → `.opencode/harness/tech/rust/*.md` + `.opencode/harness/tech/common/*.md`
   - `python (fastapi)` → `.opencode/harness/tech/python/*.md` + `.opencode/harness/tech/common/*.md`
   - `react` → `.opencode/harness/tech/react/*.md` + `.opencode/harness/tech/common/*.md`

   Polyglot: when a task spans multiple stacks, load each stack's conventions and
   apply each to its own code. Do not mix conventions across boundaries.

   Other folders under `.opencode/harness/tech/` stay dormant — add them above to
   activate. Run the `init-tech-declaration` skill to detect and declare stacks.
   ```
4. Ensure the config file wires `tech.md` into `instructions`. Check for any of
   these filenames in the project root (first match wins): `opencode.json`,
   `opencode.jsonc`, `.opencode.jsonc`. If the config file exists but has no
   `instructions` key (or `instructions` does not include the tech.md path),
   add `.opencode/harness/rules/tech.md` to the array — preserve every other
   key. If no config file exists, create `.opencode.jsonc`:
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "instructions": [".opencode/harness/rules/tech.md"]
   }
   ```
5. **Opt-in always-load (single-stack only).** If the project uses exactly one
   tech stack, ask the user whether to also load that stack's conventions into
   every session via `instructions` globs (trades context budget for guaranteed
   enforcement). If yes, append the stack's glob:
   ```jsonc
   "instructions": [
     ".opencode/harness/rules/tech.md",
     ".opencode/harness/tech/rust/*.md",
     ".opencode/harness/tech/common/*.md"
   ]
   ```
   For polyglot projects, skip this — the lazy router is the right default.
6. Show the user a diff before writing. Do not silently modify files.
7. Report: which tech dirs exist vs missing (missing → falls back to `common/`);
   config wiring status; whether always-load was applied.

## Output

A `.opencode/harness/rules/tech.md` router file + an `instructions` entry in the
config. Example router for a Rust + React monorepo:

```markdown
## Tech

Conventions are loaded lazily — this file is the router, not the content.
BEFORE writing or modifying code in a stack below, Read the matching files:

- `rust` → `.opencode/harness/tech/rust/*.md` + `.opencode/harness/tech/common/*.md`
- `react` → `.opencode/harness/tech/react/*.md` + `.opencode/harness/tech/common/*.md`

Polyglot: when a task spans multiple stacks, load each stack's conventions and
apply each to its own code. Do not mix conventions across boundaries.

Other folders under `.opencode/harness/tech/` stay dormant — add them above to
activate. Run the `init-tech-declaration` skill to detect and declare stacks.
```

## Notes

- Safe to re-run; idempotent.
- If detection finds nothing recognizable, write a router with only `common`
  and warn the user.
- The detection machinery (`detect-tech.md`) is a tool, not a runtime step.
- The `/adopt` command orchestrates this skill as part of full harness setup;
  it also scaffolds a project `AGENTS.md` from `AGENTS.template.md` in this
  folder.
