// `useShareItemsOwned` — the owner-side members read for one share.
//
// Lives in hooks/ (share-manage-page task 002) so the edit dialog and the
// manage page share one cache entry and one invalidation target: the key
// below is the single source of identity for "this share's current items
// in curation order".
//
// Consumers must remember: after any successful `PUT /api/shares/{id}/items`,
// this entry is known-stale, and the app-wide 30s staleTime would otherwise
// serve the pre-edit list to the next mount. Mutations that change
// membership should `removeQueries(shareItemsOwnedKey(id))` (or invalidate
// and drop) on success — see `share-edit-dialog.tsx`'s save flow.
//
// `enabled` (share-management task 003) lets a consumer hold the hook
// unconditionally while nothing is selected — the ShareDialog's picker
// passes a placeholder id gated on selection, so no empty-id query ever
// fires.

import { useQuery } from "@tanstack/react-query";
import { fetchShareItemsOwned } from "../api/shares";

export const shareItemsOwnedKey = (shareId: string) =>
  ["share-items-owned", shareId] as const;

export function useShareItemsOwned(shareId: string, enabled = true) {
  return useQuery({
    queryKey: shareItemsOwnedKey(shareId),
    queryFn: () => fetchShareItemsOwned(shareId),
    enabled,
  });
}
