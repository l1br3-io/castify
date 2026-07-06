# Comments

Comments are not inherently good — they are a confession that the code
could not express itself. The first move is always to make the code
clearer so the comment becomes unnecessary. When a comment is genuinely
the best tool, make it count.

## The Prime Directive

> **Clear code over clever comments.** A comment that explains *what* the
> code does is redundant; the code already says it. A comment that
> explains *why* the code exists is the only kind worth keeping — and
> even then, only when the code cannot.

```text
BAD:    // increment i by 1
        i = i + 1

BAD:    // check if employee is eligible for full benefits
        if (employee.flags & HOURLY_FLAG && employee.age > 65)
GOOD:   if (employee.isEligibleForFullBenefits())   // no comment needed
```

## Good Comments

Use a comment when the code genuinely cannot carry the meaning:

- **Intent** — explain *why* a non-obvious decision was made, especially
  when it overrides a more obvious-looking choice.
- **Warning of consequences** — "do not run this unless the DB has been
  backed up; it mutates the ledger".
- **TODOs** — a deliberate marker for work that is known to be incomplete.
  Keep them actionable: `// TODO(name): handle retry after 2024-Q3 spec`.
- **Public API documentation** — the contract a caller relies on: types,
  invariants, errors thrown, side effects.
- **Clarification** of a complex, irreducibly tricky expression (after
  you have tried every other way to simplify it).
- **Legal** headers where mandated.
- **Amplification** — drawing attention to something that looks trivial
  but matters: "this empty catch is intentional; the upstream retries".

## Bad Comments — Avoid These

- **Mumbling** — a comment that doesn't say enough to justify its
  existence. If the reader has to read the code to understand the
  comment, delete it.
- **Redundant** — restating what the code already says clearly.
- **Misleading** — a comment that drifts out of sync with the code. A
  wrong comment is worse than no comment; it actively lies.
- **Mandated** — headers on every function ("// getter for name") that
  add noise without value. Mandates do not produce good comments.
- **Journal comments** — the code is version-controlled; remove the
  changelog block.
- **Noise** — `////////////// init //////////////` and similar decoration.
- **Commented-out code** — delete it. `git` remembers. Commented-out code
  rots silently and confuses every reader about what is live.
- **Position markers** (`//// SECTION ////`) — extract a function or type
  instead; the name carries the meaning.
- **Closing-brace comments** (`} // end for`) — if you need them, the
  block is too long or too nested. Refactor.
- **Nonlocal information** — a comment that describes code elsewhere. Put
  the comment next to the thing it describes.
- **Over-attribution** — author tags, signed comments, attribution by
  hand. The blame view carries this; do not duplicate it in the source.

## Comment Hygiene

- **Keep them current.** A comment is part of the code; when you change
  the code, update or delete the comment in the same commit.
- **Local, not distant.** A comment describes the lines it touches.
- **Precise.** Ambiguity in a comment is a bug waiting to happen — say
  exactly what you mean, or delete it.

## The Honest Test

Before writing a comment, ask: *can I rename a symbol, extract a
function, or introduce an explanatory variable that makes this comment
unnecessary?* Almost always, the answer is yes — and the result is code
that is clearer in every reader's editor, not just the one who reads the
comment.
