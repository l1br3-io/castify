// `useSession` — the JS-visible source of truth for "who is logged in".
//
// The session cookie is HttpOnly and never readable from JS. This hook wraps
// the `['session']` TanStack Query, which is also populated by the
// `require-session` route loader. 401 from the backend is mapped to `null`
// inside `fetchSession` (not an error), so "logged out" is just `data === null`
// — not a query failure. Components and the layout read session state from
// here rather than each calling `GET /api/session` directly.

import { useQuery } from "@tanstack/react-query";
import { fetchSession } from "../api/session";
import type { OwnerDto } from "../api/types";

export const SESSION_QUERY_KEY = ["session"] as const;

export function useSession() {
  return useQuery<OwnerDto | null>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
  });
}
