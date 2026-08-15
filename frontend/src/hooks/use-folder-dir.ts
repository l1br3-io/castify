// `useFolderDir` — the organizer's selected folder, URL-backed (M9 FR-9).
//
// `?dir=<path>` selects the tree node: absent/empty = library root.
// Distinct from the pre-existing `?folder=` param (top-level video filter,
// `lib/filter-state.ts`) — different lifecycle: organizer navigation vs
// grid filtering. `replace: true` keeps folder browsing from flooding
// history within a folder; back/forward still moves between folder
// selections because each selection is a distinct URL.

import { useSearchParams } from "react-router-dom";

export function useFolderDir(): [string, (dir: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const dir = searchParams.get("dir") ?? "";

  function setDir(next: string): void {
    const params = new URLSearchParams(searchParams);
    if (next === "") {
      params.delete("dir");
    } else {
      params.set("dir", next);
    }
    setSearchParams(params, { replace: true });
  }

  return [dir, setDir];
}
