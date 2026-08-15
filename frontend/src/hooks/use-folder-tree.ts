// `useFolderTree` — nested folder tree over `videos ∪ files` (M9 FR-4).
//
// Wraps `GET /api/folders/tree`. Invalidation: connections.tsx refreshes
// this key (plus folder-contents) on rescan/disconnect success — scans
// mutate the paths and counts the tree is derived from.

import { useQuery } from "@tanstack/react-query";

import { fetchFolderTree } from "../api/folders";

export const FOLDER_TREE_QUERY_KEY = ["folder-tree"] as const;

export function useFolderTree() {
  return useQuery({
    queryKey: FOLDER_TREE_QUERY_KEY,
    queryFn: fetchFolderTree,
  });
}
