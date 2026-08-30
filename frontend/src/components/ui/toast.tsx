// ToastProvider — top-level provider that renders the toast viewport.
//
// The hook + context live in `src/hooks/use-toast.ts`. This file owns the
// provider component, the viewport, and the per-variant styling. The audit
// (design-pass §6) lists the wiring targets: optimistic rollbacks in
// `use-favorite.ts` / `use-rating.ts`, scan completion in
// `use-connections.ts`, sign-out in `app-layout.tsx`, etc.
//
// Variants:
//   * success — accent stripe, auto-dismiss after 4s
//   * error   — accent-dim stripe, sticky until dismissed
//   * info    — muted stripe, auto-dismiss after 4s
//
// Per-push options (share-manage-page task 001): an action button (e.g.
// "Undo" — activates then dismisses) and a `ttlMs` override. Pushes return
// the toast id and the api exposes `dismiss(id)` so a page can replace its
// own prior toast (single-slot undo).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { CloseIcon } from "../icons";
import {
  ToastContext,
  type Toast,
  type ToastApi,
  type ToastOptions,
  type ToastVariant,
} from "../../hooks/use-toast";

const AUTO_DISMISS_MS: Record<ToastVariant, number | null> = {
  success: 4000,
  error: null, // sticky
  info: 4000,
};

let nextToastId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timeouts = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const handle = timeouts.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timeouts.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (variant: ToastVariant, message: string, options?: ToastOptions) => {
      const id = nextToastId++;
      setToasts((list) => [
        ...list,
        { id, variant, message, action: options?.action },
      ]);
      const ttl = options?.ttlMs ?? AUTO_DISMISS_MS[variant];
      if (ttl !== null) {
        const handle = setTimeout(() => dismiss(id), ttl);
        timeouts.current.set(id, handle);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const handles = timeouts.current;
    return () => {
      handles.forEach((h) => clearTimeout(h));
      handles.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, options) => push("success", m, options),
      error: (m, options) => push("error", m, options),
      info: (m, options) => push("info", m, options),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  // Bottom-right on sm+ screens, top on mobile (avoids clashing with device
  // gestures at the bottom edge on iOS / Android).
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-3 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:top-auto sm:items-end sm:px-0"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  const stripeColor =
    toast.variant === "success"
      ? "bg-[var(--color-castify-accent)]"
      : toast.variant === "error"
        ? "bg-[var(--color-castify-accent-dim)]"
        : "bg-[var(--color-castify-muted)]";

  return (
    <div
      role={toast.variant === "error" ? "alert" : "status"}
      className="pointer-events-auto flex w-full max-w-sm items-stretch overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface-raised)] shadow-lg"
      style={{ animation: "toast-in 200ms ease-out" }}
    >
      <div className={`w-1 ${stripeColor}`} aria-hidden />
      <div className="flex-1 px-4 py-3 text-sm">{toast.message}</div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            // Activate, then dismiss — the action's window closes with the
            // toast (an expired Undo button must not linger).
            toast.action?.onAction();
            onDismiss();
          }}
          className="self-center whitespace-nowrap px-2 text-sm font-semibold text-[var(--color-castify-accent)] transition hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="px-3 text-[var(--color-castify-muted)] transition hover:text-[var(--color-castify-text)]"
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
