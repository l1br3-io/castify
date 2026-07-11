// Video catalog: unified deduplicated list across all connected providers.
//
// `GET /api/videos` returns a paginated, deduplicated list. Videos sharing a
// `dedup_group` appear as one entry with a `sources` array listing each
// provider copy. See FR-5 (unified video list) + FR-6 (deduplication).

import { apiFetch } from "./client";
import type { VideoPageDto, VideoSortKey } from "./types";

export interface VideoListParams {
  page?: number;
  limit?: number;
  sort?: VideoSortKey;
  provider?: string;
}

/**
 * `GET /api/videos` — paginated, deduplicated video catalog.
 * Query params: `page` (default 1), `limit` (default 50, max 200),
 * `sort` (`date-desc` | `name` | `size`), `provider` (optional filter).
 */
export function fetchVideos(params: VideoListParams = {}): Promise<VideoPageDto> {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.sort !== undefined) search.set("sort", params.sort);
  if (params.provider !== undefined) search.set("provider", params.provider);

  const query = search.toString();
  return apiFetch<VideoPageDto>(`/api/videos${query ? `?${query}` : ""}`);
}
