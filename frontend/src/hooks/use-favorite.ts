// `useSetFavorite` / `useUnsetFavorite` — favorite mutations (T6 backend).
//
// On success, invalidates the whole `['videos']` cache so every surface
// (grid, shelves, hero) refetches with the updated `is_favorite`. T11 wires
// these to the FavoriteToggle UI; T7 just owns the cache-invalidation
// contract so T11 doesn't need to touch it.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { setFavorite, unsetFavorite } from "../api/videos";
import { VIDEOS_QUERY_KEY } from "./use-videos";

export function useSetFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (videoId: string) => setFavorite(videoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
    },
  });
}

export function useUnsetFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (videoId: string) => unsetFavorite(videoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
    },
  });
}
