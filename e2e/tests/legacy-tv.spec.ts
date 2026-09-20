// E2e legacy TV player spec (docs/specs/legacy-tv-player task 007) — the
// legacy page, end to end against the docker stack.
//
// GOTCHA — why `?legacy=1` on every navigation: Playwright's Chromium
// always supports modules, so it can never fail the loader's probes.
// The force flag is the sanctioned test seam (spec FR-1.4), and the
// legacy script hides `#root` (display: none) so the also-loaded modern
// React app cannot produce false-positive selectors. Every locator is
// scoped under `#castify-legacy` — no assertion leaks into the modern
// DOM (task acceptance).
//
// Transcode-card e2e is intentionally absent: the mock catalog has no
// transcode-shaped video reachable without triggering lazy ffprobe
// races; jsdom covers that state in legacy-tv.test.ts (task 005).

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import {
  createShare,
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  getVideos,
  revokeShare,
  seedAndScan,
  type CreatedShare,
} from "./helpers";

const SHARE_PASSWORD = "legacy-pass-123";
const SHARE_TITLE = "Legacy TV videos";

const LEGACY = "#castify-legacy";

let gdConnId = "";
let vacationId = "";
let pwShare: CreatedShare | null = null;
let openShare: CreatedShare | null = null;

function shareA(): CreatedShare {
  if (!pwShare) throw new Error("e2e setup: password share not created");
  return pwShare;
}
function shareB(): CreatedShare {
  if (!openShare) throw new Error("e2e setup: open share not created");
  return openShare;
}

/** A recipient context — no session, no cookies, like a real TV browser. */
async function recipientPage(
  browser: import("@playwright/test").Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

test.describe("Legacy TV player (docs/specs/legacy-tv-player task 007)", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page);
      gdConnId = await seedAndScan(page, "google_drive", "gd-legacy@example.com", csrf);

      const data = await getVideos(page);
      const gd = data.videos.filter((v) => v.provider === "google_drive");
      const vacation = gd.find((v) => v.name === "vacation.mp4");
      if (!vacation) throw new Error('e2e setup: "vacation.mp4" not found');
      vacationId = vacation.id;

      pwShare = await createShare(
        page,
        { video_ids: [vacationId], title: SHARE_TITLE, password: SHARE_PASSWORD },
        csrf,
      );
      openShare = await createShare(page, { video_ids: [vacationId] }, csrf);
    } finally {
      await page.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!gdConnId) return;
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page);
      if (openShare) await revokeShare(page, openShare.id, csrf);
      if (pwShare) await revokeShare(page, pwShare.id, csrf);
      await disconnect(page, gdConnId, csrf);
    } finally {
      await page.close();
    }
  });

  test("open share: landing list → thumbnail click → video", async ({ browser }) => {
    const { context, page } = await recipientPage(browser);
    try {
      await page.goto(`${shareB().share_url}?legacy=1`);

      // The legacy list renders (one anchor, thumbnail + name inside).
      const row = page.locator(`${LEGACY} a.tv-item-link`);
      await expect(row).toHaveCount(1);
      await expect(row.locator("img.tv-item-thumb")).toBeVisible();
      await expect(row.locator(".tv-item-name")).toHaveText("vacation.mp4");

      // The modern app loaded too (force mode) but is hidden.
      await expect(page.locator("#root")).toBeHidden();

      // Click the thumbnail — same anchor as the name (click parity). The
      // link preserves ?legacy=1 so the watch page re-enters legacy mode.
      await row.locator("img.tv-item-thumb").click();
      await expect(page).toHaveURL(
        new RegExp(`/share/.+/watch/${encodeURIComponent(vacationId)}\\?legacy=1$`),
      );

      const video = page.locator(`${LEGACY} video`);
      await expect(video).toBeVisible();
      await expect
        .poll(async () => await video.getAttribute("src"))
        .toBeTruthy();
      await expect(video).toHaveAttribute("poster", /.+/);
      await expect(
        page.locator(`${LEGACY} .tv-title`, { hasText: "vacation.mp4" }),
      ).toBeVisible();
      await expect(page.locator("#root")).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test("password share: gate → wrong password → unlock → name click → video", async ({
    browser,
  }) => {
    const { context, page } = await recipientPage(browser);
    try {
      await page.goto(`${shareA().share_url}?legacy=1`);

      // The legacy unlock gate (not the modern React gate).
      const passwordInput = page.locator(`${LEGACY} #tv-password`);
      await expect(passwordInput).toBeVisible();
      await expect(
        page.locator(`${LEGACY} .tv-title`, { hasText: SHARE_TITLE }),
      ).toBeVisible();

      // Wrong password → inline rejection, still on the legacy gate.
      await passwordInput.fill("totally-wrong");
      await page.locator(`${LEGACY} #tv-unlock-submit`).click();
      await expect(page.locator(`${LEGACY} #tv-unlock-error`)).toHaveText(
        /Wrong password/,
      );
      await expect(passwordInput).toBeVisible();

      // Correct password → the list renders.
      await passwordInput.fill(SHARE_PASSWORD);
      await page.locator(`${LEGACY} #tv-unlock-submit`).click();
      const row = page.locator(`${LEGACY} a.tv-item-link`);
      await expect(row).toHaveCount(1);

      // Click the name — same anchor as the thumbnail (click parity).
      await row.locator(".tv-item-name").click();
      await expect(page).toHaveURL(
        new RegExp(`/share/.+/watch/${encodeURIComponent(vacationId)}\\?legacy=1$`),
      );

      const video = page.locator(`${LEGACY} video`);
      await expect(video).toBeVisible();
      await expect
        .poll(async () => await video.getAttribute("src"))
        .toBeTruthy();
      await expect(page.locator("#root")).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test("dead token: terminal copy inside the legacy container", async ({ browser }) => {
    const { context, page } = await recipientPage(browser);
    try {
      await page.goto("/share/legacy-e2e-bogus-token?legacy=1");
      await expect(page.locator(`${LEGACY} .tv-message-title`)).toHaveText(
        "This share doesn't exist.",
      );
      await expect(page.locator(`${LEGACY} input[type=password]`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("non-share path: share-links-only notice", async ({ browser }) => {
    const { context, page } = await recipientPage(browser);
    try {
      await page.goto("/settings?legacy=1");
      await expect(page.locator(`${LEGACY} .tv-message-title`)).toHaveText(
        "Castify on this TV supports share links only.",
      );
    } finally {
      await context.close();
    }
  });
});
