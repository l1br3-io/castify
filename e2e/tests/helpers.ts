// Shared e2e helpers: authentication, mock connection seeding, scan lifecycle.
//
// Used by both catalog.spec.ts (M1 catalog flow) and browse.spec.ts (M2 browse
// features). The helpers assume the e2e compose override is active (binary
// built with `--features e2e`, which enables the seed endpoint + mock factory).

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
    headers: { "X-CSRF-Token": csrf },
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
    { headers: { "X-CSRF-Token": csrf } },
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
    headers: { "X-CSRF-Token": csrf },
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
