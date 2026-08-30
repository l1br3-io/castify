// ShareItemMenu — the per-card kebab menu on the share manage page
// (share-manage-page task 004).
//
// A hand-rolled accessible menu (the repo has no menu primitive and the
// no-new-deps boundary stands): labeled trigger with aria-expanded, a
// role="menu" panel with Open + Remove from share, Escape closes and
// returns focus to the trigger, outside mousedown closes, ArrowUp/Down
// cycle the items.
//
// The panel renders through createPortal to document.body: the menu
// trigger lives in PosterCard's topRightSlot, inside the Thumbnail
// wrapper — which is `overflow-hidden` (rounded 16:9 box) and would clip
// any in-place dropdown. The panel is position: fixed, anchored under the
// trigger's right edge at open time.
//
// Last-item guard: the caller passes canRemove=false for the final item;
// Remove renders aria-disabled + disabled and the hint line explains why
// (the server enforces non-empty with a 400 — this is UX, not enforcement).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

const TRIGGER_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-[var(--radius-button)] " +
  "bg-black/60 text-white/80 transition hover:bg-black/80 hover:text-white " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]";

const ITEM_CLASS =
  "block w-full rounded-[var(--radius-button)] px-3 py-1.5 text-left text-sm " +
  "transition hover:bg-[var(--color-castify-accent-subtle)] " +
  "focus:outline-none focus-visible:bg-[var(--color-castify-accent-subtle)] " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

export function ShareItemMenu({
  videoName,
  videoHref,
  canRemove,
  removeHint,
  onRemove,
}: {
  videoName: string;
  videoHref: string;
  canRemove: boolean;
  removeHint?: string;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The trigger subtree — the portal panel lives outside it, so the
  // outside-mousedown check must consult both refs.
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !triggerWrapRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // The panel is position: fixed, anchored once at open. Scrolling or
  // resizing under it detaches it from its trigger — and a detached
  // "Remove" overlay can sit over a different card. Close instead of
  // re-anchoring; reopening is one click.
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

  // Opening moves focus into the panel (ARIA APG menu pattern): keyboard
  // users land on the first item instead of stranding on the trigger with
  // dead Escape/arrow keys. The portal renders later than this effect's
  // first paint, so query it fresh here.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  function close(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  /** Trigger keys while open: Escape closes (focus returns here),
   * ArrowDown hands focus to the panel (where the arrow cycle lives). */
  function handleTriggerKeyDown(e: React.KeyboardEvent): void {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      menuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus();
    }
  }

  function handleMenuKeyDown(e: React.KeyboardEvent): void {
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
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        [],
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

  // Anchor the fixed panel under the trigger's right edge. jsdom reports
  // zero rects — position is irrelevant there; the visual anchor only
  // matters in a real browser.
  const rect = triggerRef.current?.getBoundingClientRect();
  const panelStyle: React.CSSProperties = {
    position: "fixed",
    top: (rect?.bottom ?? 0) + 4,
    left: rect?.right ?? 0,
    transform: "translateX(-100%)",
  };

  return (
    <div ref={triggerWrapRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${videoName}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleTriggerKeyDown}
        className={TRIGGER_CLASS}
      >
        <svg
          viewBox="0 0 16 16"
          className="h-4 w-4"
          fill="currentColor"
          aria-hidden
        >
          <circle cx="3" cy="8" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="13" cy="8" r="1.5" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Actions for ${videoName}`}
            onKeyDown={handleMenuKeyDown}
            style={panelStyle}
            className="z-50 min-w-44 space-y-0.5 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface-raised)] p-1 shadow-xl"
          >
            <Link
              role="menuitem"
              to={videoHref}
              onClick={() => setOpen(false)}
              className={ITEM_CLASS}
            >
              Open
            </Link>
            <button
              type="button"
              role="menuitem"
              aria-disabled={!canRemove}
              disabled={!canRemove}
              title={canRemove ? undefined : removeHint}
              onClick={() => {
                if (!canRemove) return;
                setOpen(false);
                onRemove();
              }}
              className={ITEM_CLASS}
            >
              Remove from share
            </button>
            {!canRemove && removeHint && (
              <p className="px-3 pb-1 pt-0.5 text-xs leading-snug opacity-60">
                {removeHint}
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
