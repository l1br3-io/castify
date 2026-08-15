// `useFolderDir` — the organizer's selected folder, URL-backed (M9 FR-9).
//
// `?dir=<path>` selects the tree node: absent/empty = library root.
// Distinct from the pre-existing `?folder=` param (top-level video filter,
// `lib/filter-state.ts`) — different lifecycle: organizer navigation vs
// grid filtering. Selections PUSH a history entry (file-browser mental
// model, like GitHub tree nav) so back/forward walks folder history
// (FR-9.1). The `{ replace: true }` option is for corrections — e.g. the
// invalid-dir fallback — where pushing would trap Back in a loop.

import { useSearchParams } from "react-router-dom";

export function useFolderDir(): [
  string,
  (dir: string, options?: { replace?: boolean }) => void,
] {
  const [searchParams, setSearchParams] = useSearchParams();
  const dir = searchParams.get("dir") ?? "";

  function setDir(next: string, options?: { replace?: boolean }): void {
    const params = new URLSearchParams(searchParams);
    if (next === "") {
      params.delete("dir");
    } else {
      params.set("dir", next);
    }
    setSearchParams(params, options?.replace ? { replace: true } : undefined);
  }

  return [dir, setDir];
}
