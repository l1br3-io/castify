// Tooltip — advisory text for a trigger (see ui/README.md § Tooltip).
// Shows on hover AND keyboard focus, hides on blur/Escape/mouse-leave.
// On hover-less (touch-only) pointers the bubble is removed by CSS
// ([@media(hover:none)]:hidden) — touch users never hit a stuck tooltip.
//
// Canonical use: the reason a disabled action is unavailable. Render that
// trigger with `aria-disabled` + styling instead of the `disabled`
// attribute — a truly disabled button swallows pointer/focus events, so
// its tooltip (the reason) would be unreachable.
//
// Gotcha: handlers are composed onto the child via cloneElement — the
// child must be a single React element that accepts DOM props.

import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "./cn";

type TooltipChildProps = {
  onMouseEnter?: (e: ReactMouseEvent) => void;
  onMouseLeave?: (e: ReactMouseEvent) => void;
  onFocus?: (e: FocusEvent) => void;
  onBlur?: (e: FocusEvent) => void;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
  "aria-describedby"?: string;
};

type TooltipProps = {
  content: ReactNode;
  children: ReactElement<TooltipChildProps>;
};

export function Tooltip({ content, children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const id = useId();

  if (!isValidElement(children)) return children;

  const child = children as ReactElement<TooltipChildProps>;

  const show = () => setVisible(true);
  const hide = () => setVisible(false);
  const escape = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") hide();
    child.props.onKeyDown?.(e);
  };

  return (
    <span className="relative inline-flex">
      {cloneElement(child, {
        onMouseEnter: (e) => {
          show();
          child.props.onMouseEnter?.(e);
        },
        onMouseLeave: (e) => {
          hide();
          child.props.onMouseLeave?.(e);
        },
        onFocus: (e) => {
          show();
          child.props.onFocus?.(e);
        },
        onBlur: (e) => {
          hide();
          child.props.onBlur?.(e);
        },
        onKeyDown: escape,
        "aria-describedby": visible ? id : child.props["aria-describedby"],
      })}
      {visible && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "pointer-events-none absolute bottom-full left-1/2 z-[var(--z-menu)] mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface-raised)] px-2 py-1 text-xs text-[var(--color-castify-text)] shadow-lg [@media(hover:none)]:hidden",
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
