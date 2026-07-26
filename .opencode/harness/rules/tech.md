## Tech

Conventions are loaded lazily — this file is the router, not the content.
BEFORE writing or modifying code in a stack below, Read the matching files:

- `python` → `.opencode/harness/tech/python/*.md` + `.opencode/harness/tech/common/*.md`
- `react` → `.opencode/harness/tech/react/*.md` + `.opencode/harness/tech/common/*.md`

Polyglot: when a task spans multiple stacks, load each stack's conventions and
apply each to its own code. Do not mix conventions across boundaries.

Other folders under `.opencode/harness/tech/` stay dormant — add them above to
activate. Run the `init-tech-declaration` skill to detect and declare stacks.
