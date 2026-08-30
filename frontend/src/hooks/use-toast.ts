// `useToast` — React context + hook for the toast system.
//
// Lives separately from `ToastProvider` so the component file (`toast.tsx`)
// can satisfy `react-refresh/only-export-components` — provider in one file,
// hook + context in another. See the comment in `icons.tsx` for the
// established convention.
//
// Used anywhere a transient user-facing message is needed: optimistic
// rollback failures, background scan completion, sign-out, etc. The hook
// throws if used outside `<ToastProvider>`.

import { createContext, useContext } from "react";

export type ToastVariant = "success" | "error" | "info";

/** Inline action button on a toast (e.g. "Undo" on a removal toast). */
export type ToastAction = {
  label: string;
  onAction: () => void;
};

/** Per-push extras. `ttlMs` overrides the variant's default auto-dismiss
 * (an undo toast holds its window a touch longer than a plain info); the
 * action button dismisses the toast when activated. */
export type ToastOptions = {
  ttlMs?: number;
  action?: ToastAction;
};

export type ToastApi = {
  success: (message: string, options?: ToastOptions) => number;
  error: (message: string, options?: ToastOptions) => number;
  info: (message: string, options?: ToastOptions) => number;
  /** Remove one toast by the id its push returned — callers use this to
   * enforce single-slot semantics (a newer undo replaces the prior one). */
  dismiss: (id: number) => void;
};

export type Toast = {
  id: number;
  variant: ToastVariant;
  message: string;
  action?: ToastAction;
};

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}
