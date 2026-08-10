// E2e browse-page test: hero, shelves, poster grid, search, filters,
// favorites, ratings, thumbnails (M2 T12).
//
// Exercises the full M2 browse experience against the Docker stack built
// with the `e2e` cargo feature (mock providers + seed endpoint). Real OAuth
// providers can't be used in e2e, so the mock factory provides canned video
// listings with deterministic names, paths, and dedup groups.
//
// Test flow:
//   1. Authenticate + seed Google Drive + Dropbox connections → scan both
//   2. Verify browse page: hero showcase, shelves, poster grid
//   3. Search for a video by name → verify results filter
//   4. Apply a provider filter → verify grid updates
//   5. Favorite the hero video → verify favorites shelf + persistence
//   6. Rate the hero video → verify rating persistence
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
  test("hero, shelves, grid, search, filter, favorite, rating, thumbnail", async ({
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
    // Wait for the page to load: Recently Added shelf appears only after
    // the recentlyAdded query resolves.
    await expect(
      page.getByRole("heading", { name: "Recently Added" }),
    ).toBeVisible();

    // ── Hero showcase ──────────────────────────────────────────────
    // The hero section is the only <section> with a min-height class
    // (Tailwind `min-h-[280px]`). It contains the featured video's
    // name, metadata, provider badge, favorite toggle, and rating stars.
    const hero = page.locator('section[class*="min-h-"]');
    await expect(hero).toBeVisible();
    // Hero favorite toggle is always visible (variant="hero")
    const heroFavBtn = hero.getByRole("button", { name: /favorites/i });
    await expect(heroFavBtn).toBeVisible();
    await expect(heroFavBtn).toHaveAttribute("aria-pressed", "false");
    // Hero rating stars (5 radio buttons)
    const heroRating = hero.getByRole("group", { name: "Rate this video" });
    await expect(heroRating).toBeVisible();

    // ── Shelves ────────────────────────────────────────────────────
    await expect(
      page.getByRole("heading", { name: "Recently Added" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Google Drive", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Dropbox", exact: true }),
    ).toBeVisible();
    // Folder shelves: Movies (3 unique videos) + Photos (1)
    await expect(
      page.getByRole("heading", { name: "Movies", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Photos", exact: true }),
    ).toBeVisible();

    // ── Poster grid ────────────────────────────────────────────────
    await expect(
      page.getByRole("heading", { name: "All Videos" }),
    ).toBeVisible();
    await expect(page.getByText("4 videos")).toBeVisible();
    // All 4 video names are visible somewhere on the page (hero/shelf/grid)
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
    // Only concert.mp4 matches; hero + shelves are hidden during search
    await expect(page.getByText("concert.mp4").first()).toBeVisible();
    await expect(page.getByText("vacation.mp4")).toHaveCount(0);
    await expect(page.getByText("screenshots.mp4")).toHaveCount(0);
    await expect(page.getByText("shared-doc.mp4")).toHaveCount(0);
    // Hero + shelves are hidden during active search
    await expect(
      page.getByRole("heading", { name: "Recently Added" }),
    ).not.toBeVisible();

    // Clear search → browse layout restores
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(
      page.getByRole("heading", { name: "Recently Added" }),
    ).toBeVisible();
    await expect(page.getByText("4 videos")).toBeVisible();

    // ── Filter by provider ─────────────────────────────────────────
    // Provider preset chips are always visible inline (All / Google Drive /
    // Dropbox). No need to open the "More filters" drawer.
    await page
      .getByRole("group", { name: "Filter by provider" })
      .getByRole("button", { name: "Dropbox", exact: true })
      .click();
    // Grid updates: 2 Dropbox videos (screenshots.mp4 + shared-doc.mp4).
    // Scope negative assertions to the #all-videos grid — the hero showcase
    // and shelves above the grid still show All-videos content.
    const grid = page.locator("#all-videos");
    await expect(page.getByText("2 videos")).toBeVisible();
    await expect(grid.getByText("screenshots.mp4").first()).toBeVisible();
    await expect(grid.getByText("shared-doc.mp4").first()).toBeVisible();
    await expect(grid.getByText("vacation.mp4")).toHaveCount(0);
    await expect(grid.getByText("concert.mp4")).toHaveCount(0);

    // Clear filter
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page.getByText("4 videos")).toBeVisible();
    await expect(page.getByText("vacation.mp4").first()).toBeVisible();

    // ── Favorite (hero toggle) ─────────────────────────────────────
    // Click the hero's favorite button
    await heroFavBtn.click();
    // Optimistic update: aria-pressed flips to "true" immediately
    await expect(heroFavBtn).toHaveAttribute("aria-pressed", "true");
    // After cache invalidation + refetch, the Favorites shelf appears
    await expect(
      page.getByRole("heading", { name: "Favorites", exact: true }),
    ).toBeVisible();

    // Persist across reload
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Recently Added" }),
    ).toBeVisible();
    await expect(heroFavBtn).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("heading", { name: "Favorites", exact: true }),
    ).toBeVisible();

    // ── Rating (hero stars) ────────────────────────────────────────
    // Click the 4th star
    const fourthStar = heroRating.getByRole("radio", { name: "4 stars" });
    await fourthStar.click();
    // Optimistic update: aria-checked flips to "true" immediately
    await expect(fourthStar).toHaveAttribute("aria-checked", "true");

    // Persist across reload
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Recently Added" }),
    ).toBeVisible();
    await expect(fourthStar).toHaveAttribute("aria-checked", "true");

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
