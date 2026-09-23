// Library-folders API (library-folders effort): the curated tree,
// contents, and placement mutations.
//
// Mirrors the Rust DTOs in `crates/api/src/routes/library_folders.rs`.
// Contents reuse the provider wire shapes (`FolderContentsPageDto`) so
// the organizer renders both listings with the same components.

import { apiFetch } from "./client";
import type {
  FolderContentsPageDto,
  LibraryFolderDto,
  LibraryTreeDto,
} from "./types";

/**
 * `GET /api/library-folders/tree` — flat folders with cumulative counts
 * + the Unfiled count. One fetch; the client builds the nested tree.
 */
export function fetchLibraryFolderTree(): Promise<LibraryTreeDto> {
  return apiFetch<LibraryTreeDto>("/api/library-folders/tree");
}

export interface LibraryContentsParams {
  /** Absent/undefined → the Unfiled bucket (NULL placement). */
  folder_id?: string;
  page?: number;
  limit?: number;
  kind?: string;
  q?: string;
}

/**
 * `GET /api/library-folders/contents` — mixed, paginated direct-item
 * listing; subfolder tiles derive from the tree query, not this one.
 */
export function fetchLibraryFolderContents(
  params: LibraryContentsParams = {},
): Promise<FolderContentsPageDto> {
  const search = new URLSearchParams();
  if (params.folder_id !== undefined && params.folder_id !== "")
    search.set("folder_id", params.folder_id);
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.kind !== undefined && params.kind !== "")
    search.set("kind", params.kind);
  if (params.q !== undefined && params.q !== "") search.set("q", params.q);

  const query = search.toString();
  return apiFetch<FolderContentsPageDto>(
    `/api/library-folders/contents${query ? `?${query}` : ""}`,
  );
}

/**
 * `POST /api/library-folders` — create a folder (tree root by default).
 */
export function createLibraryFolder(
  name: string,
  parentId?: string,
): Promise<LibraryFolderDto> {
  const body: { name: string; parent_id?: string } = { name };
  if (parentId !== undefined) body.parent_id = parentId;
  return apiFetch<LibraryFolderDto>("/api/library-folders", {
    method: "POST",
    body,
  });
}

/**
 * `PATCH /api/library-folders/{id}` — rename and/or reparent in one
 * write. `parent_id` is a double-option: the key absent (undefined)
 * leaves the parent alone; `null` moves to the tree root; an id moves
 * under that folder.
 */
export function updateLibraryFolder(
  id: string,
  patch: { name?: string; parent_id?: string | null },
): Promise<LibraryFolderDto> {
  const body: { name?: string; parent_id?: string | null } = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.parent_id !== undefined) body.parent_id = patch.parent_id;
  return apiFetch<LibraryFolderDto>(
    `/api/library-folders/${encodeURIComponent(id)}`,
    { method: "PATCH", body },
  );
}

/**
 * `DELETE /api/library-folders/{id}` — delete a folder; its items
 * return to Unfiled and its subfolders flatten to the root. 204.
 */
export function deleteLibraryFolder(id: string): Promise<void> {
  return apiFetch<void>(`/api/library-folders/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** One entry of a batch move: the id's namespace tag plus the id. */
export interface LibraryMoveItem {
  kind: "video" | "file";
  id: string;
}

/**
 * `PATCH /api/library-folders/items` — the batch move primitive. One
 * request, one transaction server-side: every item lands in `folderId`
 * (null → Unfiled) or the request fails whole.
 */
export function moveLibraryItems(
  items: LibraryMoveItem[],
  folderId: string | null,
): Promise<void> {
  return apiFetch<void>("/api/library-folders/items", {
    method: "PATCH",
    body: { items, folder_id: folderId },
  });
}

/**
 * `PATCH /api/library-folders/items/order` — reorder one folder's
 * contents. The body carries the FULL ordered item list for the scope
 * (exactly its current placed items); positions rewrite densely
 * server-side in one transaction. Mismatched lists fail whole (400).
 */
export function reorderLibraryItems(
  folderId: string | null,
  items: LibraryMoveItem[],
): Promise<void> {
  return apiFetch<void>("/api/library-folders/items/order", {
    method: "PATCH",
    body: { folder_id: folderId, items },
  });
}

/**
 * `PATCH /api/library-folders/folders/order` — reorder one scope's
 * folder siblings (`parentId` null = tree root). Same full-list
 * contract as `reorderLibraryItems`.
 */
export function reorderLibraryFolders(
  parentId: string | null,
  folderIds: string[],
): Promise<void> {
  return apiFetch<void>("/api/library-folders/folders/order", {
    method: "PATCH",
    body: { parent_id: parentId, folder_ids: folderIds },
  });
}
