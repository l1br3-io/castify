// `useSetFavorite` / `useUnsetFavorite` — favorite mutations (T6 backend).
//
// T11 upgrade: optimistic updates at the hook level. The mutation flips
// `is_favorite` on the matching video across every cached `['videos', …]`
// page *before* the network resolves, so the UI (grid + shelves + hero)
// reflects the change immediately. On error, the cache is rolled back to
// the pre-mutation snapshot. On settle, the catalog is invalidated to
// refetch authoritative state (the backend echoes post-mutation state, but
// invalidation keeps shelf counts and favorites-only queries honest too).
//
// Cache walking uses `lib/video-cache` so this hook + `use-rating` share
// the same snapshot/patch/restore plumbing.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { setFavorite, unsetFavorite } from "../api/videos";
import { VIDEOS_QUERY_KEY } from "./use-videos";
import {
  patchVideoSummaries,
  restoreVideoQueries,
  snapshotVideoQueries,
  type VideoSnapshot,
} from "../lib/video-cache";

interface OptimisticContext {
  snapshot: VideoSnapshot;
}

export function useSetFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (videoId: string) => setFavorite(videoId),
    onMutate: async (videoId): Promise<OptimisticContext> => {
      await queryClient.cancelQueries({ queryKey: VIDEOS_QUERY_KEY });
      const snapshot = snapshotVideoQueries(queryClient);
      patchVideoSummaries(queryClient, videoId, (v) => ({ ...v, is_favorite: true }));
      return { snapshot };
    },
    onError: (_err, _videoId, context) => {
      if (context) restoreVideoQueries(queryClient, context.snapshot);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
    },
  });
}

export function useUnsetFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (videoId: string) => unsetFavorite(videoId),
    onMutate: async (videoId): Promise<OptimisticContext> => {
      await queryClient.cancelQueries({ queryKey: VIDEOS_QUERY_KEY });
      const snapshot = snapshotVideoQueries(queryClient);
      patchVideoSummaries(queryClient, videoId, (v) => ({ ...v, is_favorite: false }));
      return { snapshot };
    },
    onError: (_err, _videoId, context) => {
      if (context) restoreVideoQueries(queryClient, context.snapshot);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
    },
  });
}
