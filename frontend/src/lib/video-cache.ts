// Optimistic-update helpers for the `['videos']` query cache.
//
// TanStack Query v5 idiomatic optimistic updates for paginated video data:
// the catalog is cached as multiple `['videos', params]` entries (one per
// page/filter/shelf combination). Mutations that flip `is_favorite` or
// `my_rating` need to patch *every* matching cached page so the UI reflects
// the change immediately across the grid, shelves, and hero.
//
// Flow used by `use-favorite` / `use-rating`:
//   1. `onMutate`:  cancelQueries → snapshotVideoQueries → patchVideoSummaries
//   2. `onError`:   restoreVideoQueries (rollback to snapshot)
//   3. `onSettled`: invalidateQueries (refetch authoritative state)

import type { QueryClient } from "@tanstack/react-query";

import type { VideoPageDto, VideoSummaryDto } from "../api/types";
import { VIDEOS_QUERY_KEY } from "../hooks/use-videos";

export type VideoSnapshot = Array<{
  queryKey: readonly unknown[];
  data: VideoPageDto | undefined;
}>;

/**
 * Capture the current state of every cached `['videos', …]` query so a
 * mutation can roll back on error. Returned objects are *references* into
 * the cache (TanStack stores immutable snapshots), so they're safe to hold
 * across an async boundary.
 */
export function snapshotVideoQueries(queryClient: QueryClient): VideoSnapshot {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: VIDEOS_QUERY_KEY })
    .map((q) => ({
      queryKey: q.queryKey,
      data: q.state.data as VideoPageDto | undefined,
    }));
}

/**
 * Apply `patcher` to every cached `VideoSummaryDto` whose `id === videoId`,
 * across all cached video pages. Pages not yet cached are left untouched
 * (they'll be fetched fresh on next observe).
 */
export function patchVideoSummaries(
  queryClient: QueryClient,
  videoId: string,
  patcher: (v: VideoSummaryDto) => VideoSummaryDto,
): void {
  queryClient.setQueriesData<VideoPageDto>(
    { queryKey: VIDEOS_QUERY_KEY },
    (old) => {
      if (!old) return old;
      let touched = false;
      const nextVideos = old.videos.map((v) => {
        if (v.id !== videoId) return v;
        touched = true;
        return patcher(v);
      });
      return touched ? { ...old, videos: nextVideos } : old;
    },
  );
}

/**
 * Roll back every cached `['videos', …]` entry to its snapshotted value.
 * No-ops for queries that no longer exist (e.g. were garbage-collected).
 */
export function restoreVideoQueries(
  queryClient: QueryClient,
  snapshot: VideoSnapshot,
): void {
  for (const { queryKey, data } of snapshot) {
    queryClient.setQueryData(queryKey, data);
  }
}
