// `useFolders` — top-level folder enumeration (dedup-aware).
//
// Wraps `GET /api/videos/folders`. The query key is the standard array form
// so T11 can invalidate it after a favorite/rating mutation if folder counts
// ever need refreshing (currently folder counts are dedup-aware, not
// favorite-aware, so invalidation isn't strictly required — kept as an
// extension point).
//
// T8 (shelves) consumes this for "By Folder" shelf headers; T10 (filter
// panel) consumes it for the folder dropdown. T7 creates the hook per the
// plan but does not yet use it.

import { useQuery } from "@tanstack/react-query";

import { fetchFolders } from "../api/videos";

export const FOLDERS_QUERY_KEY = ["folders"] as const;

export function useFolders() {
  return useQuery({
    queryKey: FOLDERS_QUERY_KEY,
    queryFn: fetchFolders,
  });
}
