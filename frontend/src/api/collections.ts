// Collections API (docs/specs/library-collections, spec F3): collection
// CRUD/membership.
//
// Mirrors the Rust DTOs in `crates/api/src/routes/collections.rs`. All
// mutations ride `apiFetch`'s CSRF injection; membership is video-only by
// construction on the backend.

import { apiFetch } from "./client";
import type {
  CollectionDetailDto,
  CollectionDto,
  CollectionMetaDto,
} from "./types";

/**
 * TanStack Query key factory. Mutations invalidate `all` (list shape
 * changes) or `detail(id)` (membership/rename). `byVideo(id)` scopes the
 * picker's checkmark state.
 */
export const collectionsQueryKeys = {
  all: ["collections"] as const,
  detail: (id: string) => ["collections", id] as const,
  byVideo: (videoId: string) => ["collections", "video", videoId] as const,
};

/**
 * `GET /api/collections` — collections for the browse rail (spec F5).
 * `videoId` scopes a `contains_video` flag onto each row (the picker's
 * checkmark).
 */
export function fetchCollections(
  params: { videoId?: string } = {},
): Promise<CollectionDto[]> {
  const search = new URLSearchParams();
  if (params.videoId !== undefined && params.videoId !== "") {
    search.set("video_id", params.videoId);
  }
  const query = search.toString();
  return apiFetch<CollectionDto[]>(`/api/collections${query ? `?${query}` : ""}`);
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
