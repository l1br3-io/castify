---
paths:
  - "**/nuxt.config.*"
  - "**/app.config.*"
  - "**/app.vue"
  - "**/pages/**"
  - "**/layouts/**"
  - "**/middleware/**"
---

# Nuxt Coding Style

> This file extends common/coding-style.md (../common/coding-style.md) with Nuxt specific content.

## Directory layout

- Default `srcDir` is `app/`. Framework files live at `app/pages/`, `app/layouts/`, `app/middleware/`, `app/plugins/`, `app/app.config.ts`. `nuxt.config.ts` and `server/` stay at project root.
- Some projects override `srcDir` to `src/` for a Feature-Sliced Design layout, remapping `dir.pages` (for example to `src/app/routes`), `dir.layouts`, and the `@`/`~` aliases. Always check `nuxt.config.ts` before assuming a path.

## Auto-imports discipline

- Composables in `app/composables/` and `server/utils/` auto-import. Do NOT manually import Nuxt composables (`useFetch`, `useState`, `navigateTo`) or `defineStore` / `storeToRefs`.
- Do NOT add a standalone `vue-router` dep (Nuxt bundles v5) or hand-mount `createApp` / `createPinia` / `createRouter`. The framework wires these.

## Compiler macros

- `definePageMeta` is a compile-time macro. Static values only, no reactive data and no side-effect calls inside it.
- Augment typed `PageMeta` via `declare module '#app'` rather than casting.

## Config file separation

Three distinct files, do not conflate.

- `nuxt.config.ts` = build-time only (`routeRules`, `modules`, `nitro`, `ssr` flag). Not reactive.
- `runtimeConfig` (inside nuxt.config) = per-env runtime values, env-overridable via `NUXT_*`. Root keys are server-only, `public` keys are client-visible.
- `app/app.config.ts` = public build-fixed reactive settings (theme tokens, feature flags). No env override. NEVER secrets.

## Head and meta

- `app.head` in `nuxt.config.ts` takes static values only.
- Reactive meta goes through `useHead` / `useSeoMeta` in component setup, never via `app.head`.

## Verification

Run after editing Nuxt files:

- **Lint**: use the `@nuxt/eslint` module (flat-config, project-aware, generates `.nuxt/eslint.config.mjs`) — run `eslint .` or `eslint --fix`. Prefer this over hand-rolled configs.
- **Format**: `prettier --write`, **or** enable stylistic rules in `@nuxt/eslint` to avoid a Prettier/ESLint conflict. Pick one formatting authority — never run both at once.
- **Typecheck**: `nuxi typecheck` (wraps `vue-tsc`; requires `vue-tsc` + `typescript` dev deps). Project-wide, so wrap it: `timeout 60 nuxi typecheck` so a hung type-check is reaped instead of accumulating across fast edits.
- **Ordering on `app/**` and `server/**` edits**: `eslint --fix` first (mutates the file), then the timed typecheck (verifies the result).
