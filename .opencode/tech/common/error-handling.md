# Error Handling

Error handling is behavior, not an afterthought. Done well, it keeps the
happy path readable and makes failures debuggable. The rules below are
universal; a language-specific file shows the idiomatic signaling
mechanism (exceptions, `Result`, `Either`, multi-return).

## Prefer Signaling Over Return Codes

Returning a magic error code (a sentinel value, `-1`, `null`) mixes the
happy path with control flow and tempts the caller to forget the check:

```text
BAD:   if deletePage(page) == E_OK    // easy to skip
GOOD:  try { deletePage(page) } catch (e) { ... }   // cannot be ignored
```

Use the language's idiomatic channel — exceptions, `Result<T, E>`,
`Either<Error, Value>`, errors-as-values — so a failure cannot be silently
dropped. The happy path stays linear.

## Write the Try Block First

When writing error-prone code, sketch the `try` / `catch` (or
equivalent) shape first:

1. Write the `try` block — the happy path, in its cleanest form.
2. Write the `catch` — what recovery looks like.
3. Fill in the body.

This forces you to define the scope of the error and the recovery
contract before the details distract you.

## Provide Context

An error without context is a mystery:

```text
BAD:   throw "failed"                      // where? what? why?
GOOD:  throw new ConfigError("failed to parse users.yaml at line 42: missing 'name'")
```

Every error should carry enough context — what was being attempted, on
what input, at what location — that the failure can be diagnosed from
the message alone, without attaching a debugger.

## Define Errors by the Caller's Needs

Errors are an API. The caller cares about **whether and how it can
recover**, not which internal line failed. Classify by recovery shape:

- **Retryable** — transient; the caller may try again (network timeout).
- **Recoverable** — the caller can route around it (not-found → 404).
- **Programmer error** — a bug; let it crash loud and high (assertion,
  null deref in an internal invariant).

Do not leak implementation detail (raw SQL errors, stack traces from
third-party libraries) out of a boundary — wrap them.

## Boundaries: Wrap Third-Party Errors

At the edge of your code, translate foreign errors into your own domain
errors. A service that calls a Postgres driver should not surface
`org.postgresql.util.PSQLException` to its callers — it surfaces
`UserRepositoryError`. This insulates callers from your dependencies and
makes the boundary replaceable.

## Never Return Null

Returning `null` to signal "nothing" forces every caller to remember the
check, and the one caller that forgets crashes in production. Prefer the
language's "absence" type: `Option`/`Optional`/`Maybe`, an empty
collection (never `null` for "no results"), or a typed error.

```text
BAD:   User? findUser(id)         // returns null if not found — every caller must remember
GOOD:  Option<User> findUser(id)  // type system enforces the check
```

> A language-specific file notes where `null` is unavoidable (interop,
> legacy APIs) and how to contain it.

## Never Pass Null

The flip side: never *pass* `null` into a function. It is an implicit
contract the function must defend against in every branch. Where a
parameter is genuinely optional, model it explicitly (optional type,
default value, overload).

## Validate at Boundaries, Trust Inside

Validate at the edges of your system — entry points, public APIs, the
seam with untrusted input — and fail fast with a clear message. Once
data has crossed a validated boundary, code on the inside may trust it.
Defending every internal call is noise; defending the boundary is a wall.

- Validate user input, file contents, and API responses before processing.
- Use schema-based validation where available.
- Fail closed: on uncertain input, reject rather than guess.

## Don't Swallow Errors

Silently catching an error and continuing is a bug factory. If you truly
must ignore an error, do it loudly and with a reason:

```text
BAD:   try { ... } catch (e) { /* nothing */ }
GOOD:  try { ... } catch (e) {
         log.warn("best-effort cache warmup failed, continuing cold", e)
       }
```

Every swallowed error should be a deliberate, documented decision — and
rare.

## Don't Mix Error Handling with Business Logic

Error handling tangles the happy path. Extract error handling to its own
function or boundary so the happy path reads as a clean narrative. A
function that does both *compute* and *defend* is doing two things.
