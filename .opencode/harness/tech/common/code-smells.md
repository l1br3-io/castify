# Code Smells & Heuristics

A catalog of the recurring signs that code is harder to read or riskier
to change than it should be. Each entry is a *signal*, not an automatic
verdict — investigate before acting. The fix for most smells is a
rename, an extract, or a delete. Language-specific files note local
manifestations and the tooling (clippy, eslint, ruff) that catches them
automatically.

> **Language note**: Many of these are enforced by linters — see the tech
> dir's `coding-style.md` → **Verification** section. This file describes
> what to *recognize* by eye.

## Comments

- **Inappropriate information** — author tags, changelogs, TODOs without
  owners in the source.
- **Obsolete comments** — drifts that no longer match the code. Worse
  than no comment.
- **Redundant comments** — restating what the code already says clearly.
- **Commented-out code** — delete it; the VCS remembers.

## Functions

- **Too many arguments** — four or more almost always wants a parameter object.
- **Flag arguments** — a boolean that selects between two behaviors. Two
  functions in disguise.
- **Output arguments** — arguments used to return values. Return a value
  or change the object you're called on.
- **Dead functions** — no caller. Delete them; the VCS remembers.

## Names

- **Uncommunicative / ambiguous names** — `data`, `info`, `a1`, `theThing`.
- **Names at the wrong abstraction level** — a low-level mechanism name
  on a high-level concept, or vice versa.
- **Non-standard nomenclature** — reinventing a term the ecosystem
  already uses for the same idea.
- **Names that don't describe side effects** — `getUsers()` that mutates
  state lies.
- **Encodings** — type/scope prefixes baked into the name.

## General — by frequency

- **Duplication** — every copy is a latent bug. Extract when the
  duplication is real, not speculative (DRY).
- **Dead code** — unreachable branches, unused imports, shadowed
  variables. Remove them.
- **Deep nesting** — more than ~3 levels. Reach for early returns,
  guard clauses, or extraction.
- **Long functions** — past ~20 lines, suspect multiple responsibilities.
- **Magic numbers** — unnamed literals. Bind them to a named constant
  with a unit (`RETRY_LIMIT = 3`, `TIMEOUT_MS = 5_000`).
- **Inconsistency** — the same idea spelled three ways across the
  codebase. Pick one.
- **Code at the wrong level of abstraction** — a low-level mechanism
  leaking into a high-level policy, or a high-level concept buried in
  plumbing.
- **Feature envy** — a method more interested in another object's data
  than its own. Move the method.
- **Train wrecks** — `a.b().c().d()`. Encapsulate the navigation
  (Law of Demeter).
- **Selector / type arguments** — `doX(type, ...)` dispatching on a tag.
  Prefer polymorphism.
- **Obscured intent** — clever one-liners, dense expressions that need a
  comment to decode. Introduce an explanatory variable or extract a
  named helper.
- **Misplaced responsibility** — behavior living in the wrong type.
  Don't ask the `Money` object to format a receipt; don't ask the
  `Receipt` to round currency.
- **Artificial coupling** — code that depends on a module it has no real
  reason to touch, often to reuse one helper.
- **Hidden temporal coupling** — `initA()` must run before `initB()`, but
  nothing enforces it. Make the dependency physical: have `initB` take
  the result of `initA`.
- **Transitive navigation** — reaching through `a.b.c` to get at `d`.
  Ask for what you need directly.
- **Clutter** — unused variables, dead imports, commented scaffolding.
  Noise that obscures signal.

## Boundaries & Environment

- **Boundary errors leak through** — a third-party exception surfacing
  past a seam. Wrap at the boundary.
- **Build requires more than one step** — a setup that cannot be
  reproduced by a single command.
- **Tests require more than one step** — a test run that needs ceremony.
  Tests that are hard to run don't get run.

## Tests

- **Insufficient tests** — a behavior with no test is undefined behavior.
- **Skipped boundary conditions** — tests only the happy middle. Edge
  cases, empty, off-by-one, and saturation are where bugs live.
- **Ignored tests** — an `xit`/`@Ignore` is a question about ambiguity,
  not a permanent fixture.
- **Slow tests** — a slow suite is a suite that stops being run.

## Replace Magic with Named Constants

```text
BAD:   if status == 4          // what is 4?
GOOD:  if status == Status.DELETED
```

Every meaningful threshold, delay, limit, or code earns a name with its
unit. The only literals that don't are genuinely obvious (`0`, `1`, `""`
in a tight, local context).

## Structure Over Convention

Prefer to make the wrong thing impossible over making the right thing
conventional. An enum prevents the invalid value; a wrapper type
prevents the unit mix-up; a factory prevents the half-built instance.
When the structure forbids the bug, no one has to remember the rule.
