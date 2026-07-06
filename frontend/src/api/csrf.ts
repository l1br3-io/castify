// CSRF token lifecycle.
//
// `GET /api/csrf` is the single authenticated source of a double-submit CSRF
// token. The server sets `castify_csrf` (readable by JS) and returns the token
// in the body. We cache it via `setCsrfToken` so `apiFetch` can inject it on
// subsequent mutations without every caller having to thread it through.
//
// Callers must invoke `fetchCsrfToken()` once after every successful
// login/setup finish — the cached token is scoped to a session and a fresh
// login establishes a new session.

import { apiFetch } from "./client";
import { setCsrfToken } from "./client";

interface CsrfResponse {
  token: string;
}

/**
 * Fetch a fresh CSRF token from `GET /api/csrf` and cache it for use by
 * `apiFetch` on subsequent mutations. Returns the token.
 */
export async function fetchCsrfToken(): Promise<string> {
  const body = await apiFetch<CsrfResponse>("/api/csrf");
  setCsrfToken(body.token);
  return body.token;
}
