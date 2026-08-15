// `useFolderTree` — nested folder tree over `videos ∪ files` (M9 FR-4).
//
// Wraps `GET /api/folders/tree`. The query key is invalidated with the
// connection-scan churn the rest of the app already keys on — see BrowsePage
// wiring in task 013.

import { useQuery } from "@tanstack/react-query";

import { fetchFolderTree } from "../api/folders";

export const FOLDER_TREE_QUERY_KEY = ["folder-tree"] as const;

export function useFolderTree() {
  return useQuery({
    queryKey: FOLDER_TREE_QUERY_KEY,
    queryFn: fetchFolderTree,
  });
}
