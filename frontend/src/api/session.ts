// Session lifecycle: fetch current session, password login, logout.
//
// The session cookie is HttpOnly and never touches JS. TanStack Query's
// `['session']` cache (see `hooks/use-session.ts`) is the JS-visible source
// of truth. `fetchSession` maps a 401 to `null` (not an error) so the query
// resolves cleanly when the user is logged out, matching the architecture
// decision in the T11 plan.

import { ApiError, apiFetch } from "./client";
import type { OwnerDto, OwnerEnvelope } from "./types";

/**
 * Resolve the current owner from `GET /api/session`.
 * Returns `null` when there is no session (401) — the query treats "logged
 * out" as a valid state, not an error.
 */
export async function fetchSession(): Promise<OwnerDto | null> {
  try {
    const body = await apiFetch<OwnerEnvelope>("/api/session");
    return body.owner;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export interface LoginPasswordInput {
  password: string;
  display_name?: string | null;
}

/**
 * Log in via password. On success returns the owner and the session cookie
 * is set by the server. Caller is responsible for fetching a CSRF token
 * (`fetchCsrfToken`) before issuing any mutations.
 */
export async function loginPassword(input: LoginPasswordInput): Promise<OwnerDto> {
  const body = await apiFetch<OwnerEnvelope>("/api/session", {
    method: "POST",
    body: {
      display_name: input.display_name ?? null,
      password: input.password,
    },
  });
  return body.owner;
}

/**
 * Log out via `DELETE /api/session`. The CSRF header is injected by
 * `apiFetch` from the cached token. Always resolves on success; throws
 * `ApiError` otherwise.
 */
export async function logout(): Promise<void> {
  await apiFetch<void>("/api/session", { method: "DELETE" });
}
