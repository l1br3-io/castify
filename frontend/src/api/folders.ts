// Folder organizer API (M9): the folder tree + per-folder contents.
//
// Both mirror the Rust DTOs in `crates/api/src/routes/folders.rs` /
// `crates/catalog/src/model.rs`. Reads only — no new server writes.

import { apiFetch } from "./client";
import type { FolderContentsPageDto, FolderNodeDto } from "./types";

/**
 * `GET /api/folders/tree` — nested folder tree with cumulative counts
 * (M9 FR-4).
 */
export function fetchFolderTree(): Promise<FolderNodeDto[]> {
  return apiFetch<FolderNodeDto[]>("/api/folders/tree");
}

export interface FolderContentsParams {
  path?: string;
  page?: number;
  limit?: number;
  provider?: string;
  kind?: string;
  q?: string;
}

/**
 * `GET /api/folders/contents` — mixed, paginated, direct-children listing
 * (M9 FR-5). Default sort: name ascending (server-side).
 */
export function fetchFolderContents(
  params: FolderContentsParams = {},
): Promise<FolderContentsPageDto> {
  const search = new URLSearchParams();
  if (params.path !== undefined && params.path !== "")
    search.set("path", params.path);
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.provider !== undefined && params.provider !== "")
    search.set("provider", params.provider);
  if (params.kind !== undefined && params.kind !== "")
    search.set("kind", params.kind);
  if (params.q !== undefined && params.q !== "") search.set("q", params.q);

  const query = search.toString();
  return apiFetch<FolderContentsPageDto>(
    `/api/folders/contents${query ? `?${query}` : ""}`,
  );
}

/**
 * Same-origin download URL for a non-media file (M9 FR-6). Not wrapped in
 * `apiFetch` — the browser attaches the session cookie and the body is a
 * byte stream with `Content-Disposition: attachment`.
 */
export function fileDownloadUrl(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/download`;
}
