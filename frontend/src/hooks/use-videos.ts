// `useVideos` — unified deduplicated video catalog with pagination + filters.
//
// The query key spreads the full params object so different filter
// combinations cache separately. `keepPreviousData` keeps the current page
// visible while the next loads, preventing a loading flash on every
// pagination, sort, or filter change.
//
// T10 will migrate `sort`/`page` (and the new filters) into URL search params
// for deep-linking; that migration is a no-op for this hook — callers pass
// whatever params they want, regardless of where the values come from.

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { fetchVideos } from "../api/videos";
import type { VideoSortKey } from "../api/types";

export const VIDEOS_QUERY_KEY = ["videos"] as const;

export interface UseVideosParams {
  page: number;
  sort: VideoSortKey;
  // All filters below are optional — omitted = filter not applied (matches
  // the backend's `VideoFilter` Option fields). T7's BrowsePage only passes
  // `page` + `sort`; the other fields exist so T8 (shelves), T9 (search),
  // and T10 (filter panel) can call `useVideos` with the same hook.
  q?: string;
  provider?: string;
  duration_min?: number;
  duration_max?: number;
  min_height?: number;
  favorites_only?: boolean;
  min_rating?: number;
  folder?: string;
  limit?: number;
}

export function useVideos(params: UseVideosParams) {
  return useQuery({
    queryKey: [...VIDEOS_QUERY_KEY, params] as const,
    queryFn: () => fetchVideos(params),
    placeholderData: keepPreviousData,
  });
}
