// `useShares` — the owner's share management list (task 011).
//
// One `GET /api/shares` per mount, no polling: shares only change when the
// owner acts (create/revoke), and those flows invalidate
// `SHARES_QUERY_KEY` themselves. The creation dialogs (task 012) reuse the
// same key.

import { useQuery } from "@tanstack/react-query";
import { fetchShares } from "../api/shares";
import type { ShareDto } from "../api/shares";

export const SHARES_QUERY_KEY = ["shares"] as const;

/** Absolute URL for a stored relative share path (`/share/{token}`). */
export function absoluteShareUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export function useShares() {
  return useQuery<ShareDto[]>({
    queryKey: SHARES_QUERY_KEY,
    queryFn: fetchShares,
  });
}
