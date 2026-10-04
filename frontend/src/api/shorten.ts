// Shortener client — the single network seam for short-link minting
// (short-links, task 001). Swapping providers means editing this
// file only.
//
// Provider: spoo.me — free, keyless, open source, CORS `*`, verified live
// 2026-09-20 (spec Resolved questions #1). is.gd/CleanURI were rejected
// (no CORS → would force a server proxy, breaking the client-only posture);
// TinyURL/Dub (accounts + API keys — wrong fit for FOSS self-hosted).
//
// Contract: POST form-encoded `url=<absolute share url>` with
// `Accept: application/json`, one attempt, 10s AbortController timeout.
// The only datum that leaves the browser is the URL in the request body —
// no titles, tokens, or headers beyond standard fetch. Every failure mode
// throws `ShortenerError`; the caller owns the fallback UX (copy the
// canonical link). The returned alias upgrades `http:` → `https:` to skip
// the provider's own upgrade redirect.
//
// Note: plain `fetch`, NOT `apiFetch` — this is a third-party origin, not
// a `/api/*` call. No CSRF, no credentials, no session cookies flow here.

const SHORTENER_ENDPOINT = "https://spoo.me/";
const TIMEOUT_MS = 10_000;

/** Distinguishes failure modes for the caller's fallback note. */
export type ShortenerFailure = "network" | "http" | "timeout" | "shape";

export class ShortenerError extends Error {
  readonly kind: ShortenerFailure;
  /** HTTP status, present only for `kind: "http"` (e.g. 429 rate limit). */
  readonly status?: number;

  constructor(kind: ShortenerFailure, message: string, status?: number) {
    super(message);
    this.name = "ShortenerError";
    this.kind = kind;
    this.status = status;
  }
}

/** The one field we rely on; anything else in the body is ignored. */
interface SpooMeResponse {
  short_url?: unknown;
}

/**
 * Mint a short alias for `absoluteUrl` via spoo.me. One attempt, 10s
 * timeout, no retry. Throws `ShortenerError` on any failure — the caller
 * must treat every throw as "shortener unavailable" and fall back to the
 * canonical link.
 */
export async function shortenShareUrl(absoluteUrl: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(SHORTENER_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ url: absoluteUrl }).toString(),
      signal: controller.signal,
    });
  } catch (error) {
    throw controller.signal.aborted
      ? new ShortenerError(
          "timeout",
          `shortener did not answer within ${TIMEOUT_MS}ms`,
        )
      : new ShortenerError(
          "network",
          `shortener request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ShortenerError(
      "http",
      `shortener answered HTTP ${response.status}`,
      response.status,
    );
  }

  let parsed: SpooMeResponse;
  try {
    parsed = (await response.json()) as SpooMeResponse;
  } catch {
    throw new ShortenerError("shape", "shortener returned a non-JSON body");
  }

  if (typeof parsed.short_url !== "string" || parsed.short_url.length === 0) {
    throw new ShortenerError("shape", `shortener response missing "short_url" string`);
  }

  return parsed.short_url.replace(/^http:/, "https:");
}
