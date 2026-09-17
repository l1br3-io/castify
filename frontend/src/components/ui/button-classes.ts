// Button class builders — kept out of button.tsx so that file stays
// component-only (react-refresh) and other primitives can share the
// focus-ring convention.

import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]";

export const BUTTON_SIZES = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-5 py-2 text-sm",
} as const;

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-castify-accent)] text-[var(--color-on-accent)] hover:brightness-110",
  secondary:
    "border border-[var(--color-castify-rule)] text-[var(--color-castify-text)] hover:bg-[var(--color-castify-accent-subtle)]",
  ghost: "text-[var(--color-castify-muted)] hover:bg-[var(--color-castify-accent-subtle)] hover:text-[var(--color-castify-text)]",
  destructive:
    "border border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)]",
};

/** Class builder for elements that must look like a button but can't be
 * one (e.g. links styled as buttons). Keep in sync with Button. */
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: keyof typeof BUTTON_SIZES = "md",
): string {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-[var(--radius-button)] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress aria-busy:opacity-70",
    FOCUS_RING,
    BUTTON_SIZES[size],
    BUTTON_VARIANTS[variant],
  );
}
