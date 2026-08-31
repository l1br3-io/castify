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
import type { VideoSummaryDto } from "./types";

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

/**
 * `GET /api/shares/{id}/items` — the current members for the edit dialog to
 * pre-check. Session-gated owner route: the recipient endpoint is
 * token-scoped and the raw token may not exist on this device (the server
 * stores only a hash), so the owner reads members by share id instead.
 * Unlike the PUT it also serves revoked/expired shares — read-only history
 * for a dialog that may outlive the share's life.
 */
export function fetchShareItemsOwned(shareId: string): Promise<VideoSummaryDto[]> {
  return apiFetch<VideoSummaryDto[]>(
    `/api/shares/${encodeURIComponent(shareId)}/items`,
  );
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
 * `GET /api/share/{token}/items` — member videos in the owner's curation
 * order, in the same `VideoSummary` shape the owner catalog uses (with
 * neutral personalization — the owner's favorites/ratings/progress never
 * leak). 401 while locked; unlock first.
 */
export function fetchShareItems(token: string): Promise<VideoSummaryDto[]> {
  return apiFetch<VideoSummaryDto[]>(
    `/api/share/${encodeURIComponent(token)}/items`,
  );
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
