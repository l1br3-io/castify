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

import { test, expect } from "@playwright/test";
import {
  ensureAuthenticated,
  getCsrfToken,
  seedAndScan,
  disconnect,
  getVideos,
} from "./helpers";

test.describe("Catalog flow (e2e mock)", () => {
  test("seed → scan → unified list → dedup badge → disconnect", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);

    // ── 1. Seed Google Drive + scan ───────────────────────────────
    const gdId = await seedAndScan(
      page,
      "google_drive",
      "gd-mock@example.com",
      csrf,
    );

    // Verify 3 videos on the home page (vacation, concert, shared-doc)
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "All files" }),
    ).toBeVisible();
    await expect(
      page.locator("#all-files").getByText("3 files"),
    ).toBeVisible();
    await expect(page.getByText("vacation.mp4").first()).toBeVisible();
    await expect(page.getByText("concert.mp4").first()).toBeVisible();
    await expect(page.getByText("shared-doc.mp4").first()).toBeVisible();

    // ── 2. Seed Dropbox + scan (shared video → cross-provider dedup) ──
    const dbId = await seedAndScan(page, "dropbox", "db-mock@example.com", csrf);

    // 4 unique videos: 3 GD + 2 DB − 1 shared deduped
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "All files" }),
    ).toBeVisible();
    // Scope to the grid section — the stat row also carries the total.
    // also matches the substring.
    await expect(
      page.locator("#all-files").getByText("4 files"),
    ).toBeVisible();

    // Dedup badge on the shared video. Multiple shelves (Recently Added,
    // By Provider, All Videos) render the badge — match the first. The
    // sentence lives in the badge's sr-only text ("Also in Dropbox" —
    // the visible badge is provider marks).
    await expect(page.getByText(/^Also in /).first()).toBeVisible();

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
    await expect(
      page.locator("#all-files").getByText("2 files"),
    ).toBeVisible();
    // vacation.mp4 is gone everywhere (its only copy was on Google Drive).
    await expect(page.getByText("vacation.mp4")).toHaveCount(0);
    await expect(page.getByText("shared-doc.mp4").first()).toBeVisible();
    // No more dedup badge (only one copy of shared-doc remains)
    await expect(page.getByText(/^Also in /)).toHaveCount(0);

    // ── 4. Disconnect Dropbox → first-run guide reappears ─────────
    await disconnect(page, dbId, csrf);

    await page.goto("/");
    await expect(
      page.getByText("Connect your first cloud"),
    ).toBeVisible();
  });
});
