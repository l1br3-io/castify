// Theme toggle — light/dark with persistence.
//
// The inline script in index.html applies the persisted theme before first
// paint to avoid FOUC. This hook is the React-side counterpart: it tracks
// the current theme in state, keeps <html data-theme="…"> in sync, and
// writes the user's choice to localStorage.
//
// When the user has never picked explicitly (no localStorage entry), the
// hook reports the value the media query resolved to so the toggle UI can
// show the right glyph. Setting a theme always writes localStorage, which
// opts the document out of the `:root:not([data-theme="light"])` rule and
// pins the choice.

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "castify-theme";

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  // No explicit choice — defer to prefers-color-scheme.
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
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const explicit = localStorage.getItem(STORAGE_KEY);
    if (explicit === "light" || explicit === "dark") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
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
