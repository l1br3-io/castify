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

export type ToastApi = {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

export type Toast = {
  id: number;
  variant: ToastVariant;
  message: string;
};

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}
