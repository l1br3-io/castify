# Coding Style

This file is a **thin index**. Coding-style concerns are decomposed into
single-concern baseline files below — each small, reusable, and referenced
independently by language-specific tech. Restate none of them; link to them.

> **For a quick checklist before marking work complete**, see the
> consolidated Code Quality Checklist in `code-review.md`.

## Baseline files (apply universally)

| Concern            | File                                                              | Covers                                                                                          |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Meta-principles    | `principles.md`                                    | Boy Scout, Broken Windows, KISS/DRY/YAGNI, Least Surprise, Command-Query Separation, Law of Demeter, emergence, immutability |
| Naming             | `naming.md`                                            | Intention-revealing names, no encodings, one-word-per-concept, noun/verb phrasing, scope↔length |
| Functions          | `functions.md`                                     | Small, do-one-thing, one abstraction level, argument count, no flag args, no side effects       |
| Formatting         | `formatting.md`                                    | Vertical/horizontal formatting, newspaper metaphor, many-small-files, domain file org          |
| Comments           | `comments.md`                                        | Self-documenting code first; good vs bad comments                                              |
| Error handling     | `error-handling.md`                            | Exceptions over return codes, never return/pass null, boundary wrapping, fail-fast validation  |
| Code smells        | `code-smells.md`                                  | Heuristics catalog: deep nesting, magic numbers, duplication, dead code, feature envy, ...     |

Adjacent common rules remain in their own files:
`testing.md` (F.I.R.S.T.),
`patterns.md` (SRP, DI, boundaries, repository),
`security.md`.

## How language-specific tech composes

A language-specific `<name>/coding-style.md` does **not** restate these
baselines. It declares which are RELEVANT and then adds only the
language-specific deltas (tooling, idioms, conventions). See the
"Composition" section of `../README.md` and the example in
`../rust/coding-style.md`.

## Rule priority

When a baseline principle and a language idiom appear to conflict, the
idiom usually expresses the *same* principle in a different shape —
resolve in favor of idiomatic clarity. Specific overrides general; see
`../README.md`.
