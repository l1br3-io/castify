// `useSetRating` / `useUnsetRating` — rating mutations (T6 backend).
//
// T11 upgrade: optimistic updates at the hook level, mirroring `use-favorite`.
// The mutation writes `my_rating` (or `null` for unset) on the matching
// video across every cached `['videos', …]` page before the network resolves.
// The backend validates 1..=5 (400 on out-of-range); callers should still
// validate client-side to avoid a network round-trip for an obvious error.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { setRating, unsetRating } from "../api/videos";
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

export function useSetRating() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ videoId, rating }: { videoId: string; rating: number }) =>
      setRating(videoId, rating),
    onMutate: async ({ videoId, rating }): Promise<OptimisticContext> => {
      await queryClient.cancelQueries({ queryKey: VIDEOS_QUERY_KEY });
      const snapshot = snapshotVideoQueries(queryClient);
      patchVideoSummaries(queryClient, videoId, (v) => ({ ...v, my_rating: rating }));
      return { snapshot };
    },
    onError: (_err, _args, context) => {
      if (context) restoreVideoQueries(queryClient, context.snapshot);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
    },
  });
}

export function useUnsetRating() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (videoId: string) => unsetRating(videoId),
    onMutate: async (videoId): Promise<OptimisticContext> => {
      await queryClient.cancelQueries({ queryKey: VIDEOS_QUERY_KEY });
      const snapshot = snapshotVideoQueries(queryClient);
      patchVideoSummaries(queryClient, videoId, (v) => ({ ...v, my_rating: null }));
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
