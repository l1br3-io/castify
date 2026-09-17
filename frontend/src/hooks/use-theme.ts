// Theme toggle — paper-first light/dark with persistence.
//
// The inline script in index.html applies the persisted theme before first
// paint to avoid FOUC. This hook is the React-side counterpart: it tracks
// the current theme in state, keeps <html data-theme="…"> in sync, and
// writes the user's choice to localStorage.
//
// Castify is paper-first (D5): Classical's editorial ground is the default
// with no explicit choice anywhere. Only an explicit system-dark preference
// — or a user choice — brings the colophon theme. Setting a theme always
// writes localStorage, which pins the choice and opts the document out of
// the `@media (prefers-color-scheme: dark)` override in index.css.

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "castify-theme";

function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  // No explicit choice — dark only when the system asks for it; paper is
  // the default (paper-first), covering system-light and no-preference.
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable — keep the in-memory + DOM state. */
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  // Follow system changes only when the user hasn't picked explicitly.
  // The pin is re-checked per event — a choice made after mount must stop
  // the system from overwriting it.
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    if (readStoredTheme() !== null) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      if (readStoredTheme() !== null) return;
      const next: Theme = e.matches ? "dark" : "light";
      setThemeState(next);
      // Do not write localStorage — let the choice stay implicit.
      document.documentElement.removeAttribute("data-theme");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return { theme, setTheme, toggle };
}
