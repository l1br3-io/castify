// Button — the one button primitive. Variants map to task-001 tokens;
// every interactive state is styled (see ui/README.md § Button for the
// state/a11y contract). New code must not hand-roll button classes.
//
// Gotchas:
// - `type` defaults to "button" so buttons inside <form> don't submit
//   accidentally; pass type="submit" where a form submit is wanted.
// - Destructive is an OUTLINE treatment on purpose: a solid danger fill
//   cannot hold one fixed label color across themes (white fails on the
//   bright dark-theme danger, dark canvas text fails on the deep light-
//   theme danger). The outline + danger-text pairing is AA in both themes
//   (see the contrast table in index.css).
// - `pending` disables AND sets aria-busy — disabling alone is invisible
//   to assistive tech and looks identical to a broken button.

import type { ComponentPropsWithoutRef } from "react";

import { cn } from "./cn";
import { buttonClasses, type ButtonVariant } from "./button-classes";

type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  pending?: boolean;
};

export function Button({
  variant = "primary",
  size = "md",
  pending = false,
  className,
  type,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cn(buttonClasses(variant, size), className)}
      {...rest}
    >
      {children}
    </button>
  );
}
