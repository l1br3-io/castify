---
paths:
  - "**/nuxt.config.*"
  - "**/app.config.*"
  - "**/app.vue"
  - "**/server/**/*.ts"
  - "**/pages/**"
  - "**/middleware/**"
---

# Nuxt Patterns

> This file extends common/patterns.md (../common/patterns.md) with Nuxt specific content.
> For language-level API/interface patterns (Contract Definition, Error Representation, Boundary Validation, Additive Evolution, Variant Types, Input/Output Separation, Opaque IDs), see typescript/patterns.md (../typescript/patterns.md). This file covers only Nuxt-specific patterns.

## Data-fetch selection

Load-bearing. Pick by render timing, not habit.

- `useFetch(url)` = SSR-safe, URL-first initial/first-paint data. The default. Forwards the server result through the payload so there is no hydration double-fetch.
- `useAsyncData(key, fn)` = SSR-safe, custom async logic (SDK / GraphQL / combined calls). The explicit key shares the result across components.
- `$fetch` = client interactions only (form submit, button click, POST/PUT/DELETE). NOT SSR-safe, double-fetches if used for first paint.
- Rule: `useFetch` / `useAsyncData` for anything rendered on first paint, `$fetch` only for event-driven mutations.

## Shared state

- `useState('key', () => init)` for SSR-safe shared state. Values must be JSON-serializable.
- NEVER `export const x = ref()` at module scope. One shared instance leaks across concurrent SSR requests and causes a memory leak.
- With `@pinia/nuxt`: Pinia for domain state, `useState` for small cross-component primitives.
- Async server-side init goes in `callOnce(async () => {...})`, not as a side effect inside `useAsyncData`.

## Nitro server routes

- `server/api/*.{get,post}.ts` auto-register by path + method. Handler is `defineEventHandler((event) => ...)`.
- Errors via `throw createError({ status, statusText })`. Prefer the Web-API `status` / `statusText` over deprecated `statusCode` / `statusMessage`.
- `server/middleware/` must NOT return a response. Only mutate `event.context` or set headers.

## Route middleware

- `app/middleware/*.ts` with `defineNuxtRouteMiddleware((to, from) => ...)`.
- Use the `to` / `from` args. Do NOT call `useRoute()` inside middleware.
- `.global` suffix runs on every route. Return `navigateTo()` to redirect, `abortNavigation()` to stop.

## Hydration-safe rendering

- Route off `status` (`idle | pending | success | error`) for lazy fetches.
- `useAsyncData` payload uses `devalue` (Date/Map/Set/refs survive). A `server/api` response is `JSON.stringify`-only, so define `toJSON()` for non-JSON types.
- Shrink payload with `pick` / `transform`. This reduces serialized size, it does not skip the fetch.
