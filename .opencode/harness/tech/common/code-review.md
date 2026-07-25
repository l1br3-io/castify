# Code Review Checklist

## Pre-Commit Review

Before merging or committing, verify:

### Correctness
- [ ] Logic matches the intended behavior
- [ ] Edge cases are handled (null, empty, boundary values)
- [ ] Error paths are exercised and produce clear messages
- [ ] No silent failures — errors propagate or are logged

### Readability
- [ ] Names tell what the code does, not how
- [ ] Comments explain why, not what
- [ ] Functions do one thing and do it at the expected level of abstraction
- [ ] No dead code, commented-out blocks, or unreachable branches

### Architecture
- [ ] Abstractions earn their complexity (≥3 callers before extracting)
- [ ] Dependencies point inward (domain ← infrastructure, not the reverse)
- [ ] No circular imports or module cycles
- [ ] Configuration is separate from logic

### Safety
- [ ] Input is validated at the boundary
- [ ] SQL/HTML/SQL is parameterized, not concatenated
- [ ] Secrets are not logged, committed, or hardcoded
- [ ] Authentication and authorization checks are present

### Testing
- [ ] Happy path is covered
- [ ] One sad path is covered
- [ ] Tests verify behavior, not implementation
- [ ] No flaky tests (timeouts, random data, order-dependent state)

### Performance
- [ ] No N+1 queries
- [ ] No unbounded collections or infinite loops
- [ ] Heavy work is async or batched where appropriate

## Post-Review Action

Beyond the checklist:
- If a pattern is used wrong in multiple places, flag the systemic issue
- If the fix is mechanical (rename, reorder), offer to apply it
- Never block a review on stylistic preferences that the formatter or linter
  already enforces
