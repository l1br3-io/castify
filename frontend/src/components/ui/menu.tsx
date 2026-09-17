// Menu — WAI-ARIA APG menu pattern, extracted from the hand-rolled menu in
// share-item-menu.tsx (see ui/README.md § Menu for the contract). Trigger
// announces aria-haspopup/aria-expanded; opening moves focus to the first
// enabled item; ArrowDown/ArrowUp cycle (skipping disabled); Escape closes
// and restores focus to the trigger; click-outside and Tab dismiss.
//
// Gotchas:
// - The panel is a portal to <body> with fixed positioning computed from
//   the trigger rect. jsdom reports zero rects — position only matters in
//   a real browser.
// - Children may be a render-prop `(close) => ReactNode` for items that
//   aren't MenuItem (e.g. a react-router Link with role="menuitem").

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const TRIGGER_CLASS =  "inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-button)] text-[var(--color-castify-muted)] transition hover:bg-[var(--color-castify-accent-subtle)] hover:text-[var(--color-castify-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]";

export const MENU_ITEM_CLASS =
  "block w-full rounded-[var(--radius-button)] px-3 py-1.5 text-left text-sm transition hover:bg-[var(--color-castify-accent-subtle)] focus:outline-none focus-visible:bg-[var(--color-castify-accent-subtle)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

type MenuContextValue = { close: () => void };

const MenuContext = createContext<MenuContextValue | null>(null);

const FOCUSABLE_ITEMS = '[role="menuitem"]:not(:disabled)';

type MenuProps = {
  /** Accessible name for both trigger and panel. */
  label: string;
  /** Trigger glyph; defaults to the kebab dots. */
  trigger?: ReactNode;
  /** Override the trigger classes — e.g. the dark chip used when the
   * menu rides on a thumbnail overlay. */
  triggerClassName?: string;
  /** MenuItems, or a render-prop receiving close() for custom items. */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Panel edge to drop from. Default "end" (right-aligned). */
  align?: "start" | "end";
  className?: string;
};

export function Menu({
  label,
  trigger,
  triggerClassName,
  children,
  align = "end",
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Opening moves focus into the panel (APG): keyboard users land on the
  // first enabled item. The portal renders after this effect's first
  // paint, so query it fresh here.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(FOCUSABLE_ITEMS)
      ?.focus();
  }, [open]);

  // Click-outside dismisses (mousedown so a drag starting outside still
  // counts as outside). GOTCHA: the panel portals to <body>, so it is NOT
  // inside rootRef — the check must consult both nodes, or a mousedown on
  // a menu item closes the menu before its click can fire (real browsers
  // only; fireEvent.click in unit tests skips mousedown and hides this).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Anchor detachment: the fixed panel is anchored once at open, so a page
  // scroll or window resize can leave it pointing at the wrong spot —
  // close instead of re-anchoring; reopening is one click/keypress.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function close(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(e: ReactKeyboardEvent): void {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      menuRef.current
        ?.querySelector<HTMLElement>(FOCUSABLE_ITEMS)
        ?.focus();
    }
  }

  function handleMenuKeyDown(e: ReactKeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    // Tab leaves the menu: dismiss (focus proceeds to the next document
    // tab stop naturally) rather than leaving a dangling open panel.
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_ITEMS) ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? (current + 1) % items.length
        : current <= 0
          ? items.length - 1
          : current - 1;
    items[next].focus();
  }

  // Anchor the fixed panel under the trigger's chosen edge. jsdom reports
  // zero rects — position is irrelevant there; the visual anchor only
  // matters in a real browser.
  const rect = triggerRef.current?.getBoundingClientRect();
  const panelStyle: CSSProperties =
    align === "end"
      ? {
          position: "fixed",
          top: (rect?.bottom ?? 0) + 4,
          left: rect?.right ?? 0,
          transform: "translateX(-100%)",
        }
      : {
          position: "fixed",
          top: (rect?.bottom ?? 0) + 4,
          left: rect?.left ?? 0,
        };

  return (
    <div ref={rootRef} className={className}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleTriggerKeyDown}
        className={triggerClassName ?? TRIGGER_CLASS}
      >
        {trigger ?? (
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
            <circle cx="3" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="13" cy="8" r="1.5" />
          </svg>
        )}
      </button>
      {open &&
        createPortal(
          <MenuContext.Provider value={{ close }}>
            <div
              ref={menuRef}
              role="menu"
              aria-label={label}
              onKeyDown={handleMenuKeyDown}
              style={panelStyle}
              className="z-[var(--z-menu)] min-w-44 space-y-0.5 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface-raised)] p-1 shadow-md"
            >
              {typeof children === "function" ? children(close) : children}
            </div>
          </MenuContext.Provider>,
          document.body,
        )}
    </div>
  );
}

type MenuItemProps = {
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
};

export function MenuItem({ onSelect, disabled = false, children }: MenuItemProps) {
  const ctx = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        ctx?.close();
        onSelect();
      }}
      className={MENU_ITEM_CLASS}
    >
      {children}
    </button>
  );
}
