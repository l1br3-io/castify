// `useSetRating` / `useUnsetRating` — rating mutations (T6 backend).
//
// On success, invalidates the whole `['videos']` cache so every surface
// (grid, shelves, hero) refetches with the updated `my_rating`. The backend
// validates 1..=5 (400 on out-of-range); callers should still validate
// client-side to avoid a network round-trip for an obvious error.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { setRating, unsetRating } from "../api/videos";
import { VIDEOS_QUERY_KEY } from "./use-videos";

export function useSetRating() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ videoId, rating }: { videoId: string; rating: number }) =>
      setRating(videoId, rating),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
    },
  });
}

export function useUnsetRating() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (videoId: string) => unsetRating(videoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
    },
  });
}
