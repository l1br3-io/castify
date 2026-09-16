# UI primitives

`components/ui/` holds the interaction primitives every screen consumes.
Components consume these + tokens — no raw hex, no hand-rolled button/input
classes. Each table below is the primitive's state and a11y contract; "no
state reachable only by pointer" is a hard rule (every state here is
keyboard-reachable).

Conventions: focus rings use `--color-focus` at 2px with a 2px offset
(`--focus-ring-offset`); disabled = `opacity-50` + `cursor-not-allowed`;
pending = `aria-busy` + disabled + reduced opacity. Player chrome uses its
own over-video white focus treatment (see `--color-player-*` tokens) and is
documented in the player tasks.

## Button

`variant`: `primary` (default) · `secondary` · `ghost` · `destructive`.
`size`: `md` (default) · `sm`. `type` defaults to `button`.

| State                  | Treatment                                                            |
| ---------------------- | -------------------------------------------------------------------- |
| Default                | per-variant token fill/border/text                                   |
| Hover                  | primary: `brightness-110`; others: `accent-subtle` fill (ghost also lifts text) |
| Active                 | n/a (no pressed transform — spec § Motion: no lifts)                  |
| Focus-visible          | 2px `--color-focus` ring + surface offset ring; `outline-none`        |
| Disabled               | `opacity-50`, `cursor-not-allowed`, still in the a11y tree            |
| Pending (`pending`)    | + `aria-busy="true"`, disabled, `opacity-70`, `cursor-progress`       |

A11y contract: renders `<button>` — the label is its accessible name.
Pending must set `aria-busy` (a plain `disabled` flip is not announced).
Destructive is an outline treatment: a solid `--color-danger` fill cannot
hold one fixed label color across both themes (see the contrast table in
`index.css`).

## IconButton

`label` is **required** — the accessible name; the icon is `aria-hidden`.
36×36px (`size-9`), above the 24px WCAG target floor. Variants: `ghost`
(default) · `secondary`.

| State               | Treatment                                              |
| ------------------- | ------------------------------------------------------ |
| Default             | ghost: muted glyph; secondary: bordered                 |
| Hover               | `accent-subtle` fill (ghost also lifts glyph color)     |
| Focus-visible       | same focus ring as Button                               |
| Disabled / Pending  | same as Button (`aria-busy` on pending)                 |

A11y contract: `<button aria-label>` + hidden glyph → single accessible
name. If a visible text label exists next to the icon, use `Button` instead.

## Field / Input

`Field` owns the input `id` (via `useId`) and renders label + optional
`hint` + optional `error`. `Input` inside a `Field` is automatically
labelled and described — never wire `htmlFor`/`aria-describedby` by hand.

| Concern              | Contract                                                        |
| -------------------- | --------------------------------------------------------------- |
| Label                | `<label for>` → input id (Field-generated)                      |
| Hint                 | `aria-describedby` → hint id (announced before errors)          |
| Error                | `aria-describedby` → error id (after hint) + `aria-invalid="true"`; error `<p>` is `aria-live="polite"` |
| Error styling        | error text in `--color-danger`; input border/ring switch to danger |
| Focus                | text inputs ring on any focus (`focus:`, not `focus-visible:`) — expected for text fields |
| Input outside Field  | renders bare; caller must pass `aria-label`                     |

Gotcha: don't pass an explicit `id` to an `Input` inside a `Field` — Field
owns the id.

## CopyButton

Copies `value` to the clipboard. Labels: `label` (default "Copy link"),
`copiedLabel` (default "Copied"), `failMessage` (default "Couldn't copy —
please try again."). Defaults: `secondary` variant, `sm` size.

| State                  | Treatment                                                        |
| ---------------------- | ---------------------------------------------------------------- |
| Default                | secondary Button, `label`                                        |
| Hover / Focus-visible  | inherited from Button                                            |
| Copied (2s)            | label flips to `copiedLabel`; `role=status` (visually hidden) announces "`copiedLabel` to clipboard" |
| Failed (2s)            | inline `aria-live="polite"` message in `--color-danger`; label unchanged |
| Reset                  | back to idle after 2s                                            |

A11y contract: the copied/failure announcements do not rely on the label
flip (label changes alone are not reliably announced). Clipboard goes
through `lib/clipboard` (`navigator.clipboard` with `execCommand` fallback).

## EmptyState / ErrorState (consumers of Button)

Shared "no data" / error surfaces. CTAs render through the `Button`
primitive — primary for EmptyState actions, secondary for ErrorState retry.
ErrorState is `role="alert"`; copy rules live on the components (sentence
case, verb-led CTA, no apologies).
