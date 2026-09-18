// Library-collections API (docs/specs/library-collections, spec F2/F3):
// suggestion review + collection CRUD/membership.
//
// Mirrors the Rust DTOs in `crates/api/src/routes/collections.rs`. All
// mutations ride `apiFetch`'s CSRF injection; membership is video-only by
// construction on the backend.

import { apiFetch } from "./client";
import type {
  AcceptedCollectionDto,
  CollectionDetailDto,
  CollectionDto,
  CollectionMetaDto,
  CollectionSuggestionDto,
} from "./types";

/**
 * TanStack Query key factory. Mutations invalidate `all` (list shape
 * changes) or `detail(id)` (membership/rename), plus `suggestions`
 * after accept/dismiss — the review panel's queue shrinks as the user
 * works through it.
 */
export const collectionsQueryKeys = {
  all: ["collections"] as const,
  detail: (id: string) => ["collections", id] as const,
  suggestions: ["collections", "suggestions"] as const,
};

/** `GET /api/collections` — collections for the browse rail (spec F5). */
export function fetchCollections(): Promise<CollectionDto[]> {
  return apiFetch<CollectionDto[]>("/api/collections");
}

/** `GET /api/collections/{id}` — collection with ordered members. */
export function fetchCollection(id: string): Promise<CollectionDetailDto> {
  return apiFetch<CollectionDetailDto>(
    `/api/collections/${encodeURIComponent(id)}`,
  );
}

/** `POST /api/collections` — manual creation (kind forced to manual). */
export function createCollection(name: string): Promise<CollectionDto> {
  return apiFetch<CollectionDto>("/api/collections", {
    method: "POST",
    body: { name },
  });
}

/** `PATCH /api/collections/{id}` — rename (time groups are editable). */
export function renameCollection(
  id: string,
  name: string,
): Promise<CollectionMetaDto> {
  return apiFetch<CollectionMetaDto>(`/api/collections/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { name },
  });
}

/** `DELETE /api/collections/{id}` — membership cascades server-side. */
export function deleteCollection(id: string): Promise<void> {
  return apiFetch<void>(`/api/collections/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** `POST /api/collections/{id}/items/{videoId}` — append a video. */
export function addCollectionItem(
  collectionId: string,
  videoId: string,
): Promise<void> {
  return apiFetch<void>(
    `/api/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(videoId)}`,
    { method: "POST" },
  );
}

/** `DELETE /api/collections/{id}/items/{videoId}` — remove a video. */
export function removeCollectionItem(
  collectionId: string,
  videoId: string,
): Promise<void> {
  return apiFetch<void>(
    `/api/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(videoId)}`,
    { method: "DELETE" },
  );
}

/** `PUT /api/collections/{id}/items` — replace membership with an order. */
export function replaceCollectionItems(
  collectionId: string,
  videoIds: string[],
): Promise<void> {
  return apiFetch<void>(
    `/api/collections/${encodeURIComponent(collectionId)}/items`,
    { method: "PUT", body: { video_ids: videoIds } },
  );
}

export interface SuggestionsParams {
  /** Max groups (server default 20, cap 100). */
  limit?: number;
  /** Max member summaries per group (server default 4, cap 50). */
  preview?: number;
}

/** `GET /api/collections/suggestions` — the post-scan review queue. */
export function fetchCollectionSuggestions(
  params: SuggestionsParams = {},
): Promise<CollectionSuggestionDto[]> {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.preview !== undefined)
    search.set("preview", String(params.preview));
  const query = search.toString();
  return apiFetch<CollectionSuggestionDto[]>(
    `/api/collections/suggestions${query ? `?${query}` : ""}`,
  );
}

/** `POST …/suggestions/{id}/accept` — suggestion becomes a collection. */
export function acceptCollectionSuggestion(
  suggestionId: string,
): Promise<AcceptedCollectionDto> {
  return apiFetch<AcceptedCollectionDto>(
    `/api/collections/suggestions/${encodeURIComponent(suggestionId)}/accept`,
    { method: "POST" },
  );
}

/** `POST …/suggestions/{id}/dismiss` — suppress by signature. */
export function dismissCollectionSuggestion(suggestionId: string): Promise<void> {
  return apiFetch<void>(
    `/api/collections/suggestions/${encodeURIComponent(suggestionId)}/dismiss`,
    { method: "POST" },
  );
}
