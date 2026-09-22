// View mode — the per-device grid/list presentation preference
// (library-list-view spec §A).
//
// One global preference shared by every owner surface (browse, folder
// organizer, collections) — Drive's model. localStorage, not a URL param:
// view mode is device state, not deep-link state, and it's a single string
// per docs/data-storage-principles.md § localStorage (the use-theme.ts
// pattern, minus system-follow and the pre-paint script — view mode is
// never a FOUC concern).
//
// Single-writer assumption: each surface renders one toggle; two mounted
// instances on one page would not see each other's writes without a
// storage event listener. No such page exists today; add one only if a
// surface ever stacks two independent grids with separate toggles.

import { useState } from "react";

export type ViewMode = "grid" | "list";

const STORAGE_KEY = "castify-view-mode";

function readStoredMode(): ViewMode | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "grid" || value === "list" ? value : null;
  } catch {
    return null;
  }
}

export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setModeState] = useState<ViewMode>(() => readStoredMode() ?? "grid");

  function setMode(next: ViewMode): void {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable — keep the in-memory state. */
    }
  }

  return [mode, setMode];
}
