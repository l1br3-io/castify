---
name: init-tech-declaration
description: Detects the project's tech and writes a `rules/tech.md` file so
  future sessions skip runtime detection. Run once when adopting the harness,
  and again whenever the tech changes. Triggers on "init tech", "declare my
  tech", "refresh tech declaration".
---

# Init Tech Declaration

Generates or refreshes `rules/tech.md` — the single source of truth for the
project's tech. This file is injected into the system prompt via `opencode.json`
`instructions` and survives compaction.

## When to Use

- First time adopting this harness on a project
- Adding or removing a tech (e.g. new frontend, dropped service)
- Drift detected ("declaration says rust, but .py files are being edited")
- Major refactor that restructured directories

## Steps

1. Run detect-tech.md (manifest glob + proximity, Steps 1–3) from this skill's
   directory: `Read skills/init-tech-declaration/detect-tech.md`.
2. Map detected tech to dir names (e.g. `Cargo.toml` → `rust`, `package.json`
   with `react` dep → `react`). JS/TS framework detection is inlined in
   detect-tech.md; non-JS/TS uses the manifest → tech-dir table inlined there.
3. Write the result to `rules/tech.md`:
   ```
   ## Tech
   - rust
   - typescript
   - react
   ```
4. If AGENTS.md has no `instructions` block, add one:
   ```json
   "instructions": ["rules/tech.md"]
   ```
5. Show the user a diff before writing. Do not silently modify files.
6. Report which tech dirs load next session, and any that have no
   corresponding `tech/<dir>/`.

## Output

A `rules/tech.md` file. Example:

```markdown
## Tech
- rust
- react
```

And a `"instructions": ["rules/tech.md"]` entry in `opencode.json`.

## Notes

- Safe to re-run; idempotent.
- If detection finds nothing recognizable, write `## Tech` with only `common`
  and warn the user.
- The detection machinery (`detect-tech.md`) is a tool, not a runtime step.
