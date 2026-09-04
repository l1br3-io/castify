// `useAvailableProviders` — the provider catalog: who can be connected and
// how (OAuth round-trip vs credentials form).
//
// Backed by `GET /api/connections/available` (auth-required). The
// `/connections` page uses `configured` to hide unconfigured OAuth
// providers (surfacing a `docs/config.md` setup hint when none are) and
// `authMode` to pick the connect UX. Stable for the app's lifetime
// (env-only), so a long stale time avoids needless refetches.

import { useQuery } from "@tanstack/react-query";
import { fetchAvailableProviders } from "../api/connections";
import type { AvailableProviders } from "../api/types";

export const AVAILABLE_PROVIDERS_QUERY_KEY = ["available-providers"] as const;

const EMPTY: AvailableProviders = [];

export function useAvailableProviders() {
  return useQuery<AvailableProviders>({
    queryKey: AVAILABLE_PROVIDERS_QUERY_KEY,
    queryFn: fetchAvailableProviders,
    staleTime: 5 * 60 * 1000,
    placeholderData: EMPTY,
  });
}
