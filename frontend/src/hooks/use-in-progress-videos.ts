// `useInProgressVideos` — IndexedDB-backed continue-watching shelf data.
//
// Per `docs/data-storage-principles.md` (anti-pattern #3, "Server endpoints
// for per-device data"), the shelf reads exclusively from IndexedDB — zero
// server calls. The backend's `GET /api/videos?in_progress=true` filter and
// `playback_progress` table are dormant legacy code from the original
// server-side design; this hook is the canonical source.
//
// TanStack Query wraps the read for caching + refetch orchestration. The
// query is automatically re-run on mount (returning from `/watch/:id` after
// a save) and on window focus (multi-tab), which covers the "watched part
// of a video, hit back, expect the shelf to reflect it" path with no
// explicit invalidation wiring.
//
// `queryKey` is exported so the watch page can `invalidateQueries` on save
// if the auto-refetch paths ever prove insufficient — kept as an extension
// point, currently unused.

import { useQuery } from "@tanstack/react-query";

import { getInProgressVideos, type ProgressEntry } from "../lib/player-db";

export const IN_PROGRESS_QUERY_KEY = ["in-progress"] as const;

export const IN_PROGRESS_DEFAULT_LIMIT = 20;

export function useInProgressVideos(limit: number = IN_PROGRESS_DEFAULT_LIMIT) {
  return useQuery<ProgressEntry[]>({
    queryKey: [...IN_PROGRESS_QUERY_KEY, limit] as const,
    queryFn: () => getInProgressVideos(limit),
  });
}
