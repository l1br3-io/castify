// `useStreamUrl` — resolve where the browser should fetch video bytes from.
//
// Wraps `GET /api/videos/{id}/stream-url` (T12 — direct CDN streaming). For
// OneDrive + Dropbox the backend returns a short-lived preauthenticated CDN
// URL the browser hits directly; for Google Drive it returns the existing
// `/stream` endpoint. The player consumes `data.url` as `<video src>`.
//
// When the CDN URL expires mid-playback (the `<video>` element emits an
// `error` event on the next Range request, typically ~1 hour after the
// initial fetch for OneDrive or ~4 hours for Dropbox), callers invalidate
// the query via `invalidateStreamUrl` — TanStack Query re-fetches and the
// `<video src>` swaps to a fresh URL. Range requests against the new URL
// resume playback from the current position automatically.
//
// If the provider's **refresh token** has expired or been revoked, the
// backend returns `401 { code: "reauth_required" }` and the hook exposes
// `reauthRequired: true` so the caller can render a reconnect prompt
// instead of looping on retry. Recovery requires the user to disconnect +
// reconnect the connection on the Connections page.

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { fetchStreamUrl } from "../api/videos";
import type { StreamUrlDto } from "../api/types";

export const REAUTH_REQUIRED_CODE = "reauth_required" as const;

/**
 * Stale-time tuning for `/stream-url` responses. The previous static 60s
 * `staleTime` forced a re-fetch on every focus/visibility change, even
 * though the backend hands out CDN URLs that live for ~1hr (OneDrive),
 * ~4hr (Dropbox), or ~50min (Google Drive). For long sessions this is
 * wasteful — a 2-hour movie could fire ~120 unnecessary `/stream-url`
 * calls even though the cached URL is still valid.
 *
 * When the response carries an `expires_at`, the query stays fresh until
 * 5 minutes before that timestamp (safety margin to refresh before the CDN
 * starts returning 403). Without `expires_at` (proxy strategy, or unknown
 * expiry), falls back to the conservative 60s default.
 *
 * The cap at 45 minutes bounds how long we'll trust a single URL — even
 * Dropbox's 4hr URL gets refreshed at least once per long viewing session,
 * which keeps invalidate-on-error fallbacks from going stale.
 */
const DEFAULT_STALE_MS = 60 * 1000;
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const MAX_STALE_MS = 45 * 60 * 1000;

function computeStaleTime(data: StreamUrlDto | undefined): number {
  if (data?.strategy === "direct" && data.expires_at) {
    const expiryMs = Date.parse(data.expires_at);
    if (!Number.isNaN(expiryMs)) {
      const ms = expiryMs - Date.now() - EXPIRY_SAFETY_MARGIN_MS;
      return Math.max(DEFAULT_STALE_MS, Math.min(ms, MAX_STALE_MS));
    }
  }
  return DEFAULT_STALE_MS;
}

export function streamUrlQueryKey(id: string) {
  return ["videos", id, "stream-url"] as const;
}

/**
 * Type-guard for the structured `reauth_required` error the backend emits
 * when a provider's refresh token is dead (OAuth2 `invalid_grant`). Exposed
 * so other hooks can reuse the same detection without coupling to the
 * backend's wire format.
 */
export function isReauthRequiredError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === REAUTH_REQUIRED_CODE;
}

export function useStreamUrl(id: string | undefined) {
  const query = useQuery<StreamUrlDto, ApiError>({
    queryKey: id ? streamUrlQueryKey(id) : ["videos", undefined, "stream-url"],
    queryFn: () => fetchStreamUrl(id!),
    enabled: !!id,
    // Dynamic staleTime — derived from the response's `expires_at`. See
    // `computeStaleTime` above for the rationale and edge cases.
    staleTime: (query) => computeStaleTime(query.state.data),
    // A dead refresh token is terminal for this connection — don't let
    // TanStack silently retry the request 3 times (the user needs to act
    // before any future call will succeed). The default retry policy still
    // covers transient network blips for other failures.
    retry: (failureCount, err) => {
      if (isReauthRequiredError(err)) return false;
      return failureCount < 3;
    },
  });
  return query;
}

/**
 * Invalidate the cached stream URL for a video, forcing the next read to
 * re-fetch from the backend. Called when the `<video>` element emits an
 * `error` event during direct-CDN playback — typically because the URL has
 * expired mid-session. The player then re-reads `useStreamUrl(id).data.url`
 * and swaps the `<video src>` to the fresh CDN URL.
 */
export function useInvalidateStreamUrl() {
  const queryClient = useQueryClient();
  return (id: string) =>
    queryClient.invalidateQueries({ queryKey: streamUrlQueryKey(id) });
}

// Re-export so callers can branch on the structured error without reaching
// into the raw client module.
export type { ApiError };
