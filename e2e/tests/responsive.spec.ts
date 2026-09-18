// Responsive shell (design: castify-design.html frame interior).
//
// The design defines two breakpoints inside the frame:
//   * >860px  — static 220px sidebar, no hamburger, full topbar.
//   * ≤860px  — sidebar becomes an overlay drawer; hamburger opens it.
//   * ≤600px  — compact topbar: search field, scan status, and the
//     account name drop out.
//
// Verified with real viewports against the seeded docker stack.

import { test, expect } from "@playwright/test";

import { ensureAuthenticated, getCsrfToken, seedAndScan } from "./helpers";

test.describe("Responsive shell", () => {
  test("desktop (>860px): static sidebar, full topbar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await ensureAuthenticated(page);
    await page.goto("/");

    // Static sidebar with nav; hamburger hidden.
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Connections" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open navigation menu" }),
    ).toBeHidden();
    // Topbar search present.
    await expect(
      page.getByRole("textbox", { name: "Search videos" }),
    ).toBeVisible();
  });

  test("mid-width (600–860px): hamburger drawer, search stays", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await ensureAuthenticated(page);
    await page.goto("/");

    // Drawer is closed (off-canvas) but the hamburger is present.
    const menuButton = page.getByRole("button", {
      name: "Open navigation menu",
    });
    await expect(menuButton).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();

    // Open the drawer → nav visible; close via backdrop.
    await menuButton.click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page
      .getByRole("button", { name: "Close navigation menu" })
      .click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();

    // Search stays in the topbar above 600px.
    await expect(
      page.getByRole("textbox", { name: "Search videos" }),
    ).toBeVisible();
  });

  test("mobile (≤600px): drawer carries nav + folders, compact topbar", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    await seedAndScan(page, "google_drive", "gd-mobile@example.com", csrf);
    await page.goto("/");

    // Compact topbar: search hidden, hamburger visible.
    await expect(
      page.getByRole("textbox", { name: "Search videos" }),
    ).toBeHidden();
    const menuButton = page.getByRole("button", {
      name: "Open navigation menu",
    });
    await expect(menuButton).toBeVisible();

    // Open the drawer: nav AND the library's folder tree live inside it.
    await menuButton.click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible();

    // Selecting a nav item navigates and closes the drawer.
    await page.getByRole("link", { name: "Connections" }).click();
    await expect(page).toHaveURL(/\/connections/);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  });
});
