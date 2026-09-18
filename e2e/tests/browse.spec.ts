// E2e browse-page test: library header, rails, organizer, poster grid,
// search, filters, favorites, ratings, thumbnails (M2 T12, updated for the
// M9 redesign — hero removed, folder organizer added).
//
// Exercises the browse experience against the Docker stack built with the
// `e2e` cargo feature (mock providers + seed endpoint). Real OAuth providers
// can't be used in e2e, so the mock factory provides canned video listings
// with deterministic names, paths, and dedup groups.
//
// Test flow:
//   1. Authenticate + seed Google Drive + Dropbox connections → scan both
//   2. Verify browse page: compact header, rails, organizer, poster grid
//   3. Search for a video by name → verify results filter
//   4. Apply a provider filter → verify grid updates
//   5. Favorite a video card → verify favorites rail + persistence
//   6. Rate a video card → verify rating persistence
//   7. Verify thumbnail proxy serves image content
//   8. Cleanup: disconnect both connections
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

test.describe("Browse page (e2e mock)", () => {
  test("header, rails, organizer, grid, search, filter, favorite, rating, thumbnail", async ({
    page,
  }) => {
    // ── Setup: authenticate + seed connections + scan ──────────────
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    const gdId = await seedAndScan(
      page,
      "google_drive",
      "gd-browse@example.com",
      csrf,
    );
    const dbId = await seedAndScan(
      page,
      "dropbox",
      "db-browse@example.com",
      csrf,
    );

    // After seeding + scanning both providers: 4 unique videos
    // (vacation.mp4, concert.mp4, shared-doc.mp4 [deduped], screenshots.mp4)
    const data = await getVideos(page);
    expect(data.total).toBe(4);

    // ── Navigate to browse page ────────────────────────────────────
    await page.goto("/");
    // Wait for the page to load: Recently added shelf appears only after
    // the recentlyAdded query resolves.
    await expect(
      page.getByRole("heading", { name: "Recently added" }),
    ).toBeVisible();

    // ── Compact library header (M9: the featured-video hero is gone) ──
    await expect(
      page.getByRole("heading", { level: 1, name: /Your library/ }),
    ).toBeVisible();

    // ── Organizer (M9): folder tree + provider chips ────────────────
    await expect(
      page.getByRole("tree", { name: "Folders" }),
    ).toBeVisible();
    await expect(
      page.getByRole("treeitem", { name: /Movies/ }),
    ).toBeVisible();
    // Provider chips replaced the old By Provider shelves. Both the
    // organizer and the grid's FilterPanel render a chip group — .first()
    // scopes to the organizer's.
    const organizerChips = page
      .getByRole("group", { name: "Filter by provider" })
      .first();
    await expect(
      organizerChips.getByRole("button", { name: "Google Drive", exact: true }),
    ).toBeVisible();
    await expect(
      organizerChips.getByRole("button", { name: "Dropbox", exact: true }),
    ).toBeVisible();

    // ── Poster grid ────────────────────────────────────────────────
    await expect(
      page.getByRole("heading", { name: "All videos" }),
    ).toBeVisible();
    // Scope to the grid — the M9 library header also contains "4 videos".
    await expect(
      page.locator("#all-videos").getByText("4 videos"),
    ).toBeVisible();
    // All 4 video names are visible somewhere on the page (rail/organizer/grid)
    for (const name of [
      "vacation.mp4",
      "concert.mp4",
      "shared-doc.mp4",
      "screenshots.mp4",
    ]) {
      await expect(page.getByText(name).first()).toBeVisible();
    }

    // ── Search ─────────────────────────────────────────────────────
    const searchInput = page.getByRole("textbox", { name: "Search videos" });
    await searchInput.fill("concert");
    // After 300ms debounce, the search-results layout appears
    await expect(page.getByText(/Search results for/)).toBeVisible();
    // Only concert.mp4 matches; rails + organizer are hidden during search
    await expect(page.getByText("concert.mp4").first()).toBeVisible();
    await expect(page.getByText("vacation.mp4")).toHaveCount(0);
    await expect(page.getByText("screenshots.mp4")).toHaveCount(0);
    await expect(page.getByText("shared-doc.mp4")).toHaveCount(0);
    // Rails + organizer are hidden during active search; the sidebar's
    // folder tree persists (it is app chrome, not page content).
    await expect(
      page.getByRole("heading", { name: "Recently added" }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("tree", { name: "Folders" }),
    ).toBeVisible();
    await expect(page.getByTestId("contents-full-path")).not.toBeVisible();

    // Clear search → browse layout restores
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(
      page.getByRole("heading", { name: "Recently added" }),
    ).toBeVisible();
    await expect(
      page.locator("#all-videos").getByText("4 videos"),
    ).toBeVisible();

    // ── Filter by provider ─────────────────────────────────────────
    // Provider preset chips are always visible inline (All / Google Drive /
    // Dropbox). No need to open the "More filters" drawer.
    await page
      .locator("#all-videos")
      .getByRole("group", { name: "Filter by provider" })
      .getByRole("button", { name: "Dropbox", exact: true })
      .click();
    // Grid updates: 2 Dropbox videos (screenshots.mp4 + shared-doc.mp4).
    // Scope negative assertions to the #all-videos grid — the rails and
    // organizer above the grid still show All-videos content.
    const grid = page.locator("#all-videos");
    await expect(
      page.locator("#all-videos").getByText("2 videos"),
    ).toBeVisible();
    await expect(grid.getByText("screenshots.mp4").first()).toBeVisible();
    await expect(grid.getByText("shared-doc.mp4").first()).toBeVisible();
    await expect(grid.getByText("vacation.mp4")).toHaveCount(0);
    await expect(grid.getByText("concert.mp4")).toHaveCount(0);

    // Clear filter
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(
      page.locator("#all-videos").getByText("4 videos"),
    ).toBeVisible();
    await expect(page.getByText("vacation.mp4").first()).toBeVisible();

    // ── Favorite + rating via a grid card (M9: hero variant is gone) ──
    // Hover the first grid card to reveal its favorite toggle + stars.
    const card = page
      .locator("#all-videos article")
      .filter({ hasText: "vacation.mp4" })
      .first();
    await card.hover();
    const favBtn = card.getByRole("button", { name: /favorites/i });
    await favBtn.click();
    // Optimistic update: aria-pressed flips to "true" immediately
    await expect(favBtn).toHaveAttribute("aria-pressed", "true");
    // After cache invalidation + refetch, the Favorites rail appears
    await expect(
      page.getByRole("heading", { name: "Favorites", exact: true }),
    ).toBeVisible();

    // Rating: hover again (hover state may have lapsed) and click star 4.
    await card.hover();
    const fourthStar = card.getByRole("radio", { name: "4 stars" });
    await fourthStar.click();
    await expect(fourthStar).toHaveAttribute("aria-checked", "true");

    // Persist both across reload
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Recently added" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Favorites", exact: true }),
    ).toBeVisible();
    const reloadedCard = page
      .locator("#all-videos article")
      .filter({ hasText: "vacation.mp4" })
      .first();
    await reloadedCard.hover();
    await expect(
      reloadedCard.getByRole("button", { name: /favorites/i }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      reloadedCard.getByRole("radio", { name: "4 stars" }),
    ).toHaveAttribute("aria-checked", "true");

    // ── Thumbnail proxy ────────────────────────────────────────────
    // Verify the thumbnail proxy serves image content for a video.
    // The e2e mock returns a test PNG for all file IDs.
    const videosData = await getVideos(page);
    const videoId = videosData.videos[0].id;
    const thumbRes = await page.request.get(
      `/api/videos/${encodeURIComponent(videoId)}/thumbnail`,
    );
    expect(thumbRes.status()).toBe(200);
    expect(thumbRes.headers()["content-type"]).toMatch(/^image\//);
    // Body should be non-empty image bytes
    const thumbBody = await thumbRes.body();
    expect(thumbBody.length).toBeGreaterThan(0);

    // ── Cleanup: disconnect both connections ──────────────────────
    await disconnect(page, gdId, csrf);
    await disconnect(page, dbId, csrf);
  });
});
