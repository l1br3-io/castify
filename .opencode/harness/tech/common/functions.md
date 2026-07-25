# Functions

Functions are the primary unit of behavior. The rules below make them
small, focused, and honest — easy to read, test, and change. They apply
to free functions, methods, and closures alike; a language-specific file
shows the idiomatic shape.

## The First Rule: Small

Functions should be **small** — roughly 20 lines as a soft ceiling, and
shorter is better. The reasons are mechanical: a small function is easy
to hold in working memory, easy to name, easy to test, and easy to
extract when reused.

> A language-specific file may relax this where the idiom demands it
> (long match arms, generated code), but the default is small.

## Do One Thing

A function should do **one thing** — one level of abstraction below its
name. To check: can you extract a sub-function with a descriptive name
that is not merely a restatement of the original? If yes, the original
was doing more than one thing.

Sections within a function that follow Section Headers (`// VALIDATION`,
`// PERSIST`) are a smell: each is a candidate function.

## One Level of Abstraction

Mixing high-level calls (`renderPage()`) with low-level details
(`\n`.join(...)`) in the same body forces the reader to jump between
mental modes. Keep a function at a single level — descend one level per
function call, not within the function body.

## The Stepdown Rule

Code should read top-to-bottom like a narrative: each function is
followed by the next level of implementation beneath it. The reader
descends one level of abstraction at a time, never forced to jump.

## Descriptive Names

A long, descriptive name beats a short, cryptic one. Use a verb phrase
that describes exactly what the function does — including side effects. If a function is hard to name, it is
probably doing more than one thing.

## Function Arguments

The ideal argument count is **zero**. Each argument raises the cognitive
and testing cost.

| Args   | Verdict                                                |
| ------ | ------------------------------------------------------ |
| 0      | Ideal.                                                 |
| 1      | Fine — `transform(x)`, `assert(condition, message)`.   |
| 2      | Acceptable — e.g. `copy(src, dst)`, `point(x, y)`.     |
| 3      | Questionable — justify it, or wrap into a value object. |
| 4+     | Almost always wrong — refactor into a parameter object. |

### No Flag Arguments

A boolean flag signals the function does **two** things — one per branch.
This is two functions in disguise:

```text
BAD:   render(page, true)   // true = ... what exactly?
GOOD:  renderForScreen(page) / renderForPrint(page)
```

### Output Arguments

Avoid arguments used to return values. If a function must change
something, change the object it is called *on*, or return a new value.
Output arguments force the reader to inspect the signature to understand
the call site.

## No Side Effects

A function promises to do what its name says — nothing more. If
`checkPassword(user, pw)` also initializes a session, it is lying. Side
effects create **temporal couplings** the caller cannot see at the call
site. If a side effect is genuine, put it in the name and prefer the
command-query separation discipline.

## Prefer Exceptions to Error Codes

Returning an error code mixes the happy path with control flow and tempts
the caller to ignore the result. Prefer the language's idiomatic
signaling mechanism (exceptions, `Result`/`Either`, errors-as-values)
which keeps the happy path linear.

> Define errors in terms of the **caller's** needs, not the implementation's.
> Callers care about *whether* they can recover, not *which* line of yours
> threw.

## Prefer Polymorphism Over Switch-by-Type

Avoid `switch`/`if-else` chains that dispatch on a type tag. They scatter
new-branch logic across every function that touches the type. Prefer
polymorphism (a method per type) so that adding a type requires only one
new implementation, not edits to every dispatcher.

## Refactor Ruthlessly

Functions are never right the first time. Write them long, then split;
extract until each does one thing; rename until each name is honest. The
emergent-design rules hold throughout: keep tests green, remove
duplication, express intent, minimize.
