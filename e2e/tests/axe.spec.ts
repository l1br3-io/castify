// A11y gate (app-redesign task 004): one axe scan per redesigned screen.
//
// Green by construction (see scanAxe in helpers.ts): only screens that
// have already been redesigned get a case here. Every later screen task
// appends its own scan case — login/setup arrive with tasks 006/007, and
// so on. Zero serious/critical violations is a hard gate.
//
// Named axe.spec.ts (spec sketch said a11y.spec.ts): Playwright runs
// spec files alphabetically with one worker, and auth-flow.spec.ts must
// run FIRST — its cold-boot case expects no owner to exist. "axe" sorts
// after "auth-flow"; "a11y" sorted before it and broke that assumption.

import { test, expect } from "@playwright/test";

import {
  createShare,
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  getVideos,
  revokeShare,
  scanAxe,
  seedAndScan,
  seedConnection,
  triggerScan,
  waitForScanComplete,
} from "./helpers";
test.describe("A11y (axe) — redesigned screens", () => {
  test("home/library (/) — no serious or critical violations", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    await page.waitForLoadState("networkidle");
    await scanAxe(page, "home-library");
  });

  test("/shares (nav IA task 005) — no serious or critical violations", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    await page.goto("/shares");
    await page.waitForLoadState("networkidle");
    await scanAxe(page, "shares");
  });

  test("/login (task 006) — no serious or critical violations", async ({
    page,
  }) => {
    // Fresh context per test → no session cookie → the bare login form.
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await scanAxe(page, "login");
  });

  test("404 not-found (task 006) — no serious or critical violations", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    await page.goto("/this-page-does-not-exist");
    await page.waitForLoadState("networkidle");
    await scanAxe(page, "not-found");
  });

  test("/setup (task 007) — no serious or critical violations", async ({
    page,
  }) => {
    // The owner from earlier specs closes setup (409 → redirect), so stub
    // the probe open to scan the pre-auth wizard state.
    await page.route("**/api/setup", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "open" }),
      }),
    );
    await page.goto("/setup");
    await page.waitForLoadState("networkidle");
    await scanAxe(page, "setup");
  });

  test("/connections (design) — no serious or critical violations", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    await page.goto("/connections");
    // Wait for the provider grid, not just networkidle — the card fetches
    // resolve after the shell paints.
    await page
      .getByRole("heading", { name: "S3-Compatible Storage" })
      .waitFor();
    await scanAxe(page, "sources");
  });

  test("/watch/:id (task 012) — no serious or critical violations", async ({
    page,
  }) => {
    // Watch is standalone (no sidebar), so seed a video to view. Seeded
    // state is torn down (disconnect cascade) so later specs — whose
    // mocks assume their own state — aren't affected.
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    const connId = await seedAndScan(
      page,
      "google_drive",
      "axe-scan@example.com",
      csrf,
    );
    const { videos } = await getVideos(page);
    expect(videos.length).toBeGreaterThan(0);

    await page.goto(`/watch/${videos[0].id}`);
    await page
      .getByRole("heading", { name: videos[0].name })
      .waitFor({ timeout: 10_000 });
    await scanAxe(page, "watch");

    await disconnect(page, connId, csrf);
  });

  test("share dialog open state (task 016) — no serious or critical violations", async ({
    page,
  }) => {
    // Open the share-creation dialog from browse's multi-select mode and
    // scan the open-dialog state (focus trap + labelled panel).
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    const connId = await seedAndScan(
      page,
      "google_drive",
      "axe-share@example.com",
      csrf,
    );
    try {
      const { videos } = await getVideos(page);
      expect(videos.length).toBeGreaterThan(0);

      await page.goto("/");
      await page.getByRole("button", { name: "Select", exact: true }).click();
      await page
        .getByRole("checkbox", { name: `Select ${videos[0].name}` })
        .click();
      await page.getByRole("button", { name: /share 1 item/i }).click();

      await page
        .getByRole("dialog", { name: /share/i })
        .waitFor({ timeout: 10_000 });
      // Scope to the dialog panel: the page behind the backdrop is the
      // poster grid, whose badge/star treatments belong to the 019 sweep.
      await scanAxe(page, "share-dialog", [], { include: '[role="dialog"]' });

      // Dismiss via the dialog's own Cancel (the page behind also has one
      // — select mode is still active).
      await page
        .getByRole("dialog", { name: /share/i })
        .getByRole("button", { name: "Cancel" })
        .click();
    } finally {
      await disconnect(page, connId, csrf);
    }
  });

  test("/settings/shares/:id manage page (task 017) — no serious or critical violations", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    const connId = await seedConnection(
      page,
      "google_drive",
      "axe-manage@example.com",
      csrf,
    );
    await triggerScan(page, connId, csrf);
    await waitForScanComplete(page, connId);
    const { videos } = await getVideos(page);
    expect(videos.length).toBeGreaterThan(0);
    const share = await createShare(
      page,
      { video_ids: [videos[0].id], title: "Axe manage scan" },
      csrf,
    );
    try {
      await page.goto(`/settings/shares/${share.id}`);
      await page
        .getByRole("heading", { name: /axe manage scan/i })
        .waitFor({ timeout: 10_000 });
      await scanAxe(page, "share-manage");
    } finally {
      await revokeShare(page, share.id, csrf);
      await disconnect(page, connId, csrf);
    }
  });

  test("/share/:token list + watch (task 018) — no serious or critical violations", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    const connId = await seedAndScan(
      page,
      "google_drive",
      "axe-pub@example.com",
      csrf,
    );
    const { videos } = await getVideos(page);
    expect(videos.length).toBeGreaterThan(0);
    const share = await createShare(
      page,
      { video_ids: [videos[0].id], title: "Axe public share" },
      csrf,
    );
    try {
      // Recipient list — public, no session needed.
      await page.goto(share.share_url);
      await page
        .getByRole("heading", { name: "Axe public share" })
        .waitFor({ timeout: 10_000 });
      await scanAxe(page, "share-list");

      // Recipient player — dark editorial, shared player controls.
      await page.goto(`${share.share_url}/watch/${videos[0].id}`);
      await page
        .getByRole("heading", { name: videos[0].name })
        .waitFor({ timeout: 10_000 });
      await scanAxe(page, "share-watch");
    } finally {
      await revokeShare(page, share.id, csrf);
      await disconnect(page, connId, csrf);
    }
  });
});
