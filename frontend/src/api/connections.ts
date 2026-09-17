// Connection lifecycle: list, availability probe, OAuth start, disconnect.
//
// The OAuth connect flow is a two-step dance:
//   1. `POST /api/connections/{provider}/start` returns `{ auth_url }`.
//   2. The browser navigates to `auth_url` (full page redirect to the
//      provider's consent screen). On approval the provider redirects back to
//      `GET /api/connections/{provider}/callback`, which the backend handles
//      and then 302s to `/connections?connected={provider}` (or
//      `?error=oauth_failed`). The `/connections` route reads those query
//      params to show a success/error banner.
//
// `startConnect` and `disconnectConnection` are mutations — `apiFetch`
// auto-injects the cached CSRF token on both, so callers don't handle CSRF
// directly (the token is bootstrapped after login by `fetchCsrfToken`).

import { apiFetch } from "./client";
import type {
  AvailableProviders,
  ConnectionDto,
  ProviderKey,
  ScanStatusDto,
  StartResponse,
} from "./types";

/** `GET /api/connections` — active connections with scan status + video count. */
export function fetchConnections(): Promise<ConnectionDto[]> {
  return apiFetch<ConnectionDto[]>("/api/connections");
}

/** `GET /api/connections/available` — which providers have OAuth credentials. */
export function fetchAvailableProviders(): Promise<AvailableProviders> {
  return apiFetch<AvailableProviders>("/api/connections/available");
}

/**
 * `POST /api/connections/{provider}/start` — begin the OAuth flow. Returns the
 * provider's authorization URL; the caller navigates the browser there.
 *
 * `returnTo` is an optional server-relative path the browser should land on
 * after the OAuth round-trip — used by the watch page's "Try again" button
 * so users come back to the video they were trying to play rather than the
 * Sources page. The backend validates it as a relative path and ignores
 * anything that looks like an open-redirect attempt.
 */
export function startConnect(
  provider: ProviderKey,
  returnTo?: string,
): Promise<StartResponse> {
  const path = `/api/connections/${encodeURIComponent(provider)}/start`;
  const url =
    returnTo !== undefined
      ? `${path}?return_to=${encodeURIComponent(returnTo)}`
      : path;
  return apiFetch<StartResponse>(url, { method: "POST" });
}

/**
 * `POST /api/connections/{provider}` — submit the schema-rendered
 * credentials form (credentials-flow providers). The body maps schema
 * field keys to their input values. Resolves with the created connection
 * on 201; a failed verify throws `ApiError` carrying the backend's
 * actionable message (no connection row is persisted in that case).
 */
export function connectWithCredentials(
  provider: ProviderKey,
  values: Record<string, string>,
): Promise<ConnectionDto> {
  return apiFetch<ConnectionDto>(
    `/api/connections/${encodeURIComponent(provider)}`,
    { method: "POST", body: values },
  );
}

/**
 * `DELETE /api/connections/{id}` — revoke + delete a connection. Resolves on
 * 204; throws `ApiError` (404) if the connection no longer exists.
 */
export function disconnectConnection(connectionId: string): Promise<void> {
  return apiFetch<void>(`/api/connections/${encodeURIComponent(connectionId)}`, {
    method: "DELETE",
  });
}

/**
 * `POST /api/connections/{id}/scan` — trigger a manual rescan. Resolves on
 * 202 Accepted; throws `ApiError` (409) if a scan is already in progress,
 * (404) if the connection doesn't exist.
 */
export function triggerRescan(connectionId: string): Promise<void> {
  return apiFetch<void>(`/api/connections/${encodeURIComponent(connectionId)}/scan`, {
    method: "POST",
  });
}

/**
 * `GET /api/connections/{id}/scan` — current scan status for a connection.
 */
export function fetchScanStatus(connectionId: string): Promise<ScanStatusDto> {
  return apiFetch<ScanStatusDto>(`/api/connections/${encodeURIComponent(connectionId)}/scan`);
}
