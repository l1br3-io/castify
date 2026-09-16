// IconButton — a button whose visible content is an icon. The accessible
// name is REQUIRED (`label`): an unnamed icon button is an a11y bug, so it
// is a non-optional prop. The icon itself is aria-hidden so the label is
// the single accessible name. 36px square (size-9) — above the 24px WCAG
// target floor with room for pointer imprecision.

import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "./cn";

type IconButtonProps = Omit<ComponentPropsWithoutRef<"button">, "children"> & {
  /** Accessible name — required; not shown visually. */
  label: string;
  /** The icon glyph; rendered aria-hidden. */
  children: ReactNode;
  variant?: "ghost" | "secondary";
  pending?: boolean;
};

export function IconButton({
  label,
  variant = "ghost",
  pending = false,
  className,
  type,
  disabled,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      aria-label={label}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] transition disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress aria-busy:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]",
        variant === "ghost"
          ? "text-[var(--color-castify-muted)] hover:bg-[var(--color-castify-accent-subtle)] hover:text-[var(--color-castify-text)]"
          : "border border-[var(--color-castify-rule)] text-[var(--color-castify-text)] hover:bg-[var(--color-castify-accent-subtle)]",
        className,
      )}
      {...rest}
    >
      <span aria-hidden className="inline-flex">
        {children}
      </span>
    </button>
  );
}
