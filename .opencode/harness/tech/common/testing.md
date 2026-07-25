# Testing Requirements

## Minimum Test Coverage: 80%

Test Types (ALL required):
1. **Unit Tests** - Individual functions, utilities, components
2. **Integration Tests** - API endpoints, database operations
3. **E2E Tests** - Critical user flows (framework chosen per language)

## Test-Driven Development

MANDATORY workflow:
1. Write test first (RED)
2. Run test - it should FAIL
3. Write minimal implementation (GREEN)
4. Run test - it should PASS
5. Refactor (IMPROVE)
6. Verify coverage (80%+)

## The F.I.R.S.T. Principles

Tests are first-class citizens — held to the same standards as production
code. Every test suite must be:

- **Fast** — tests run in seconds, not minutes. A slow suite stops being
  run, and a suite that isn't run is a suite that doesn't exist. Keep
  unit tests independent of network, disk, and sleeps.
- **Independent** — one test's outcome never depends on another. Tests
  may run in any order, or in parallel, without breaking. No shared
  mutable fixtures.
- **Repeatable** — the same inputs give the same result, in any
  environment, with no reliance on external state (the clock, the
  network, a flaky third party). Stub or fake the nondeterminism.
- **Self-validating** — a pass/fail is decided by the framework, not by a
  human reading a log. Booleans out, assertions in.
- **Timely** — tests are written *next to* the code they exercise,
  ideally just before it (TDD). Tests written long after the code are
  written against the implementation's accidents, not its contract.

## Clean Tests

- Tests are read more than they are written — keep them readable. Use a
  domain-specific testing language (the AAA pattern below, builders,
  expressive assertions).
- One assert per test is the ideal; a few related asserts are acceptable.
- Tests should not be coupled to implementation details. Verify behavior
  and contracts, not private method calls.
- Treat test code with the same respect as production code: extract
  helpers, remove duplication, keep them small.

## Troubleshooting Test Failures

1. Use **tdd-guide** agent
2. Check test isolation
3. Verify mocks are correct
4. Fix implementation, not tests (unless tests are wrong)

## Agent Support

- **tdd-guide** - Use PROACTIVELY for new features, enforces write-tests-first

## Test Structure (AAA Pattern)

Prefer Arrange-Act-Assert structure for tests:

```typescript
test('calculates similarity correctly', () => {
  // Arrange
  const vector1 = [1, 0, 0]
  const vector2 = [0, 1, 0]

  // Act
  const similarity = calculateCosineSimilarity(vector1, vector2)

  // Assert
  expect(similarity).toBe(0)
})
```

### Test Naming

Use descriptive names that explain the behavior under test:

```typescript
test('returns empty array when no markets match query', () => {})
test('throws error when API key is missing', () => {})
test('falls back to substring search when Redis is unavailable', () => {})
```
