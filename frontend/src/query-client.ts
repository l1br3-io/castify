// Shared TanStack Query client singleton.
//
// Production-wide defaults live here. Loaders (e.g. `require-session`) call
// `queryClient.fetchQuery(...)` to populate the cache before a route renders,
// so the component tree reads from cache on first paint instead of
// refetching. Tests build their own `QueryClient` per-render (see
// `src/test/utils.tsx`) and don't touch this singleton.

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});
