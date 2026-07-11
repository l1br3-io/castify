// `useAvailableProviders` — which providers have OAuth credentials configured.
//
// Backed by `GET /api/connections/available` (auth-required). The
// `/connections` page uses this to disable "Connect" buttons for unconfigured
// providers and surface a `docs/config.md` setup hint (FR-8.2). Stable for the
// app's lifetime (env-only), so a long stale time avoids needless refetches.

import { useQuery } from "@tanstack/react-query";
import { fetchAvailableProviders } from "../api/connections";
import type { AvailableProviders } from "../api/types";

export const AVAILABLE_PROVIDERS_QUERY_KEY = ["available-providers"] as const;

const EMPTY: AvailableProviders = {
  google_drive: false,
  dropbox: false,
  onedrive: false,
};

export function useAvailableProviders() {
  return useQuery<AvailableProviders>({
    queryKey: AVAILABLE_PROVIDERS_QUERY_KEY,
    queryFn: fetchAvailableProviders,
    staleTime: 5 * 60 * 1000,
    placeholderData: EMPTY,
  });
}
