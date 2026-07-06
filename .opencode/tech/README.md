# Tech Conventions

Per-language and per-framework conventions for the harness. Each folder under
`tech/` (except `common/`) holds a set of files covering coding style,
patterns, security, and testing for one stack.

## Activation

Tech is opt-in. Only the stacks listed in `rules/tech.md` auto-load their
conventions. Edit that file (or run the `init-tech-declaration` skill) to
declare the stacks your project uses. The other folders stay dormant —
available in the library but loaded only on demand.

## Composition

`common/` is the language-agnostic baseline (principles, naming, comments,
functions, error handling, testing, security, etc.). A language-specific
`<name>/coding-style.md` does **not** restate these baselines — it declares
which are relevant and then adds only the language-specific deltas (tooling,
idioms, conventions). See `rust/coding-style.md` for an example of that delta
pattern.

## Rule priority

When a baseline principle and a language idiom appear to conflict, the idiom
usually expresses the *same* principle in a different shape — resolve in
favor of idiomatic clarity. Specific overrides general.

## File shape

Every file under `<lang>/` declares a `paths:` frontmatter glob; opencode
injects the file's content when a matching path is edited. `common/` is the
only folder without `paths:` — it is referenced explicitly by the language
folders and loaded as a baseline, not by glob.

## Available stacks

angular, arkts, cpp, csharp, dart, fsharp, golang, java, kotlin, nuxt, perl,
php, python, react, react-native, ruby, rust, swift, typescript, vue, web.
