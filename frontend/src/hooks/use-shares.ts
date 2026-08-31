// `useShares` — the owner's share management list (task 011).
//
// One `GET /api/shares` per mount, no polling: shares only change when the
// owner acts (create/revoke), and those flows invalidate
// `SHARES_QUERY_KEY` themselves. The creation dialogs (task 012) reuse the
// same key.
//
// `enabled` (share-management task 003) lets a consumer observe the shared
// cache without triggering a fetch — the ShareDialog's "Add to existing"
// picker passes `mode === "existing"`, so the list is only fetched when
// the picker is actually opened (a previously-cached Settings list still
// shows instantly).

import { useQuery } from "@tanstack/react-query";
import { fetchShares } from "../api/shares";
import type { ShareDto } from "../api/shares";

export const SHARES_QUERY_KEY = ["shares"] as const;

/** Absolute URL for a stored relative share path (`/share/{token}`). */
export function absoluteShareUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export function useShares(enabled = true) {
  return useQuery<ShareDto[]>({
    queryKey: SHARES_QUERY_KEY,
    queryFn: fetchShares,
    enabled,
  });
}
