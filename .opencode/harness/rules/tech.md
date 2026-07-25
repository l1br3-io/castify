## Tech

Conventions are loaded lazily — this file is the router, not the content.
BEFORE writing or modifying code in a stack below, Read the matching files:

- `rust` → `.opencode/harness/tech/rust/*.md` + `.opencode/harness/tech/common/*.md`
- `typescript` → `.opencode/harness/tech/typescript/*.md` + `.opencode/harness/tech/common/*.md`
- `react` → `.opencode/harness/tech/react/*.md` + `.opencode/harness/tech/common/*.md`

Polyglot: when a task spans multiple stacks, load each stack's conventions and
apply each to its own code. Do not mix conventions across boundaries.

Other folders under `.opencode/harness/tech/` stay dormant — add them above to
activate. Run the `init-tech-declaration` skill to detect and declare stacks.
