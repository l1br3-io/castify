// `useVideos` — unified deduplicated video catalog with pagination.
//
// The query key `['videos', { page, sort }]` is parameterized so page/sort
// changes fire a fresh query without stale overlap. `keepPreviousData` keeps
// the current page visible while the next loads, preventing a loading flash
// on every pagination or sort change.

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { fetchVideos } from "../api/videos";
import type { VideoSortKey } from "../api/types";

export const VIDEOS_QUERY_KEY = ["videos"] as const;

export interface UseVideosParams {
  page: number;
  sort: VideoSortKey;
}

export function useVideos({ page, sort }: UseVideosParams) {
  return useQuery({
    queryKey: [...VIDEOS_QUERY_KEY, { page, sort }] as const,
    queryFn: () => fetchVideos({ page, sort }),
    placeholderData: keepPreviousData,
  });
}
