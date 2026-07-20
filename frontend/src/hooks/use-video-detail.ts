// `useVideoDetail` — full video metadata for the player page.
//
// Wraps `GET /api/videos/{id}` (VideoDetailDto). The query key is under the
// `['videos']` namespace so favorite/rating cache invalidation (T11) also
// refreshes the detail. No `keepPreviousData` — an id change (queue skip)
// should show a fresh loading skeleton, not stale video metadata.

import { useQuery } from "@tanstack/react-query";

import { fetchVideoDetail } from "../api/videos";

export function videoDetailQueryKey(id: string) {
  return ["videos", id] as const;
}

export function useVideoDetail(id: string | undefined) {
  return useQuery({
    queryKey: videoDetailQueryKey(id!),
    queryFn: () => fetchVideoDetail(id!),
    enabled: !!id,
  });
}
