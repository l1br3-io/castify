// First-run setup probes and password enrollment.
//
// Two responsibilities:
//   * `fetchSetupStatus` — read-only owner-existence probe backed by the new
//     `GET /api/setup` route added in T11 slice 1 (deviation #19). The SPA's
//     cold-cache router uses it to decide between `/setup` and `/login`.
//   * `setupPassword` — password-path owner creation backed by `POST /api/setup`.

import { ApiError, apiFetch } from "./client";
import type { OwnerDto, OwnerEnvelope } from "./types";

export type SetupStatus = "open" | "closed";

/**
 * Probe whether first-run setup is still open.
 *
 * `GET /api/setup` returns `200 {"status":"open"}` when no owner exists and
 * `409` once one does. We translate that into a discriminated union so the
 * router doesn't have to reason about HTTP status codes directly.
 */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  try {
    await apiFetch<{ status: "open" }>("/api/setup");
    return "open";
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      return "closed";
    }
    throw error;
  }
}

export interface SetupPasswordInput {
  display_name?: string | null;
  password: string;
}

/**
 * Create the first owner via the password path. The server also issues a
 * session cookie on success. Caller is responsible for fetching a CSRF token
 * before any subsequent mutations.
 */
export async function setupPassword(input: SetupPasswordInput): Promise<OwnerDto> {
  const body = await apiFetch<OwnerEnvelope>("/api/setup", {
    method: "POST",
    body: {
      display_name: input.display_name ?? null,
      password: input.password,
    },
  });
  return body.owner;
}
