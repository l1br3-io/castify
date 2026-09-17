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
// reconnect the source on the Sources page.

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { fetchStreamUrl } from "../api/videos";
import type { AccessScope } from "../api/videos";
import type { StreamUrlDto } from "../api/types";

export const REAUTH_REQUIRED_CODE = "reauth_required" as const;

/** Owner default shared by the hook and the query-key builder. */
const OWNER_SCOPE: AccessScope = { kind: "owner" };

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

export function streamUrlQueryKey(id: string, scope: AccessScope = OWNER_SCOPE) {
  // Share entries live under a token-namespaced root so the same video id
  // resolved through a share never collides with (or invalidates) the
  // owner's cached strategy.
  if (scope.kind === "share") {
    return ["share", scope.token, "videos", id, "stream-url"] as const;
  }
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

/**
 * Error-message substrings that unmistakably indicate a dead/revoked
 * provider grant, regardless of which HTTP status or structured code the
 * backend attached. Covers:
 *
 *   - `"token may be expired or revoked"` — the Display of the backend's
 *     `ProviderError::Unauthorized`, surfaced when the post-refresh-retry
 *     promotion to `reauth_required` didn't fire (older binary, an
 *     uncovered leak path, or `factory.create` returning Unauthorized
 *     before the refresh handler runs).
 *   - `"invalid_grant"` — the OAuth2 token-endpoint error code that
 *     originally classified the failure as reauth-required server-side.
 *   - `"unauthorized"` — belt-and-braces catch for any auth-layer 401
 *     that escapes the structured promotion.
 *
 * Used by `isReauthLikelyError` below so the watch page can route to the
 * Reconnect card on signature alone, without trusting the backend to emit
 * the structured `code`.
 */
const REAUTH_LIKELY_PATTERNS = [
  "token may be expired or revoked",
  "invalid_grant",
  "unauthorized",
] as const;

/**
 * Heuristic detector combining the structured `reauth_required` code with
 * the leak-path message signature. Use this in UI routing decisions where
 * the goal is "does the user need to reconnect?" — it returns true for
 * both the structured response AND the legacy/leak 502 with the raw
 * `ProviderError::Unauthorized` text. Reserve `isReauthRequiredError` for
 * code paths that must distinguish the structured case (e.g. analytics).
 */
export function isReauthLikelyError(err: unknown): err is ApiError {
  if (!(err instanceof ApiError)) return false;
  if (err.code === REAUTH_REQUIRED_CODE) return true;
  const msg = err.message.toLowerCase();
  return REAUTH_LIKELY_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Resolve the stream strategy for a video. Pass `{ kind: "share", token }`
 * to resolve through the share mirror — the response then carries
 * share-rooted Castify URLs (stream/proxy/cached/transcode master) so the
 * recipient's player never touches an owner route. The share watch page
 * (sharing task 010) is the intended scoped caller; the owner watch page
 * keeps the no-argument default.
 */
export function useStreamUrl(id: string | undefined, scope: AccessScope = OWNER_SCOPE) {
  const query = useQuery<StreamUrlDto, ApiError>({
    queryKey: id
      ? streamUrlQueryKey(id, scope)
      : [...streamUrlQueryKey("", scope)],
    queryFn: () => fetchStreamUrl(id!, scope),
    enabled: !!id,
    // Dynamic staleTime — derived from the response's `expires_at`. See
    // `computeStaleTime` above for the rationale and edge cases.
    staleTime: (query) => computeStaleTime(query.state.data),
    // A dead refresh token is terminal for this connection — don't let
    // TanStack silently retry the request 3 times (the user needs to act
    // before any future call will succeed). Uses the heuristic detector
    // so the leak-path 502 ("unauthorized: token may be expired or
    // revoked") also short-circuits retries, not just the structured
    // `code: "reauth_required"` response. Without this, the user waits
    // through 3 retries × exponential backoff before seeing the recovery
    // card. The default retry policy still covers transient network blips
    // for failures that don't signature-match reauth.
    retry: (failureCount, err) => {
      // In share scope a 404 is equally terminal: the mirrors answer 404
      // for membership loss (`authorize_share_item`, by design
      // indistinguishable from an unknown id), so retrying would only
      // delay the dedicated removed-from-share card by the full backoff
      // schedule. Owner scope keeps the default retry policy unchanged.
      if (scope.kind === "share" && err.status === 404) return false;
      if (isReauthLikelyError(err)) return false;
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
 * and swaps the `<video src>` to the fresh CDN URL. Pass the same scope the
 * query was created with; share entries are keyed by token.
 */
export function useInvalidateStreamUrl() {
  const queryClient = useQueryClient();
  return (id: string, scope: AccessScope = OWNER_SCOPE) =>
    queryClient.invalidateQueries({ queryKey: streamUrlQueryKey(id, scope) });
}

// Re-export so callers can branch on the structured error without reaching
// into the raw client module.
export type { ApiError };
