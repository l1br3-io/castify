# Principles

The foundational, language-agnostic worldview. No syntax here — only the
meta-principles every tech dir builds on. Language-specific files refine
these with idioms, never contradict them.

> **Language note**: These are universal. A tech dir may show how a principle
> is expressed idiomatically, but the principle itself is never overridden.

## Professional Mindset

### The Boy Scout Rule

> "Leave the campground cleaner than you found it."

Every change should leave the code slightly better: rename a unclear
identifier, split a too-long function, remove a dead branch. Small,
continuous improvements prevent code rot and keep technical debt bounded.
A commit's diff need not be limited to its stated task — a tidy-up along
the way is expected, not optional.

### The Broken Windows Theory

One mess invites more. A single piece of dead code, an ignored warning, a
half-finished TODO lowers the bar for the next contributor. Reverse the
slide immediately: fix the window before others conclude that sloppiness
is the standard here.

### We Are Authors

Code is read far more often than it is written — the ratio is roughly
10:1. You are writing for a reader, not the compiler. Optimize every line
for the next person, who may be tired, on-call, or you in six months.
Making code easy to read is the fastest way to make it easy to write.

### Code-Sense

Recognizing clean vs. messy code is a practiced skill, not an innate gift.
Deliberately review and refactor to sharpen it. When something feels off,
trust the instinct and investigate — the smell is usually real.

## Core Design Principles

### KISS — Keep It Simple

Prefer the simplest solution that actually works. Avoid premature
optimization and cleverness-for-its-own-sake. Optimize for clarity first;
optimize for performance only when measured need demands it.

### DRY — Don't Repeat Yourself

Extract repeated logic into shared functions or utilities — but only when
the duplication is *real*, not speculative. Introduce abstractions under
pressure of actual repetition, never in anticipation of it. Duplication is
cheaper than the wrong abstraction.

### YAGNI — You Aren't Gonna Need It

Do not build features or abstractions before they are needed. Speculative
generality adds maintenance cost without value. Start simple, refactor
when the real requirement arrives.

### Principle of Least Surprise

Code should behave exactly as its name and signature suggest — no hidden
side effects, no clever overloads, no "gotchas". The obvious behavior
must be implemented; anything surprising must be impossible to miss.

### Command-Query Separation

A method should either:

- **Command** — perform an action / change state, returning nothing, **or**
- **Query** — answer a question / return data, changing nothing.

Asking a question should not change the answer. Splitting these makes
code predictable and testable.

### Law of Demeter

A method may call methods only on:

- itself,
- its parameters,
- objects it creates,
- its direct components.

Avoid "train wrecks" like `a.b().c().d()` — they couple a caller to the
internal shape of distant objects. Hide that navigation behind a method
on the object you actually hold.

## Emergent Design

Clean design is not chosen up front — it emerges from discipline. The
four rules of emergent design, in priority order:

1. **Runs all the tests** — a thoroughly tested system is free to change.
2. **Contains no duplication** — every duplication is a latent bug.
3. **Expresses the intent of the programmer** — readable, expressive code.
4. **Minimizes the number of classes and functions** — no more machinery
   than the work requires.

These are listed in order: do not minimize classes by sacrificing tests
or clarity.

## Immutability (Default)

Prefer immutable data by default:

```
WRONG:  modify(original, field, value)  → mutates original in place
RIGHT:  update(original, field, value)  → returns a new copy with the change
```

Immutable data prevents hidden side effects, makes state changes explicit
and debuggable, and enables safe concurrency. Mutate only when there is a
measured, justified reason — and confine the mutation to the smallest
possible scope.

## Rule Priority

When universal principles and language-specific idioms appear to conflict,
the language idiom usually expresses the *same* principle in a different
shape — resolve the apparent conflict in favor of idiomatic clarity. When
a genuine contradiction cannot be reconciled, see `../README.md`
on rule precedence (specific overrides general).
