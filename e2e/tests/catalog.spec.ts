// E2e catalog flow test: seed mock connections → scan → unified list → dedup → disconnect.
//
// Exercises the full M1 catalog pipeline (connect → scan → store → dedup →
// unified list → disconnect cascade) against the Docker stack. Real OAuth
// providers can't be used in e2e, so the binary is built with the `e2e` cargo
// feature which swaps in a mock ProviderFactory and adds a seed endpoint.
//
// Test flow:
//   1. Authenticate (setup if cold boot, login if owner exists)
//   2. Seed a Google Drive connection → scan → verify 3 videos in the list
//   3. Seed a Dropbox connection → scan → verify dedup badge on shared video
//   4. Disconnect Google Drive → verify cascade removes its videos
//   5. Disconnect Dropbox → verify first-run guide reappears
//
// Requires the e2e compose override (builds with --features e2e).

import { test, expect, type Page } from "@playwright/test";

const DISPLAY_NAME = "E2E Owner";
const PASSWORD = "e2e-test-password-123";

// ── Helpers ─────────────────────────────────────────────────────────

async function getCsrfToken(page: Page): Promise<string> {
  const res = await page.request.get("/api/csrf");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.token as string;
}

async function ensureAuthenticated(page: Page): Promise<void> {
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

async function seedConnection(
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

async function triggerScan(page: Page, connectionId: string, csrf: string): Promise<void> {
  const res = await page.request.post(`/api/connections/${connectionId}/scan`, {
    headers: { "X-CSRF-Token": csrf },
  });
  expect(res.status()).toBe(202);
}

async function waitForScanComplete(
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

async function getVideos(page: Page): Promise<{ total: number; videos: Array<{ name: string; provider: string; sources: Array<{ provider: string }> }> }> {
  const res = await page.request.get("/api/videos");
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function disconnect(page: Page, connectionId: string, csrf: string): Promise<void> {
  const res = await page.request.delete(`/api/connections/${connectionId}`, {
    headers: { "X-CSRF-Token": csrf },
  });
  expect(res.status()).toBe(204);
}

// ── Test ────────────────────────────────────────────────────────────

test.describe("Catalog flow (e2e mock)", () => {
  test("seed → scan → unified list → dedup badge → disconnect", async ({ page }) => {
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);

    // ── 1. Seed Google Drive + scan ───────────────────────────────
    const gdId = await seedConnection(page, "google_drive", "gd-mock@example.com", csrf);
    await triggerScan(page, gdId, csrf);
    await waitForScanComplete(page, gdId);

    // Verify 3 videos on the home page (vacation, concert, shared-doc)
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible();
    await expect(page.getByText("3 videos")).toBeVisible();
    await expect(page.getByText("vacation.mp4")).toBeVisible();
    await expect(page.getByText("concert.mp4")).toBeVisible();
    await expect(page.getByText("shared-doc.mp4")).toBeVisible();

    // ── 2. Seed Dropbox + scan (shared video → cross-provider dedup) ──
    const dbId = await seedConnection(page, "dropbox", "db-mock@example.com", csrf);
    await triggerScan(page, dbId, csrf);
    await waitForScanComplete(page, dbId);

    // 4 unique videos: 3 GD + 2 DB − 1 shared deduped
    await page.reload();
    await expect(page.getByText("4 videos")).toBeVisible();

    // Dedup badge on the shared video
    await expect(page.getByText(/Also in:/)).toBeVisible();

    // Verify via API: shared-doc has 2 sources
    const data = await getVideos(page);
    expect(data.total).toBe(4);
    const shared = data.videos.find((v) => v.name === "shared-doc.mp4");
    expect(shared).toBeTruthy();
    expect(shared!.sources.length).toBe(2);

    // ── 3. Disconnect Google Drive → cascade removes its videos ────
    await disconnect(page, gdId, csrf);

    // 2 videos remain: screenshots.mp4 + shared-doc.mp4 (from Dropbox)
    await page.reload();
    await expect(page.getByText("2 videos")).toBeVisible();
    await expect(page.getByText("vacation.mp4")).not.toBeVisible();
    await expect(page.getByText("shared-doc.mp4")).toBeVisible();
    // No more dedup badge (only one copy of shared-doc remains)
    await expect(page.getByText(/Also in:/)).not.toBeVisible();

    // ── 4. Disconnect Dropbox → first-run guide reappears ─────────
    await disconnect(page, dbId, csrf);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Connect your first cloud" }),
    ).toBeVisible();
  });
});
