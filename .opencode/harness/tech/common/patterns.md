# Common Patterns

The generic, language-agnostic baseline. No language syntax (see
`<name>/patterns.md`), no HTTP/transport detail — only patterns every tech
dir may extend. Language-specific files extend these with idiomatic shapes.

## Single Responsibility (SRP)

A class or module should have **one reason to change** — one actor it
serves. "Responsibility" here means a reason to change, not "does one
literal thing".

- If a `Employee` class both computes pay and persists to the database,
  it serves two actors (Finance and DBA) and will change for two
  unrelated reasons. Split it.
- The test: can you describe what the unit does in one sentence without
  using "and"? If not, it has more than one responsibility.

SRP is the organizing principle behind most of the other patterns below.

## Cohesion

Aim for **maximal cohesion**: everything in a unit works toward its
single responsibility. Signs of low cohesion:

- Methods that use only a subset of the unit's fields → split along the
  fault line.
- A class whose methods could be grouped into unrelated clusters → they
  are separate units in disguise.
- Instance variables created "just in case" → YAGNI.

High cohesion makes a unit easy to name, test, and replace.

## Organized for Change (Open-Closed)

Code should be **open for extension, closed for modification** — add new
behavior by adding new code, not by editing a working branch.

- Prefer polymorphism over switch-by-type.
- Isolate the thing that varies behind an interface; depend on the
  interface, not the concrete.
- A change that ripples through many files is a smell — the abstraction
  boundary is drawn in the wrong place.

## Separating Construction from Use

> Construction is a concern. Separate it from runtime logic.

A module that *uses* a dependency should not also *construct* it.
Mixing construction and use ties you to a concrete choice and makes the
module untestable in isolation. The standard tool is **dependency
injection**: hand a dependency in; do not reach out and `new` it.

```text
BAD:   class OrderService {
         private db = new PostgresClient(productionUrl)   // knows too much
       }
GOOD:  class OrderService {
         constructor(db: PersistencePort)                 // depends on the abstraction
       }
```

- **Depend on abstractions** (ports/interfaces), not concretions.
- **Inject at the edge** — compose the object graph in one place
  (a `main`, a factory, a DI container) and let the rest of the code
  receive its dependencies.
- **Tests swap freely** — once construction is separated, a test injects
  a fake or in-memory implementation without touching the system under
  test.

## Repository Pattern

Encapsulate data access behind a consistent interface:

- Define standard operations: `findAll`, `findById`, `create`, `update`,
  `delete`.
- Concrete implementations handle storage details (database, API, file).
- Business logic depends on the abstract interface, not the storage
  mechanism.
- Enables easy swapping of data sources and simplifies testing with
  mocks.

A repository is the persistence-side expression of "separate construction
from use" — the consumer knows nothing about how or where data is stored.

## Boundaries — Wrapping Third-Party Code

Third-party code is not yours. Treat the seam as a boundary you control:

- **Learn the API through tests** — write throwaway "learning tests" that
  exercise the library, then keep them as regression guards against
  upgrades.
- **Wrap third-party code** when its interface doesn't match yours. A
  thin adapter around `org.thirdparty.Foo` exposes your domain's
  `WidgetPort` and insulates the rest of the codebase from the library's
  vocabulary, error types, and upgrade churn.
- **Translate errors at the seam** — foreign exceptions, status codes,
  and null contracts become your domain's typed errors the moment they
  cross in.
- **Keep boundaries narrow** — fewer call sites into a dependency means
  fewer places to change when it moves.

A boundary you don't own is a place where Least Surprise and isolation
matter most: contain the foreign surface so its surprises cannot spread.

## Skeleton Projects

When implementing new functionality:

1. Search for battle-tested skeleton projects.
2. Use parallel agents to evaluate options:
   - Security assessment
   - Extensibility analysis
   - Relevance scoring
   - Implementation planning
3. Clone best match as foundation.
4. Iterate within proven structure.

## Emergent Architecture

Do not design the whole system up front. Let it emerge through these
rules: keep tests green, remove duplication, express intent, minimize. Architecture is what you have when these are
applied consistently over time — not a diagram decided on day one.
