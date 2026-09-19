// Shares API client (docs/specs/sharing, tasks 002–004).
//
// Two halves of one feature:
//
//   * Owner client — session-gated `/api/shares` (create/list/revoke/purge)
//     and `/api/shares/{id}/items` (replace/fetch members for the edit
//     dialog, docs/specs/mutable-share-list) for the Settings management
//     page (task 011) and creation dialogs (task 012). Mutations ride the
//     normal CSRF flow in `apiFetch`.
//   * Recipient client — pre-auth `/api/share/{token}/...` (resolve/items/
//     unlock) for the public landing page (task 009). The HttpOnly unlock
//     cookie is scoped to `Path=/api/share/`, so same-origin fetch attaches
//     it automatically — nothing here touches cookies explicitly.
//
// Error mapping (via `ApiError`): 401 = locked (password gate still owed),
// 410 = terminal (revoked/expired), 404 = unknown token. The landing page
// branches on these statuses; see `share.tsx`.

import { apiFetch } from "./client";
import type { ShareFolderDto, ShareItemsDto } from "./types";

// ---------------------------------------------------------------------------
// Owner client — `POST/GET /api/shares`, `DELETE /api/shares/{id}`,
// `PUT/GET /api/shares/{id}/items`
// ---------------------------------------------------------------------------

/** Body of `POST /api/shares`. All validation (non-empty unique ids, title
 * length, password policy, RFC3339 future expiry) happens server-side. */
export interface CreateShareRequestDto {
  /** 1..N catalog video ids in curation order. */
  video_ids: string[];
  title?: string;
  /** Optional share password (8..=256 chars). */
  password?: string;
  /** Optional RFC3339 expiry, strictly in the future. */
  expires_at?: string;
}

/**
 * Response of `POST /api/shares`. `token` and `share_url` appear here and
 * here only — the server stores only a hash, so a lost link is unrecoverable
 * by design. `share_url` is relative (`/share/{token}`); resolve against the
 * current origin.
 */
export interface CreatedShareDto {
  id: string;
  title: string;
  token: string;
  share_url: string;
}

/** Point-in-time state derived server-side (revocation beats expiry). */
export type ShareStatusKey = "active" | "expired" | "revoked";

/** Management list entry from `GET /api/shares` — no token or password
 * material ever crosses the wire here. */
export interface ShareDto {
  id: string;
  title: string;
  item_count: number;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  status: ShareStatusKey;
}

/**
 * `POST /api/shares` — create a share. 201 with the one-time raw token.
 */
export function createShare(body: CreateShareRequestDto): Promise<CreatedShareDto> {
  return apiFetch<CreatedShareDto>("/api/shares", {
    method: "POST",
    body: body satisfies CreateShareRequestDto,
  });
}

/**
 * `GET /api/shares` — the owner's management list, newest first.
 */
export function fetchShares(): Promise<ShareDto[]> {
  return apiFetch<ShareDto[]>("/api/shares");
}

/**
 * `DELETE /api/shares/{id}` — revoke (soft delete). Idempotent: revoking a
 * revoked or unknown share still answers 204.
 */
export function revokeShare(shareId: string): Promise<void> {
  return apiFetch<void>(`/api/shares/${encodeURIComponent(shareId)}`, {
    method: "DELETE",
  });
}

/**
 * `DELETE /api/shares/{id}?purge=true` — purge (hard delete,
 * share-management task 004). Where `revokeShare` keeps the record (the
 * row survives with a revoked status), this removes it entirely: the
 * refetched list no longer includes the share and the recipient link
 * 404s instead of revoke's 410. Idempotent for unknown ids.
 */
export function deleteShare(shareId: string): Promise<void> {
  return apiFetch<void>(
    `/api/shares/${encodeURIComponent(shareId)}?purge=true`,
    { method: "DELETE" },
  );
}

/**
 * `PUT /api/shares/{id}/items` — replace the share's full item list. The
 * body is the complete new curation order (not a delta), so the edit dialog
 * submits exactly what its picker shows. 204 with no body; 409 for
 * revoked/expired shares, 404 for foreign or unknown ids (no existence
 * leak), 400 for empty/duplicate/non-catalog ids.
 */
export function replaceShareItems(shareId: string, videoIds: string[]): Promise<void> {
  return apiFetch<void>(`/api/shares/${encodeURIComponent(shareId)}/items`, {
    method: "PUT",
    body: { video_ids: videoIds },
  });
}

/**
 * `POST /api/shares/{id}/items` — append videos to a live share
 * (share-management task 002). The caller sends only the not-yet-member
 * ids in curation order; unlike the PUT, duplicates (in-request or
 * already-member) are tolerated as idempotent no-ops — still 204. Only
 * the empty request is a 400. Error contract otherwise mirrors the PUT:
 * 404 unknown/foreign ids, 409 revoked/expired shares.
 */
export function appendToShare(shareId: string, videoIds: string[]): Promise<void> {
  return apiFetch<void>(`/api/shares/${encodeURIComponent(shareId)}/items`, {
    method: "POST",
    body: { video_ids: videoIds },
  });
}

// ---------------------------------------------------------------------------
// Owner folder client — `/api/shares/{id}/folders` (share-folders effort).
// Folders are organization only; every mutation is active-share-only
// server-side (409 on revoked/expired, 404 on foreign/unknown).
// ---------------------------------------------------------------------------

/** Body of `POST /api/shares/{id}/folders`. `parent_id` omitted/null
 * creates at the share root. */
export interface CreateShareFolderRequestDto {
  name: string;
  parent_id?: string | null;
}

/** Body of `PATCH /api/shares/{id}/folders/{fid}`. Absent keys leave the
 * stored value alone; `parent_id: null` (explicit) moves the folder to
 * the share root — the double-option distinction the server relies on. */
export interface UpdateShareFolderRequestDto {
  name?: string;
  parent_id?: string | null;
}

/**
 * `POST /api/shares/{id}/folders` — create a folder (201 with the row).
 * 400 for empty/oversized names, 409 for a duplicate sibling name, 404
 * for an unknown/foreign parent.
 */
export function createShareFolder(
  shareId: string,
  body: CreateShareFolderRequestDto,
): Promise<ShareFolderDto> {
  return apiFetch<ShareFolderDto>(`/api/shares/${encodeURIComponent(shareId)}/folders`, {
    method: "POST",
    body,
  });
}

/**
 * `PATCH /api/shares/{id}/folders/{fid}` — rename and/or reparent in one
 * write. Reparenting appends the folder at the end of its new sibling
 * group; the server rejects cycles and depth-cap breaches with 409/400.
 */
export function updateShareFolder(
  shareId: string,
  folderId: string,
  body: UpdateShareFolderRequestDto,
): Promise<ShareFolderDto> {
  return apiFetch<ShareFolderDto>(
    `/api/shares/${encodeURIComponent(shareId)}/folders/${encodeURIComponent(folderId)}`,
    { method: "PATCH", body },
  );
}

/**
 * `DELETE /api/shares/{id}/folders/{fid}` — delete the folder; its
 * contents lift to the share root (membership never changes). 204.
 */
export function deleteShareFolder(shareId: string, folderId: string): Promise<void> {
  return apiFetch<void>(
    `/api/shares/${encodeURIComponent(shareId)}/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
}

/**
 * `GET /api/shares/{id}/items` — the one-shot tree payload for the
 * manage page's browse and the edit dialog's pre-checks: the flat
 * folder list plus member videos, each carrying its `folder_id`.
 * Session-gated owner route: the recipient endpoint is token-scoped and
 * the raw token may not exist on this device (the server stores only a
 * hash), so the owner reads members by share id instead. Unlike the PUT
 * it also serves revoked/expired shares — read-only history for a
 * dialog that may outlive the share's life.
 */
export function fetchShareItemsOwned(shareId: string): Promise<ShareItemsDto> {
  return apiFetch<ShareItemsDto>(`/api/shares/${encodeURIComponent(shareId)}/items`);
}

// ---------------------------------------------------------------------------
// Recipient client — `/api/share/{token}` (pre-auth)
// ---------------------------------------------------------------------------

/**
 * Response of `GET /api/share/{token}` — the pre-unlock probe. `locked`
 * drives the landing page: true means the password gate is still owed.
 * Always `"active"` on a 200; revoked/expired never reach this body (they
 * are terminal 410s).
 */
export interface ShareResolveDto {
  title: string;
  item_count: number;
  locked: boolean;
  status: "active";
}

/**
 * `GET /api/share/{token}` — resolve a share link. The one recipient
 * endpoint that answers while locked (the gate needs the title). Throws
 * `ApiError` 404/410 for unknown/dead tokens.
 */
export function resolveShare(token: string): Promise<ShareResolveDto> {
  return apiFetch<ShareResolveDto>(`/api/share/${encodeURIComponent(token)}`);
}

/**
 * `GET /api/share/{token}/items` — the one-shot tree payload: the flat
 * folder list plus member videos in the same `VideoSummary` shape the
 * owner catalog uses (with neutral personalization — the owner's
 * favorites/ratings/progress never leak), each carrying its
 * `folder_id`. Folder navigation is client state, so this single fetch
 * covers every descent. 401 while locked; unlock first.
 */
export function fetchShareItems(token: string): Promise<ShareItemsDto> {
  return apiFetch<ShareItemsDto>(`/api/share/${encodeURIComponent(token)}/items`);
}

/**
 * `POST /api/share/{token}/unlock` — pass the password gate. On success the
 * server sets the signed unlock cookie (24h rolling, capped at share
 * expiry); 204, no body. 401 on a wrong password, 429 while rate-limited.
 */
export function unlockShare(token: string, password: string): Promise<void> {
  return apiFetch<void>(`/api/share/${encodeURIComponent(token)}/unlock`, {
    method: "POST",
    body: { password },
  });
}
