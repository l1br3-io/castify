# Formatting

Formatting is communication, not cosmetics. Consistent structure makes
code scannable, signals intent, and lets a reader navigate without
reading every line. A language-specific file adds the tooling (formatters,
linters, hooks) that *enforce* what this file *describes*.

## Why Formatting Matters

- It communicates **structure** — the eye sees the shape of the code
  before it reads a word.
- It signals **relatedness** — things near each other are read as a unit.
- It is the cheapest **team contract** — agree once, enforce with tools,
  stop arguing about it in review.

> **Language note**: When the language ecosystem has a canonical
> formatter (rustfmt, gofmt, prettier, black), its defaults win — see the
> tech dir's `coding-style.md` → **Verification** section. The principles
> here apply where a tool does not already decide.

## Vertical Formatting — Concept Proximity

### Keep Related Concepts Together

Code that is read together belongs together:

- A variable's declaration should sit just above its first use.
- A function's helpers should sit just below it, not across the file.
- Concepts with strong affinity (a type and its constructors, a handler
  and its route registration) belong in the same module.

### Newspaper Metaphor

A source file reads like a newspaper article:

1. **Top** — a high-level summary: the file's name, the public type or
   entry point, a one-line purpose.
2. **Middle** — progressively more detail as you scroll down.
3. **Bottom** — the lowest-level private helpers.

A reader who stops at the top should understand what the file is *for*.

### Vertical Separation

If two concepts are unrelated, separate them with a blank line — and
ideally with a boundary (a new function, type, or file). Concepts that
should be separate but are glued together confuse the reader about scope.

### Team Rules

Pick one set of vertical conventions and stick to it across the team.
Consistency beats personal preference — the goal is that *any* file in
the repo looks like it could have been written by the same person.

## Horizontal Formatting

### Line Length

Keep lines short enough to read two files side-by-side without wrapping.
~100 characters is a common ceiling; some ecosystems mandate 80. Whatever
the number, **the tool decides** — never hand-wrap a line that the
formatter will reflow.

### Indentation

Use the language's canonical indentation. Consistency matters more than
the depth; tabs-vs-spaces is settled by the formatter, not by debate.

### Horizontal Density

- Use whitespace around operators and after commas to aid scanning.
- Do not pack multiple statements onto one line to "save space" —
  readability is the only metric that matters.

## File Organization

### Many Small Files > Few Large Files

Prefer high cohesion and low coupling through file structure:

- **200–400 lines** is typical; **800 lines** is the practical ceiling.
- When a file grows past that, extract cohesive groups into sibling
  modules.
- Extract utilities from large modules rather than letting one file
  become a catch-all.

### Organize by Feature/Domain, Not by Type

```text
BAD (by type):     src/{controllers,models,services,utils}/...
GOOD (by domain):  src/{auth,orders,billing}/... each owning its own
                   controller, model, and service together
```

Domain-organized files collocate code that changes together, which makes
navigation and deletion easier.

## Consistency Is the Real Rule

If the file you are editing already follows a convention, follow it —
even if you disagree. Inconsistency within a file is worse than a
suboptimal global rule. The Boy Scout Rule applies: if
the file is inconsistent, leave it more consistent than you found it, in
a separate commit if the cleanup is large.
