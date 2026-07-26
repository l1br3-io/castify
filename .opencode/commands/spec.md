---
description: Start spec-driven development — write a structured specification before writing code
---

# /spec

Invoke the spec-driven-development skill.

Begin by understanding what the user wants to build. Ask clarifying questions about:
1. The objective and target users
2. Core features and acceptance criteria
3. Tech stack preferences and constraints
4. Known boundaries (what to always do, ask first about, and never do)

Then generate a structured spec covering all six core areas: objective, commands, project structure, code style, testing strategy, and boundaries.

Save the spec to `docs/specs/<effort-slug>/spec.md` (create the directory). The `<effort-slug>` should match the branch name — pick it once, use it consistently as the branch name and the directory name. Use clean slugs (e.g. `auth-google-oauth`, `billing-refunds`); no numeric prefix.

Add frontmatter tracking the effort's lifecycle:

```yaml
---
status: draft        # draft → active → shipped (flipped by /build and on merge)
started: YYYY-MM-DD
---
```

Confirm with the user before proceeding.