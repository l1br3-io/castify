# Naming

Names are the primary tool for communicating intent. A good name makes
code self-documenting; a bad one forces the reader to reverse-engineer
meaning from surrounding context. Spend the time to get them right — a
name is read 10× more often than it is written.

## Reveal Intent

A name should answer **all** of:

- *Why does it exist?*
- *What does it do?*
- *How is it used?*

If a name needs a comment to explain itself, the name is wrong — rename,
do not annotate.

```text
BAD:   list, data, theThing, d, a1
GOOD:  activeUsers, fetchVerifiedEmails, retryCountdownMillis
```

The name should be honest about cost. `getUsers()` that performs a
network round-trip and parses a 50-row payload is lying; call it
`fetchUsersPage()`.

## Avoid Disinformation

- Do not use words that imply a different type than the name holds
  (e.g. `accountList` for a `Map`, or a variable holding a single value
  with a plural name).
- Do not leave a misleading name after a refactor — a name that no
  longer matches the behavior is worse than a vague one.
- Avoid reserved-language words and well-known type names as identifiers.

## Make Meaningful Distinctions

Distinguish only when the distinction is real:

```text
BAD:   a1, a2 / copyData / processData / doIt
GOOD:  sourceAccount / destinationAccount / parseTransactions / settleBatch
```

Noise words (`data`, `info`, `object`, `manager`, `helper`, `the`) add
length without information. `Customer` and `CustomerObject` are not
meaningful distinctions.

## Pronounceable & Searchable

- Use pronounceable names — humans discuss code aloud. `genymdhms` is
  unreadable; `generationTimestamp` is not.
- Longer, searchable names beat single letters for anything but a tight
  loop scope. A `MAX_RETRIES` is greppable; an `e` is not.
- Single-letter names are acceptable **only** for short loop scopes or
  well-understood math conventions (`x`, `y`, `i`, `j`).

## Avoid Encodings

Encoding type or scope information into the name (`strName`, `m_count`,
`IInterface`, `pObj`) forces the reader to decode it, and the encoding
rots faster than the name. Let the language's type system and tooling
carry that information. Hungarian notation and member prefixes are an
anti-pattern except where the language ecosystem mandates them.

## One Word per Concept

Pick **one** word for each abstract concept and use it consistently:

```text
BAD:   fetch / retrieve / get  used interchangeably for the same operation
GOOD:  pick "fetch" once → fetchUsers, fetchOrders, fetchSession
```

A consistent vocabulary lets the reader find related code by search and
trust what they find.

## Noun vs Verb Phrasing

- **Types / classes / modules** → **noun phrases**: `Customer`, `Invoice`,
  `PaymentGateway`. Avoid `Manager` / `Processor` / `Handler` — these
  usually hide an unnamed responsibility.
- **Functions / methods** → **verb phrases**: `postPayment`,
  `deletePage`, `calculateInterest`.
- **Predicates / booleans** → questions or assertions: `isVerified`,
  `hasPermission`, `shouldRetry`, `canCommit`. Prefix with `is`, `has`,
  `should`, `can`, `needs`.

## Scope ↔ Length

The longer a name's scope, the longer and more descriptive it should be:

- **Short scope** (loop variable, lambda param): a letter or two is fine — `i`, `tx`, `ch`.
- **Long scope** (public API, exported symbol, type): spell it out fully —
  `GenerationTimestamp`, not `genTs`.

The cost of typing a long name once is paid back every time it is read.

## Solution vs Problem Domain Names

- Use **solution-domain** names (`AccountantVisitor`, `EventBroker`,
  `Saga`) when the reader is expected to be a developer familiar with the
  pattern.
- Use **problem-domain** names (`InvoiceNumber`, `PolicyHolder`) when the
  code maps directly to business concepts.

Choose the vocabulary the reader at that location will share.

## Add Context Without Clutter

Provide context through structure (a class/module enclosing its members)
or a focused prefix — not by stuffing scope into every identifier:

```text
BAD:   firstName, lastName, streetAddress, cityAddress  (redundant "Address")
GOOD:  class Address { firstName, lastName, street, city }
```

If you find yourself repeating a prefix on every member, that is a signal
to extract the enclosing structure.

## Names Should Describe Side Effects

If a function has a side effect, the name must say so. `getPassword()`
that writes an audit log, sends a notification, and rotates a token is a
lie. Name it for what it *does*: `rotatePasswordAndAudit()`.
