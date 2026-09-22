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
// The browse page stacks two independently-owned toggles (the All-videos
// section and the folder organizer below it), so hook instances must see
// each other's writes. `useSyncExternalStore` over an in-page emitter +
// the storage event: the emitter covers same-document writes (the storage
// event fires only in OTHER documents), the storage event covers other
// tabs.

import { useCallback, useSyncExternalStore } from "react";

export type ViewMode = "grid" | "list";

const STORAGE_KEY = "castify-view-mode";

const listeners = new Set<() => void>();

// In-page fallback for when the storage write fails (quota, private
// mode): pins the mode so this page still updates. When writes land,
// storage stays the single source of truth — the mirror stays empty.
let memoryMode: ViewMode | null = null;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readStoredMode(): ViewMode {
  if (memoryMode !== null) return memoryMode;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "grid" || value === "list" ? value : "grid";
  } catch {
    return "grid";
  }
}

function writeStoredMode(mode: ViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
    memoryMode = null;
  } catch {
    memoryMode = mode;
  }
}

export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const mode = useSyncExternalStore(
    subscribe,
    readStoredMode,
    (): ViewMode => "grid",
  );

  const setMode = useCallback((next: ViewMode) => {
    writeStoredMode(next);
    // Same-document notify — the storage event never fires for the writer.
    for (const listener of listeners) listener();
  }, []);

  return [mode, setMode];
}
