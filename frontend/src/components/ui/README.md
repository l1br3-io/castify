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
`size`: `md` (default) · `sm`. `type` defaults to `button`. Labels set in
the display face (Cormorant Garamond semibold) per D5 — buttons are
chrome, not prose.

| State                  | Treatment                                                            |
| ---------------------- | -------------------------------------------------------------------- |
| Default                | primary: gold **outline** (accent border, transparent ground, AA-strong gold text); secondary: hairline border; ghost: AA-strong gold text; destructive: danger outline |
| Hover                  | primary/ghost: `accent-subtle` tint; secondary: `hover` wash           |
| Active                 | tint deepens one step (`accent-press` / `press` — no transform)        |
| Focus-visible          | 2px `--color-focus` ring + surface offset ring; `outline-none`        |
| Disabled               | `opacity-50`, `cursor-not-allowed`, still in the a11y tree            |
| Pending (`pending`)    | + `aria-busy="true"`, disabled, `opacity-70`, `cursor-progress`       |

A11y contract: renders `<button>` — the label is its accessible name.
Pending must set `aria-busy` (a plain `disabled` flip is not announced).
Destructive is an outline treatment: a solid `--color-danger` fill cannot
hold one fixed label color across both themes (see the contrast table in
`index.css`). Primary is an outline for the same reason the demo is: color
arrives as stroke, not fill — and the raw gold is only ~3:1 on paper, so
its text pairs with `--color-castify-accent-strong` (4.5:1+ in both
themes).

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

## Menu

WAI-ARIA APG menu pattern. `Menu` renders the trigger (kebab glyph by
default) + portal panel; `MenuItem` is the standard item; children may be a
render-prop `(close) => ReactNode` for custom items (e.g. a `Link` with
`role="menuitem"`).

| State / input            | Behavior                                                |
| ------------------------ | ------------------------------------------------------- |
| Default (closed)         | trigger: `aria-haspopup="menu"` + `aria-expanded="false"` |
| Open                     | `aria-expanded="true"`; focus moves to first **enabled** item |
| Hover (trigger/items)    | `accent-subtle` fill; disabled items: no hover fill      |
| Focus-visible            | standard focus ring (trigger); items highlight via `focus-visible` fill |
| `ArrowDown` / `ArrowUp`  | cycle items, wrapping, skipping disabled                 |
| `Home` / `End`           | first / last enabled item                                |
| `Escape`                 | close, focus returns to trigger                          |
| `Tab` (in panel)         | dismiss (focus proceeds naturally — no dangling panel)   |
| Click outside            | dismiss (mousedown outside trigger **and panel** — the portal panel is not inside the trigger subtree) |
| Scroll / resize          | dismiss (the fixed panel anchors once at open; a detached menu closes instead of re-anchoring) |
| Select item              | runs `onSelect`, closes, focus back on trigger           |

A11y contract: panel is `role="menu"` named by `label`; items are
`role="menuitem"` buttons. Disabled items keep their text in the a11y tree;
pair them with a `Tooltip` for the reason when one exists. `triggerClassName`
re-skins the trigger for dark surfaces (e.g. over thumbnails) without
touching the contract.

## Dialog

Controlled modal extracted from the share-dialog overlay. Props: `open`,
`onClose`, `title`, `closeable` (default true), `children`, `footer`.

| State / input            | Behavior                                                  |
| ------------------------ | --------------------------------------------------------- |
| Open                     | `role="dialog"` + `aria-modal="true"`, labelled by `title` |
| Initial focus            | first focusable element (panel fallback)                   |
| `Tab` / `Shift+Tab`      | trapped: wraps within the panel                            |
| `Escape`                 | `onClose` (only when `closeable`)                          |
| Backdrop click           | `onClose` (only when `closeable`)                          |
| Close                    | focus restored to the element focused before open          |

A11y contract: background content is inert to assistive tech via
`aria-modal`; never render a dialog without a way to dismiss it that works
by keyboard (`closeable={false}` must be paired with an explicit close
action — that is the share dialog's post-creation state).

## Tooltip

Advisory text for a trigger; canonical use is the reason a disabled action
is unavailable.

| State / input        | Behavior                                                    |
| -------------------- | ----------------------------------------------------------- |
| Hover on trigger     | show (`role="tooltip"`, wired via `aria-describedby`)        |
| Keyboard focus       | show — same as hover (no pointer-only state)                 |
| Blur / mouse-leave   | hide                                                         |
| `Escape`             | hide                                                         |
| Touch-only pointer   | bubble removed by CSS (`[@media(hover:none)]:hidden`) — never stuck |

A11y contract: the trigger keeps its own handlers (composed, not clobbered).
For a disabled action, render the trigger with `aria-disabled` + styling —
NOT the `disabled` attribute — so the tooltip (the reason) stays reachable
by keyboard and pointer.

## EmptyState / ErrorState (consumers of Button)

Shared "no data" / error surfaces. CTAs render through the `Button`
primitive — primary for EmptyState actions, secondary for ErrorState retry.
ErrorState is `role="alert"`; copy rules live on the components (sentence
case, verb-led CTA, no apologies).

ErrorState also takes a `children` slot: extra recovery actions (links
styled as buttons, secondary actions) render in the CTA row beside the
retry — the watch page's Reconnect/Go-to-Sources pair uses it. Keep the
`role="alert"` semantics: children must be actions, not body copy (use
`body` for that).

## Skeleton / SkeletonGrid

Loading placeholders shaped like the content they stand in for.

| Concern        | Contract                                                      |
| -------------- | ------------------------------------------------------------- |
| Shape          | caller owns dimensions — pass the size/aspect of the real content (`aspect-video`, fixed heights) so the swap causes zero layout shift |
| Motion         | `animate-pulse`; collapses under the global reduced-motion override |
| A11y           | none — decorative; the loading state belongs to the page (or a `role="status"` wrapper the caller adds) |
| SkeletonGrid   | responsive poster-grid clone (2/3/4/5/6 cols) for grid sections |

## Toast

`useToast().info/success/error(message, opts?)` — stacked notices with
`--z-toast` elevation. Success/info are `role="status"`; error is
`role="alert"`. An optional `action` (e.g. the manage page's Undo) renders
a button in the toast and receives its dismiss slot. Entrance is the
sanctioned slide-in; reduced-motion collapses it globally.

## OfflineBanner / ErrorBoundary

Infra chrome, not interaction primitives: OfflineBanner is a `role="status"`
strip shown while the app is unreachable (fetch health probe); ErrorBoundary
catches render crashes into an ErrorState with reload. Neither takes part in
the focus contract.
