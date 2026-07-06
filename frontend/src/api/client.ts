// Central fetch wrapper for all `/api/*` calls.
//
// Responsibilities:
//   * Normalize errors into a single `ApiError` (status + message + body).
//   * Inject the cached CSRF token as `X-CSRF-Token` on every mutation
//     (`POST`/`PUT`/`PATCH`/`DELETE`). Harmless on allowlisted routes.
//   * Transparently refresh the CSRF token once and retry on a 403 response
//     from the CSRF middleware, so cookie/token drift doesn't surface to users.
//   * Default JSON content-type when a body is present.
//
// The session cookie (`castify_session`) is HttpOnly, so the client can't
// read it; TanStack Query's `['session']` cache is the JS-visible source of
// truth. 401s from `GET /api/session` are mapped to `null` (not an error) in
// `session.ts` — that's a per-route concern, not the wrapper's.

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

/**
 * Fetch a JSON endpoint and return the decoded body on success.
 * Throws `ApiError` for any non-2xx response other than 401 (see callers).
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  const method = (rest.method ?? "GET").toUpperCase();

  const requestHeaders = new Headers(headers);
  if (body !== undefined && !requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }
  if (MUTATION_METHODS.has(method) && csrfToken) {
    requestHeaders.set("x-csrf-token", csrfToken);
  }

  const serialized =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);

  let response = await fetch(path, {
    ...rest,
    method,
    headers: requestHeaders,
    body: serialized,
    credentials: "same-origin",
  });

  // CSRF middleware rejected the mutation — refresh the token once and retry.
  // Hitting this means the cached token drifted from the cookie (e.g. cookie
  // expired and a refresh from a parallel tab hasn't propagated). One retry
  // per request is enough; further failures bubble up as a normal ApiError.
  if (response.status === 403 && MUTATION_METHODS.has(method)) {
    const refreshed = await refreshCsrfToken();
    if (refreshed !== null) {
      requestHeaders.set("x-csrf-token", refreshed);
      response = await fetch(path, {
        ...rest,
        method,
        headers: requestHeaders,
        body: serialized,
        credentials: "same-origin",
      });
    }
  }

  return parseResponseBody<T>(response);
}

async function parseResponseBody<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      parsed !== null &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof (parsed as { message: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : `request to ${response.url} failed: ${response.status}`;
    throw new ApiError(response.status, message, parsed);
  }
  return parsed as T;
}

/**
 * Refresh the CSRF token via `GET /api/csrf` and cache the result in the
 * module variable. Returns the new token or `null` if the refresh failed.
 * Uses raw `fetch` to avoid recursion through `apiFetch`'s mutation logic.
 */
async function refreshCsrfToken(): Promise<string | null> {
  try {
    const response = await fetch("/api/csrf", { credentials: "same-origin" });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { token: string };
    csrfToken = body.token;
    return body.token;
  } catch {
    return null;
  }
}
