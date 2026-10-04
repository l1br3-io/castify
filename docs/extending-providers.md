# Extending Castify with a new provider

Checklist-driven guide for adding a media source. Two kinds exist:

- **OAuth provider** — users connect through the provider's consent screen
  (Google Drive, Dropbox, OneDrive pattern).
- **Credential-based provider** — users submit a form of static secrets
  (S3-compatible storage pattern; the form is generated from a schema, so the
  frontend needs zero new form code).

Reference implementations: `crates/catalog/src/providers/dropbox.rs` (OAuth,
smallest of the three) and `crates/catalog/src/providers/s3.rs`
(credentials). Spec: [`spec.md`](spec.md).

## The trait map

All traits live in `crates/catalog/src/provider.rs`.

| Type | Role | You implement |
| :--- | :--- | :--- |
| `Provider` | Listing + bytes: `list_videos`, `fetch_prefix_hash`, `fetch_thumbnail`, `open_stream`. Defaults: `open_stream_url` → `Proxied`, `fetch_subtitle_content` (via `open_stream`), `revoke` → no-op | Always — this is the actual provider |
| `ProviderFactory` | Core identity + lifecycle: `name`, `connect_flow`, `create(credential)`, `verify(credential)` → `(account_id, account_email)` | Always — one per provider |
| `OAuthFlow` | OAuth round-trip: `authorization_url`, `exchange_code`, `refresh_token`, `fetch_user_info` | OAuth providers only |
| `ConnectFlow` | What `connect_flow()` returns: `OAuth(Box<dyn OAuthFlow>)` or `Credentials(CredentialsSchema)` | Via the factory — never matched outside the registry/routes |
| `CredentialsSchema` / `CredentialField` | Declarative form (`key`, `label`, `secret`, `placeholder`); the frontend renders it generically | Credential providers only |

Supporting types:

- `Credential` (`crates/catalog/src/crypto.rs`) — serde-**untagged** enum:
  `OAuth(TokenBundle)` | `S3(S3Credentials)` | …one variant per credential
  kind. Stored AES-256-GCM-encrypted in `provider_connections.token_bundle`
  (column name is historical).
- `Provider` (`crates/catalog/src/model.rs`) — the closed wire enum with
  `as_str`/`parse`/`ALL`. The DB stores its strings; `parse` is the only gate.
- `ProviderRegistry` (`crates/catalog/src/providers/mod.rs`) — the single
  dispatch point. Everything downstream (scanner, stream routes, connections
  routes) calls `factory_for(provider)` and uses the returned trait object;
  nothing outside the registry matches on `Provider` exhaustively.

Why the split: `ProviderFactory` is auth-agnostic shared code; OAuth-only
operations live on `OAuthFlow` so credential providers never stub them, and
credential-only form description is plain data so the frontend form is
generic. `GET /api/connections/available` iterates `Provider::ALL` and
reports `{ id, authMode, configured, credentials }` straight from the
registry — new variants appear there with no route changes.

## Checklist: add an OAuth provider

1. **New module** `crates/catalog/src/providers/<name>.rs`:
   - `<Name>Config { client_id, client_secret }` (server-level, from env).
   - `<Name>Factory` implementing `ProviderFactory`: `connect_flow` →
     `ConnectFlow::OAuth(<Name>Flow)`. Keep the default `verify` — it calls
     `fetch_user_info` through the flow.
   - `OAuthFlow` impl (the four methods).
   - `Provider` impl (`open_stream_url` override → `StreamUrl::Direct` only if
     the provider can issue browser-fetchable URLs).
2. **Enum + registry registration** (the only existing files you touch):
   - `crates/catalog/src/model.rs` — `Provider` variant, `ALL`, `as_str`,
     `parse`.
   - `crates/catalog/src/providers/mod.rs` — `pub mod <name>;`, config field
     on `ProviderRegistry` + constructor param, arms in `is_configured`
     (config present), `auth_mode` (`AuthMode::OAuth`), `factory_for`.
   - `crates/api/src/state.rs` — map the new env pair
     (`CASTIFY_<NAME>_CLIENT_ID/SECRET`, loaded in
     `crates/core/src/config.rs`) into the registry constructor call.
   - `frontend/src/api/types.ts` — `ProviderKey` union, `PROVIDERS`,
     `PROVIDER_LABELS`.
3. **Zero changes** to connections routes (`start`/`callback` are generic
   over `/api/connections/{provider}`), scanner, streaming, or the frontend
   connect UI.

## Checklist: add a credential-based provider

1. **New module** `crates/catalog/src/providers/<name>.rs` (study `s3.rs`):
   - `<Name>Credentials` struct — lives in your module; must have a field
     set **disjoint** from every other `Credential` variant (see security
     rules below). Optional fields need `#[serde(default)]`.
   - `credentials_schema()` — the declarative form; field order is form
     order; mark secrets with `secret: true`.
   - `expect_<name>(&Credential)` helper — extract your variant, reject
     everything else with a **wildcard arm** so sibling variants never break
     your compile.
   - `<Name>Factory`: `connect_flow` → `ConnectFlow::Credentials(schema)`;
     `create` builds the provider; **override `verify`** with a cheap
     reachability check (S3: `HeadBucket` + one list page) returning a
     stable, secret-free `account_id` for the `(provider, account_id)`
     uniqueness constraint.
   - `Provider` impl. Default `revoke` (no-op) is correct — static keys
     rotate at the provider's console.
2. **Registration**:
   - `crates/catalog/src/crypto.rs` — add the `Credential` variant and its
     `as_oauth` arm (`=> None`).
   - `crates/catalog/src/model.rs` — `Provider` variant, `ALL`, `as_str`,
     `parse`.
   - `crates/catalog/src/providers/mod.rs` — `pub mod <name>;` + three arms:
     `is_configured` → `true` (no server-level config), `auth_mode` →
     `AuthMode::Credentials`, `factory_for` → unconditional
     `Some(Box::new(<Name>Factory))`.
   - `crates/api/src/routes/connections.rs` + `crates/api/src/app.rs` — one
     thin route `POST /api/connections/<name>` mirroring `connect_s3`:
     typed request struct → trim/validate → build `Credential` →
     `factory.verify` → `upsert_connection` → background scan. This is the
     one place beyond registration (the route is per-provider by design so
     the payload stays typed); everything inside it is shared.
   - `frontend/src/api/types.ts` — label registration only (`ProviderKey`,
     `PROVIDERS`, `PROVIDER_LABELS`). The form itself is rendered from the
     schema by `CredentialsForm` — zero form code.
   - If the provider accepts user-supplied URLs, harden like
     `validate_s3_endpoint` (https-only outside loopback; reject
     private/link-local resolutions).
3. **Zero changes** to scanner, catalog, streaming, or frontend form code.

## The extension contract (verified)

Spec success criterion 5 — *a credential-based provider lands as one module
+ registration* — is proven by dry-run (task 010, 2026-09-05): a
hypothetical WebDAV provider consisting of `providers/webdav.rs` plus the
four registration touches above (module decl, `Credential` variant +
`as_oauth` arm, `Provider` variant, three registry arms) compiled the whole
workspace (`cargo check --workspace`) with **no edits** to the scanner,
connections routes, streaming, or frontend.

Known residues, both deliberate:

- Sibling credential factories must reject foreign variants via wildcard
  arms (see `expect_s3`); an exhaustive `Credential::OAuth(_)` arm would
  break the contract.
- Test-only assertion matches on `Credential` (e.g. in
  `crates/api/src/routes/connections.rs` tests) are exhaustive **on
  purpose** — they force a conscious decision when the enum grows. Expect to
  extend those matches in the new provider's own tests, not in production
  code. Same for the e2e mock harness (`crates/api/src/e2e.rs`, behind the
  `e2e` cargo feature), whose canned responses enumerate providers.

## Test expectations

Follow `s3.rs` and its task trail:

- **Schema is a wire contract**: assert the exact serialized JSON of
  `credentials_schema()` (see `credentials_schema_shape_is_the_form_contract`)
  so adding a field is a deliberate, visible change.
- **Factory gates**: `create`/`verify` reject foreign `Credential` kinds
  before any network call.
- **Pure logic unit-tested without network**: classification/partitioning,
  account-id derivation (stable, secret-free), prefix normalization.
- **Integration against a real server** when the provider has one
  (MinIO testcontainer pattern in `crates/catalog/tests/s3_integration.rs`):
  list pagination, extension filtering, prefix-hash range read, Range → 206,
  direct-URL expiry. Skip gracefully when docker is absent.
- **Untagged-serde disjointness**: a new `Credential` variant needs
  round-trip + legacy-decode + variant-disambiguation tests
  (`credential_variant_disambiguation` in `crypto.rs`).
- **E2E**: connect → scan → browse → play (direct + proxy), asserting
  secrets never appear in responses or artifacts (`e2e/`).

## Security rules

- Secrets live **only** inside a `Credential`, persisted exclusively via
  `Credential::encrypt_to_bytes` (AES-256-GCM under `TokenKey`). Never a
  plain column, never client-side storage.
- **Never log secrets** — log non-secret identity only (S3 logs endpoint +
  bucket; keys never).
- **Never echo secrets** in API responses: `ConnectionDto` carries none by
  construction; GETs return non-secret fields only.
- Mark form fields that hold secrets with `secret: true` so the UI masks
  them.
- `account_id` must be derived from non-secret inputs (S3 hashes
  endpoint + bucket) — it doubles as a visible identity.
- Keep `Credential` variants serde-disjoint: untagged decoding is the
  no-migration contract for existing rows; a new variant whose required
  fields are a superset/overlap of another's silently breaks decoding of old
  blobs.
