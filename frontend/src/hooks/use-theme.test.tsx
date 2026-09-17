import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useTheme } from "./use-theme";

// The hook branches on matchMedia results; jsdom's media evaluation is a
// no-op stub. Each test installs the system-preference state it needs.
// D5: paper-first — the hook listens for system DARK; `matches: true`
// means the system prefers dark.
type MediaListener = (e: { matches: boolean }) => void;

function installMatchMedia(prefersDark: boolean) {
  const listeners = new Set<MediaListener>();
  const mql = {
    matches: prefersDark,
    addEventListener: (_type: string, l: MediaListener) => listeners.add(l),
    removeEventListener: (_type: string, l: MediaListener) =>
      listeners.delete(l),
  };
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
  return {
    // Flip the reported system preference and notify subscribers, as a
    // real MediaQueryListEvent would.
    emit: (matches: boolean) => {
      mql.matches = matches;
      listeners.forEach((l) => l({ matches }));
    },
  };
}

describe("useTheme (paper-first)", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to light with no explicit choice and no system preference", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });

  it("honors a system-dark preference when nothing is pinned", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("lets an explicit data-theme attribute win over the system preference", () => {
    document.documentElement.setAttribute("data-theme", "light");
    installMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });

  it("toggle flips light→dark, pins the attribute, and persists the choice", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("castify-theme")).toBe("dark");
  });

  it("follows system changes only while no explicit choice is stored", () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");

    // System flips to dark while implicit — theme follows, stays unpinned.
    act(() => media.emit(true));
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();

    // Once the user pins a choice, system changes must not move it.
    act(() => result.current.setTheme("light"));
    act(() => media.emit(true));
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
