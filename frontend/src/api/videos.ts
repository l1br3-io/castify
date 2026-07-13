// Video catalog: unified deduplicated list across all connected providers.
//
// `GET /api/videos` returns a paginated, deduplicated list. Videos sharing a
// `dedup_group` appear as one entry with a `sources` array listing each
// provider copy. The M2 T3 query refactor added FTS5 search, filters
// (duration/resolution/folder/favorites/rating), direction-aware sort, and
// enriched `VideoSummary` (is_favorite/my_rating/thumbnail_status/created_at/path).
//
// Mutation routes (T6): favorites + ratings. Each handler echoes the
// post-mutation state in the response body so callers can update their cache
// without a refetch.

import { apiFetch } from "./client";
import type {
  FavoriteResponseDto,
  FolderDto,
  RatingRequestDto,
  RatingResponseDto,
  VideoPageDto,
  VideoSortKey,
} from "./types";

export interface VideoListParams {
  page?: number;
  limit?: number;
  sort?: VideoSortKey;
  provider?: string;
  // M2 T3 extensions (all optional — omitted = filter not applied).
  q?: string;
  duration_min?: number;
  duration_max?: number;
  min_height?: number;
  favorites_only?: boolean;
  min_rating?: number;
  folder?: string;
}

/**
 * `GET /api/videos` — paginated, deduplicated video catalog.
 * Composable filters + search + sort (see PRD FR-2/FR-3/FR-4).
 */
export function fetchVideos(params: VideoListParams = {}): Promise<VideoPageDto> {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.sort !== undefined) search.set("sort", params.sort);
  if (params.provider !== undefined) search.set("provider", params.provider);
  if (params.q !== undefined && params.q !== "") search.set("q", params.q);
  if (params.duration_min !== undefined)
    search.set("duration_min", String(params.duration_min));
  if (params.duration_max !== undefined)
    search.set("duration_max", String(params.duration_max));
  if (params.min_height !== undefined)
    search.set("min_height", String(params.min_height));
  if (params.favorites_only !== undefined)
    search.set("favorites_only", String(params.favorites_only));
  if (params.min_rating !== undefined)
    search.set("min_rating", String(params.min_rating));
  if (params.folder !== undefined && params.folder !== "")
    search.set("folder", params.folder);

  const query = search.toString();
  return apiFetch<VideoPageDto>(`/api/videos${query ? `?${query}` : ""}`);
}

/**
 * `GET /api/videos/folders` — top-level folder enumeration (dedup-aware).
 */
export function fetchFolders(): Promise<FolderDto[]> {
  return apiFetch<FolderDto[]>("/api/videos/folders");
}

/**
 * `POST /api/videos/{id}/favorite` — idempotent favorite add (CSRF).
 * Returns the post-mutation state (`{ is_favorite: true }`).
 */
export function setFavorite(
  videoId: string,
): Promise<FavoriteResponseDto> {
  return apiFetch<FavoriteResponseDto>(
    `/api/videos/${encodeURIComponent(videoId)}/favorite`,
    { method: "POST" },
  );
}

/**
 * `DELETE /api/videos/{id}/favorite` — idempotent favorite remove (CSRF).
 * Returns the post-mutation state (`{ is_favorite: false }`).
 */
export function unsetFavorite(
  videoId: string,
): Promise<FavoriteResponseDto> {
  return apiFetch<FavoriteResponseDto>(
    `/api/videos/${encodeURIComponent(videoId)}/favorite`,
    { method: "DELETE" },
  );
}

/**
 * `PUT /api/videos/{id}/rating` — create/update rating (CSRF).
 * Backend validates 1..=5 and returns 400 on out-of-range.
 */
export function setRating(
  videoId: string,
  rating: number,
): Promise<RatingResponseDto> {
  return apiFetch<RatingResponseDto>(
    `/api/videos/${encodeURIComponent(videoId)}/rating`,
    { method: "PUT", body: { rating } satisfies RatingRequestDto },
  );
}

/**
 * `DELETE /api/videos/{id}/rating` — idempotent rating clear (CSRF).
 * Returns `{ my_rating: null }`.
 */
export function unsetRating(
  videoId: string,
): Promise<RatingResponseDto> {
  return apiFetch<RatingResponseDto>(
    `/api/videos/${encodeURIComponent(videoId)}/rating`,
    { method: "DELETE" },
  );
}
