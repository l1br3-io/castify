import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useViewMode } from "./use-view-mode";

// View mode is per-device state (library-list-view spec §A): one global
// "grid" | "list" preference in localStorage, "grid" default, storage
// failures non-fatal. Simpler than use-theme by design — no system-follow,
// no pre-paint script (view mode is never a FOUC concern).

describe("useViewMode", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to grid with nothing stored", () => {
    const { result } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("grid");
  });

  it("reads a persisted list preference", () => {
    window.localStorage.setItem("castify-view-mode", "list");
    const { result } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("list");
  });

  it("falls back to grid on an unknown stored value", () => {
    window.localStorage.setItem("castify-view-mode", "gallery");
    const { result } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("grid");
  });

  it("setMode updates state and persists", () => {
    const { result } = renderHook(() => useViewMode());
    act(() => result.current[1]("list"));
    expect(result.current[0]).toBe("list");
    expect(window.localStorage.getItem("castify-view-mode")).toBe("list");
  });

  it("swallows storage failures — in-memory state still works", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const { result } = renderHook(() => useViewMode());
    act(() => result.current[1]("list"));
    expect(result.current[0]).toBe("list");
    vi.mocked(Storage.prototype.setItem).mockRestore();
  });

  it("syncs two mounted instances on the same page (the browse stacks two toggles)", () => {
    const a = renderHook(() => useViewMode());
    const b = renderHook(() => useViewMode());
    act(() => a.result.current[1]("list"));
    expect(b.result.current[0]).toBe("list");
    act(() => b.result.current[1]("grid"));
    expect(a.result.current[0]).toBe("grid");
  });
});
