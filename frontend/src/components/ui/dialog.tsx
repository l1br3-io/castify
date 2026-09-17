// Dialog — controlled modal (see ui/README.md § Dialog). Extracted from
// the overlay hand-rolled in share-dialog.tsx (plain `fixed inset-0`
// overlay, no portal — the routes hosting dialogs have no clipping traps).
//
// Contract: role=dialog + aria-modal labelled by `title`; on open, focus
// moves to the first focusable element (panel itself as fallback) and the
// previously focused element is captured; Tab wraps inside the panel;
// Escape and backdrop click call onClose; on close, focus returns to the
// captured element.
//
// Gotcha: `closeable={false}` silences Escape AND backdrop click — the
// share dialog's post-creation state must be dismissed deliberately (Done),
// never by a stray keypress, and not mid-POST either.

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type DialogProps = {
  open: boolean;
  onClose: () => void;
  /** Heading text and accessible name. */
  title: string;
  /** Escape/backdrop close. Default true. */
  closeable?: boolean;
  children: ReactNode;
  /** Action row rendered at the panel's end. */
  footer?: ReactNode;
};

export function Dialog({
  open,
  onClose,
  title,
  closeable = true,
  children,
  footer,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();
    return () => {
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !closeable) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, closeable, onClose]);

  if (!open) return null;

  function handleKeyDown(e: ReactKeyboardEvent): void {
    if (e.key !== "Tab") return;
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      role="presentation"
      onClick={closeable ? onClose : undefined}
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-black/50 p-4"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="w-full max-w-md rounded-[var(--radius-drawer)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-6 shadow-lg"
      >
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <div className="mt-4 space-y-4">{children}</div>
        {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
