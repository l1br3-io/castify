// Shared e2e helpers: authentication, mock connection seeding, scan lifecycle,
// play lifecycle (progress, stream-url, IndexedDB).
//
// Used by every spec (catalog, browse, streaming, play). The helpers assume
// the e2e compose override is active (binary built with `--features e2e`,
// which enables the seed endpoint + mock factory + mock CDN route).
//
// CSRF note: the SPA's React Query refetches can rotate the `castify_csrf`
// cookie mid-test (see M3 deviation #70). Every mutation helper here sends
// the CSRF token in BOTH the `X-CSRF-Token` header AND an explicit `Cookie`
// header that overrides the cookie jar — eliminating the race regardless of
// what the SPA does between capture and mutation.

import { expect, type Page } from "@playwright/test";

export const DISPLAY_NAME = "E2E Owner";
export const PASSWORD = "e2e-test-password-123";

// ── Auth ────────────────────────────────────────────────────────────

/** Fetch a CSRF token via GET /api/csrf. The session cookie must already be set. */
export async function getCsrfToken(page: Page): Promise<string> {
  const res = await page.request.get("/api/csrf");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.token as string;
}

/**
 * Build explicit `Cookie` + `X-CSRF-Token` headers for a mutation request.
 *
 * Reads the current cookie jar (to preserve `castify_session` and any other
 * auth cookies), then OVERRIDES `castify_csrf` with the captured token and
 * sends the same value in the `X-CSRF-Token` header. The double-submit
 * middleware sees a matched pair regardless of any cookie-jar rotation the
 * SPA performs between token capture and mutation.
 */
async function authHeaders(
  page: Page,
  csrfToken: string,
): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const cookieParts = cookies
    .filter((c) => c.name !== "castify_csrf")
    .map((c) => `${c.name}=${c.value}`);
  cookieParts.push(`castify_csrf=${csrfToken}`);
  return {
    Cookie: cookieParts.join("; "),
    "X-CSRF-Token": csrfToken,
  };
}

/**
 * Authenticate the page context. If no owner exists (cold boot), runs through
 * the setup wizard. If an owner already exists (e.g. auth-flow.spec.ts ran
 * first), logs in with the shared password.
 */
export async function ensureAuthenticated(page: Page): Promise<void> {
  const setupRes = await page.request.get("/api/setup");
  if (setupRes.status() === 200) {
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel("Display name").fill(DISPLAY_NAME);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/$/);
  } else {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);
  }
}

// ── Connection lifecycle ────────────────────────────────────────────

/** Seed a mock provider connection via POST /api/__e2e/seed-connection. */
export async function seedConnection(
  page: Page,
  provider: string,
  email: string,
  csrf: string,
): Promise<string> {
  const res = await page.request.post("/api/__e2e/seed-connection", {
    headers: await authHeaders(page, csrf),
    data: { provider, account_email: email },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.id as string;
}

/** Trigger a background scan for a connection. Returns immediately (202). */
export async function triggerScan(
  page: Page,
  connectionId: string,
  csrf: string,
): Promise<void> {
  const res = await page.request.post(
    `/api/connections/${connectionId}/scan`,
    { headers: await authHeaders(page, csrf) },
  );
  expect(res.status()).toBe(202);
}

/** Poll GET /api/connections/{id}/scan until status is "idle" (scan complete). */
export async function waitForScanComplete(
  page: Page,
  connectionId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/connections/${connectionId}/scan`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    if (body.status === "idle") return;
    if (body.status === "error") {
      throw new Error(`scan failed: ${body.error_message ?? "unknown"}`);
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`scan did not complete within ${timeoutMs}ms`);
}

/** Disconnect a connection (DELETE /api/connections/{id}). */
export async function disconnect(
  page: Page,
  connectionId: string,
  csrf: string,
): Promise<void> {
  const res = await page.request.delete(`/api/connections/${connectionId}`, {
    headers: await authHeaders(page, csrf),
  });
  expect(res.status()).toBe(204);
}

// ── Convenience: seed + scan ────────────────────────────────────────

/** Seed a connection and wait for its scan to complete. Returns the connection id. */
export async function seedAndScan(
  page: Page,
  provider: string,
  email: string,
  csrf: string,
): Promise<string> {
  const id = await seedConnection(page, provider, email, csrf);
  await triggerScan(page, id, csrf);
  await waitForScanComplete(page, id);
  return id;
}

// ── Video API helpers ───────────────────────────────────────────────

export interface VideoSource {
  provider: string;
}

export interface VideoSummary {
  id: string;
  name: string;
  provider: string;
  sources: VideoSource[];
  is_favorite: boolean;
  my_rating: number | null;
  thumbnail_status: string;
}

export interface VideoPage {
  total: number;
  videos: VideoSummary[];
}

/** Fetch the unified video list via GET /api/videos. */
export async function getVideos(page: Page): Promise<VideoPage> {
  const res = await page.request.get("/api/videos");
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// ── Play lifecycle (M3) ─────────────────────────────────────────────
//
// Two persistence paths exist:
//   - Server-side `playback_progress` table + `POST/GET /api/videos/{id}/progress`
//     (the M3 PRD's documented path; the backend contract works but the
//     frontend stopped using it after T10).
//   - Client-side IndexedDB (`castify-player` DB, `playbackProgress` store)
//     — the actual path the frontend uses for resume + continue-watching.
// Both are exercisable from e2e; the play.spec.ts suite covers each.

export interface SubtitleTrack {
  id: string;
  language: string | null;
  filename: string;
  format: string;
}

export interface VideoDetail {
  id: string;
  name: string;
  provider: string;
  size_bytes: number;
  mime_type: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  sources: VideoSource[];
  created_at: string;
  path: string | null;
  is_favorite: boolean;
  my_rating: number | null;
  thumbnail_status: string;
  position_seconds: number | null;
  duration_seconds: number | null;
  completed: boolean;
  subtitle_tracks: SubtitleTrack[];
}

/** `GET /api/videos/{id}` — full metadata + progress + subtitle tracks. */
export async function getVideoDetail(
  page: Page,
  id: string,
): Promise<VideoDetail> {
  const res = await page.request.get(
    `/api/videos/${encodeURIComponent(id)}`,
  );
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export interface StreamUrlResponse {
  url: string;
  strategy: "direct" | "proxy" | "cached" | "transcode";
  expires_at: string | null;
}

/** `GET /api/videos/{id}/stream-url` — per-provider strategy + URL. */
export async function getStreamUrl(
  page: Page,
  id: string,
): Promise<StreamUrlResponse> {
  const res = await page.request.get(
    `/api/videos/${encodeURIComponent(id)}/stream-url`,
  );
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export interface ProgressResponse {
  position_seconds: number;
  duration_seconds: number | null;
  completed: boolean;
  updated_at: string;
}

/**
 * `POST /api/videos/{id}/progress` — server-side progress upsert.
 * Uses the explicit CSRF header path (see `authHeaders`).
 */
export async function postProgress(
  page: Page,
  id: string,
  body: {
    position_seconds: number;
    duration_seconds?: number;
    completed?: boolean;
  },
  csrf: string,
): Promise<ProgressResponse> {
  const res = await page.request.post(
    `/api/videos/${encodeURIComponent(id)}/progress`,
    {
      headers: await authHeaders(page, csrf),
      data: body,
    },
  );
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/**
 * `GET /api/videos/{id}/progress` — read server-side progress.
 * Returns `null` on 404 (no progress row yet — the common case).
 */
export async function getProgress(
  page: Page,
  id: string,
): Promise<ProgressResponse | null> {
  const res = await page.request.get(
    `/api/videos/${encodeURIComponent(id)}/progress`,
  );
  if (res.status() === 404) return null;
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// ── IndexedDB (client-side progress) ───────────────────────────────
//
// The frontend's `lib/player-db.ts` writes to a `castify-player` IndexedDB
// with a `playbackProgress` object store (keyPath: `videoId`). These helpers
// run inside the page context via `page.evaluate` — they're the only way to
// read/write entries from the test. The DB schema matches player-db.ts:1-13.
//
// We use the string-form of `page.evaluate` because the helpers can't share
// a closure across the Node ↔ browser boundary. The `openDB()` body is
// inlined into each operation expression.

const IDB_OPEN = `
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("castify-player", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("playbackProgress")) {
        db.createObjectStore("playbackProgress", { keyPath: "videoId" });
      }
      if (!db.objectStoreNames.contains("playerPrefs")) {
        db.createObjectStore("playerPrefs", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
`;

export interface ProgressEntry {
  videoId: string;
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
  updatedAt: number;
  videoName: string;
  videoDurationMs: number | null;
  thumbnailStatus: string;
  height: number | null;
  provider: string;
}

/**
 * Write a `ProgressEntry` directly to IndexedDB inside the page context.
 * Used by the resume test to seed a saved position before navigating to
 * `/watch/:id` — exercising the resume-on-load path.
 */
export async function seedProgressEntry(
  page: Page,
  entry: ProgressEntry,
): Promise<void> {
  await page.evaluate(`
    (async () => {
      ${IDB_OPEN}
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("playbackProgress", "readwrite")
          .objectStore("playbackProgress").put(${JSON.stringify(entry)});
        tx.onsuccess = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    })()
  `);
}

/**
 * Read a `ProgressEntry` from IndexedDB. Returns `null` if no entry exists
 * for the given videoId (or if the DB/store doesn't exist yet — fresh page).
 */
export async function readProgressEntry(
  page: Page,
  videoId: string,
): Promise<ProgressEntry | null> {
  return page.evaluate(`
    (async () => {
      ${IDB_OPEN}
      try {
        const db = await openDB();
        const result = await new Promise((resolve, reject) => {
          const req = db.transaction("playbackProgress", "readonly")
            .objectStore("playbackProgress").get(${JSON.stringify(videoId)});
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => reject(req.error);
        });
        db.close();
        return result;
      } catch {
        return null;
      }
    })()
  `);
}

/**
 * Clear all entries from IndexedDB. Call between sub-tests to ensure a
 * clean slate — subtitle prefs + progress entries from a prior sub-test
 * could otherwise bleed into the next one's assertions.
 */
export async function clearPlayerDB(page: Page): Promise<void> {
  await page.evaluate(`
    new Promise((resolve) => {
      const req = indexedDB.deleteDatabase("castify-player");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    })
  `);
}

// ── Sharing (docs/specs/sharing) ────────────────────────────────────
//
// Owner-side helpers run on an authenticated owner page (session + CSRF,
// like the connection helpers above). Recipient-side helpers run on a
// page from a CLEAN context — no session — mirroring how a real recipient
// hits the pre-auth `/api/share/*` routes. The unlock POST is the only
// recipient mutation; its Set-Cookie lands in the context jar, so later
// `page.request` GETs on `/api/share/*` carry it automatically (cookie
// Path is /api/share/).

export interface CreatedShare {
  id: string;
  title: string;
  token: string;
  share_url: string;
}

/** `POST /api/shares` — create a share (owner). Password is optional. */
export async function createShare(
  page: Page,
  body: {
    video_ids: string[];
    title?: string;
    password?: string;
    expires_at?: string;
  },
  csrf: string,
): Promise<CreatedShare> {
  const res = await page.request.post("/api/shares", {
    headers: await authHeaders(page, csrf),
    data: body,
  });
  expect(res.status()).toBe(201);
  return res.json();
}

/** `DELETE /api/shares/{id}` — revoke a share (owner). Idempotent 204. */
export async function revokeShare(
  page: Page,
  shareId: string,
  csrf: string,
): Promise<void> {
  const res = await page.request.delete(`/api/shares/${encodeURIComponent(shareId)}`, {
    headers: await authHeaders(page, csrf),
  });
  expect(res.status()).toBe(204);
}

export interface ShareResolveResponse {
  title: string;
  item_count: number;
  locked: boolean;
  status: string;
}

/** `GET /api/share/{token}` — recipient resolve (works while locked). */
export async function resolveShare(
  page: Page,
  token: string,
): Promise<ShareResolveResponse> {
  const res = await page.request.get(
    `/api/share/${encodeURIComponent(token)}`,
  );
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/**
 * `POST /api/share/{token}/unlock` — recipient password gate (API path;
 * the UI path is exercised by navigating the landing page). Sets the
 * signed unlock cookie in the calling context's jar.
 */
export async function unlockShare(
  page: Page,
  token: string,
  password: string,
): Promise<void> {
  const res = await page.request.post(
    `/api/share/${encodeURIComponent(token)}/unlock`,
    { data: { password } },
  );
  expect(res.status()).toBe(204);
}

/** `GET /api/share/{token}/items` — member summaries in curation order. */
export async function getShareItems(
  page: Page,
  token: string,
): Promise<VideoSummary[]> {
  const res = await page.request.get(
    `/api/share/${encodeURIComponent(token)}/items`,
  );
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/**
 * `GET /api/share/{token}/videos/{id}/stream-url` — strategy resolution
 * through the share mirror. Castify-served URLs come back rooted at
 * `/api/share/{token}/...`; browser-direct CDN URLs pass through.
 */
export async function getShareStreamUrl(
  page: Page,
  token: string,
  videoId: string,
): Promise<StreamUrlResponse> {
  const res = await page.request.get(
    `/api/share/${encodeURIComponent(token)}/videos/${encodeURIComponent(videoId)}/stream-url`,
  );
  expect(res.ok()).toBeTruthy();
  return res.json();
}
