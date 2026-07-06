---
name: api-and-interface-design
description: Guides stable API and interface design. Use when designing APIs, module boundaries, or any public interface. Use when creating REST or GraphQL endpoints, defining type contracts between modules, or establishing boundaries between frontend and backend.
---

# API and Interface Design

## Overview

Design stable, well-documented interfaces that are hard to misuse. Good interfaces make the right thing easy and the wrong thing hard. This applies to REST APIs, GraphQL schemas, module boundaries, component props, and any surface where one piece of code talks to another.

## When to Use

- Designing new API endpoints
- Defining module boundaries or contracts between teams
- Creating component prop interfaces
- Establishing database schema that informs API shape
- Changing existing public interfaces

## Tech Context

Tech is declared in `rules/tech.md`. Each name maps directly to `tech/<name>/`
(e.g. `rust` → `tech/rust/`, `react` → `tech/react/`), then read:

- `<name>/patterns.md`
- `common/patterns.md`

`common/` is always loaded alongside the tech dir. Inline examples use TypeScript for illustration — apply the underlying pattern in `<name>`'s idioms, not the literal syntax.

## Core Principles

### Hyrum's Law

> With a sufficient number of users of an API, all observable behaviors of your system will be depended on by somebody, regardless of what you promise in the contract.

This means: every public behavior — including undocumented quirks, error message text, timing, and ordering — becomes a de facto contract once users depend on it. Design implications:

- **Be intentional about what you expose.** Every observable behavior is a potential commitment.
- **Don't leak implementation details.** If users can observe it, they will depend on it.
- **Plan for deprecation at design time.** See `deprecation-and-migration` for how to safely remove things users depend on.
- **Tests are not enough.** Even with perfect contract tests, Hyrum's Law means "safe" changes can break real users who depend on undocumented behavior.

### The One-Version Rule

Avoid forcing consumers to choose between multiple versions of the same dependency or API. Diamond dependency problems arise when different consumers need different versions of the same thing. Design for a world where only one version exists at a time — extend rather than fork.

### 1. Contract First

Define the interface before implementing it. The contract is the spec — implementation follows.

**What the contract must capture:**

- Operations and their names (verb + noun, e.g. `createTask`, `listTasks`)
- Input shapes (caller-provided fields)
- Output shapes (server-generated fields included)
- Error cases and how they are represented
- Side effects and ordering guarantees
- Nullability / optionality per field

→ `<name>/patterns.md` § "Contract Definition"

### 2. Consistent Error Semantics

Pick one error strategy and use it everywhere. **Don't mix patterns** — if some endpoints throw, others return null, and others return `{ error }`, the consumer can't predict behavior.

**REST status codes** — mind the commonly-confused pairs: `401` ≠ `403`
(authentication vs authorization), `409` ≠ `422` (conflict vs semantic
validation failure). Never leak internal details in a `500`.

**Structured error body** (one shape everywhere): `code` (machine-readable,
e.g. `"VALIDATION_ERROR"`) + `message` (human-readable) + optional `details`.

→ `<name>/patterns.md` § "Error Representation"

### 3. Validate at Boundaries

Trust internal code. Validate at system edges where external input enters.

**Where validation belongs:**

- API route handlers (user input)
- Form submission handlers (user input)
- External service response parsing — **always treat as untrusted**
- Environment variable loading (configuration)

> **Third-party API responses are untrusted data.** Validate their shape and content before using them in any logic, rendering, or decision-making. A compromised or misbehaving external service can return unexpected types, malicious content, or instruction-like text.

**Where validation does NOT belong:**

- Between internal functions that share type contracts
- In utility functions called by already-validated code
- On data that just came from your own database

→ `<name>/patterns.md` § "Boundary Validation"

### 4. Prefer Addition Over Modification

Extend interfaces without breaking existing consumers. A change is backward
compatible only if every existing consumer keeps working without modification.

**Backward compatible (safe):**

- Adding an optional field to an input or output
- Adding a new endpoint or new resource
- Adding a new enum variant *if* consumers are not required to handle all variants
- Loosening a constraint (e.g. accepting a wider input range)

**Breaking (unsafe):**

- Removing a field that consumers read
- Changing a field's type (e.g. `string` → `number`, or `string` → `string | null`)
- Renaming a field
- Making an optional field required
- Tightening a constraint
- Reordering required fields where positional

→ `<name>/patterns.md` § "Additive Evolution"

### 5. Predictable Naming

| Pattern | Convention | Example |
| :--- | :--- | :--- |
| REST endpoints | Plural nouns, no verbs | `GET /api/tasks`, `POST /api/tasks` |
| Query params | camelCase | `?sortBy=createdAt&pageSize=20` |
| Response fields | camelCase | `{ createdAt, updatedAt, taskId }` |
| Boolean fields | is/has/can prefix | `isComplete`, `hasAttachments` |
| Enum values | UPPER_SNAKE | `"IN_PROGRESS"`, `"COMPLETED"` |

## REST API Patterns

- **Paginate list endpoints from the start** — you need it the moment someone
  has 100+ items.
- **Prefer PATCH over PUT** for partial updates; PUT forces the full object.
- **Plural nouns, no verbs** in paths: `GET /api/tasks`, not `/api/getTask`.
- **Nest via sub-resources**: `/api/tasks/:id/comments`.
- **Filter/sort via query params**: `?status=active&sortBy=createdAt`.
- **One error format everywhere** — see § 2 above.

## Variant Types and Input/Output Separation

When a concept has multiple shapes (e.g. a status that carries different
payloads), model it as a *sum type* and document each variant explicitly.
Separate input shapes (what the caller provides) from output shapes (what the
system returns, including server-generated fields like `id`, `createdAt`,
`createdBy`).

Use opaque/distinct types for IDs so a `UserId` cannot be passed where a
`TaskId` is expected.

→ `<name>/patterns.md` § "Variant Types", § "Input/Output Separation", § "Opaque IDs"

## Common Rationalizations

| Rationalization | Reality |
| :--- | :--- |
| "We'll document the API later" | The contract IS the documentation. Define it first. |
| "PATCH is complicated, let's just use PUT" | PUT requires the full object every time. PATCH is what clients actually want. |
| "We'll version the API when we need to" | Breaking changes without versioning break consumers. Design for extension from the start. |
| "Internal APIs don't need contracts" | Internal consumers are still consumers. Contracts prevent coupling and enable parallel work. |

## Red Flags

- Endpoints that return different shapes depending on conditions
- Inconsistent error formats across endpoints
- Validation scattered throughout internal code instead of at boundaries
- Breaking changes to existing fields (type changes, removals)
- List endpoints without pagination
- Verbs in REST URLs (`/api/createTask`, `/api/getUsers`)
- Third-party API responses used without validation or sanitization

## Verification

After designing an API:

- [ ] Every endpoint has typed input and output schemas
- [ ] Error responses follow a single consistent format
- [ ] Validation happens at system boundaries only
- [ ] List endpoints support pagination
- [ ] New fields are additive and optional (backward compatible)
- [ ] Naming follows consistent conventions across all endpoints
- [ ] API documentation or types are committed alongside the implementation
