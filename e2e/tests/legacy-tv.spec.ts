// E2e legacy TV player spec (legacy-tv-player task 007) — the
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
  createShareFolder,
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  getVideos,
  moveShareItem,
  revokeShare,
  seedAndScan,
  type CreatedShare,
} from "./helpers";

const SHARE_PASSWORD = "legacy-pass-123";
const SHARE_TITLE = "Legacy TV videos";
const FOLDERED_TITLE = "Legacy TV folders";

const LEGACY = "#castify-legacy";

let gdConnId = "";
let vacationId = "";
let concertId = "";
let sharedDocId = "";
let pwShare: CreatedShare | null = null;
let openShare: CreatedShare | null = null;
let folderedShare: CreatedShare | null = null;
let seasonFolderId = "";

function shareA(): CreatedShare {
  if (!pwShare) throw new Error("e2e setup: password share not created");
  return pwShare;
}
function shareB(): CreatedShare {
  if (!openShare) throw new Error("e2e setup: open share not created");
  return openShare;
}
function shareF(): CreatedShare {
  if (!folderedShare) throw new Error("e2e setup: foldered share not created");
  return folderedShare;
}

/** A recipient context — no session, no cookies, like a real TV browser. */
async function recipientPage(
  browser: import("@playwright/test").Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

test.describe("Legacy TV player (legacy-tv-player task 007)", () => {
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
      const concert = gd.find((v) => v.name === "concert.mp4");
      if (!concert) throw new Error('e2e setup: "concert.mp4" not found');
      concertId = concert.id;
      const sharedDoc = gd.find((v) => v.name === "shared-doc.mp4");
      if (!sharedDoc) throw new Error('e2e setup: "shared-doc.mp4" not found');
      sharedDocId = sharedDoc.id;

      pwShare = await createShare(
        page,
        { video_ids: [vacationId], title: SHARE_TITLE, password: SHARE_PASSWORD },
        csrf,
      );
      openShare = await createShare(page, { video_ids: [vacationId] }, csrf);

      // Foldered fixture (nav-search task 005): root video + one folder
      // with a video + a subfolder with a video. GOTCHA: creation order
      // defines `position` — tests assert against names, not positions.
      folderedShare = await createShare(
        page,
        { video_ids: [vacationId, concertId, sharedDocId], title: FOLDERED_TITLE },
        csrf,
      );
      const season = await createShareFolder(
        page,
        folderedShare.id,
        { name: "Season 1" },
        csrf,
      );
      seasonFolderId = season.id;
      const day = await createShareFolder(
        page,
        folderedShare.id,
        { name: "Day 1", parent_id: season.id },
        csrf,
      );
      await moveShareItem(page, folderedShare.id, concertId, season.id, csrf);
      await moveShareItem(page, folderedShare.id, sharedDocId, day.id, csrf);
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
      if (folderedShare) await revokeShare(page, folderedShare.id, csrf);
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

  // ── Folder navigation + whole-share search (nav-search task 005) ────

  test.describe("Legacy TV navigation + search (legacy-tv-nav-search task 005)", () => {
    test("folder rows + counts; folder entry is pushState; crumbs walk back to root", async ({
      browser,
    }) => {
      const { context, page } = await recipientPage(browser);
      try {
        await page.goto(`${shareF().share_url}?legacy=1`);

        // Root: the folder row precedes the root video; direct counts on
        // the row (1 video + 1 subfolder); no trail at the root level.
        const seasonRow = page.locator(`${LEGACY} a.tv-folder-link`, {
          hasText: "Season 1",
        });
        await expect(seasonRow).toBeVisible();
        await expect(seasonRow.locator(".tv-folder-counts")).toHaveText(
          "1 videos · 1 folders",
        );
        await expect(page.locator(`${LEGACY} .tv-crumbs`)).toHaveCount(0);
        await expect(
          page.locator(`${LEGACY} a.tv-item-link .tv-item-name`),
        ).toHaveText("vacation.mp4");

        // Probe proves folder entry never reloads the document — the
        // payload is already in memory, so navigation is a pushState.
        await page.evaluate(() => {
          (window as { __navProbe?: boolean }).__navProbe = true;
        });
        // The row's own data-folder value drives the URL assertion — no
        // hardcoded server-assigned ids.
        const seasonId = (await seasonRow.getAttribute("data-folder")) ?? "";
        await seasonRow.click();

        await expect(page).toHaveURL(
          new RegExp(`folder=${seasonId}$`),
        );
        expect(
          await page.evaluate(
            () => (window as { __navProbe?: boolean }).__navProbe,
          ),
        ).toBe(true);
        await expect(
          page.locator(`${LEGACY} a.tv-folder-link .tv-folder-name`),
        ).toHaveText("Day 1");
        await expect(
          page.locator(`${LEGACY} a.tv-item-link .tv-item-name`),
        ).toHaveText("concert.mp4");

        // Crumbs: root is a link, current level is plain text.
        const rootCrumb = page.locator(`${LEGACY} a.tv-crumb`, {
          hasText: FOLDERED_TITLE,
        });
        await expect(rootCrumb).toBeVisible();
        await expect(
          page.locator(`${LEGACY} .tv-crumb-current`),
        ).toHaveText("Season 1");

        await rootCrumb.click();
        await expect(page).toHaveURL(new RegExp(`\\?legacy=1$`));
        await expect(seasonRow).toBeVisible();
        expect(
          await page.evaluate(
            () => (window as { __navProbe?: boolean }).__navProbe,
          ),
        ).toBe(true);
      } finally {
        await context.close();
      }
    });

    test("browser back (the remote's Return) walks out of the folder", async ({
      browser,
    }) => {
      const { context, page } = await recipientPage(browser);
      try {
        await page.goto(`${shareF().share_url}?legacy=1`);
        await page
          .locator(`${LEGACY} a.tv-folder-link`, { hasText: "Season 1" })
          .click();
        await expect(page).toHaveURL(new RegExp(`folder=${seasonFolderId}$`));
        await expect(
          page.locator(`${LEGACY} a.tv-item-link .tv-item-name`),
        ).toHaveText("concert.mp4");

        await page.goBack();

        await expect(page).toHaveURL(new RegExp(`\\?legacy=1$`));
        // popstate re-rendered the root level — same document, no reload.
        await expect(
          page.locator(`${LEGACY} a.tv-folder-link .tv-folder-name`),
        ).toHaveText("Season 1");
      } finally {
        await context.close();
      }
    });

    test("search narrows across folders with path labels; clearing restores the folder view", async ({
      browser,
    }) => {
      const { context, page } = await recipientPage(browser);
      try {
        await page.goto(`${shareF().share_url}?legacy=1`);
        await page
          .locator(`${LEGACY} a.tv-folder-link`, { hasText: "Season 1" })
          .click();
        await expect(
          page.locator(`${LEGACY} a.tv-item-link .tv-item-name`),
        ).toHaveText("concert.mp4");

        // The hit lives in Day 1 — a whole-share result while browsing
        // Season 1, labeled with its folder path (root omitted).
        await page.locator(`${LEGACY} #tv-search`).fill("shared-doc");
        await expect(page.locator(`${LEGACY} .tv-results-count`)).toHaveText(
          "1 result",
        );
        await expect(
          page.locator(`${LEGACY} a.tv-item-link .tv-item-name`),
        ).toHaveText("shared-doc.mp4");
        await expect(page.locator(`${LEGACY} .tv-item-path`)).toHaveText(
          "Season 1 › Day 1",
        );
        await expect(page.locator(`${LEGACY} .tv-crumbs`)).toHaveCount(0);

        // Clearing returns to the folder view — the folder param never
        // left the URL while searching.
        await page.locator(`${LEGACY} #tv-search`).fill("");
        await expect(
          page.locator(`${LEGACY} a.tv-folder-link .tv-folder-name`),
        ).toHaveText("Day 1");
        await expect(
          page.locator(`${LEGACY} a.tv-item-link .tv-item-name`),
        ).toHaveText("concert.mp4");
        await expect(page).toHaveURL(
          new RegExp(`folder=${seasonFolderId}$`),
        );
      } finally {
        await context.close();
      }
    });

    test("watch from a searched folder state → back link returns to that state", async ({
      browser,
    }) => {
      const { context, page } = await recipientPage(browser);
      try {
        await page.goto(`${shareF().share_url}?legacy=1`);
        await page
          .locator(`${LEGACY} a.tv-folder-link`, { hasText: "Season 1" })
          .click();
        // GOTCHA: search for shared-doc.mp4, not the folder's concert.mp4 —
        // the concert fixture carries MPEG-2 bytes (e2e.rs), so the legacy
        // watch page renders a terminal unsupported-format card and there is
        // no player or back link to assert against.
        await page.locator(`${LEGACY} #tv-search`).fill("shared-doc");
        await expect(page.locator(`${LEGACY} .tv-results-count`)).toHaveText(
          "1 result",
        );

        await page.locator(`${LEGACY} a.tv-item-link`).click();

        // The watch URL carries the full view state (legacy ∪ folder ∪ q).
        await expect(page).toHaveURL(
          new RegExp(
            `/watch/${sharedDocId}\\?legacy=1&folder=${seasonFolderId}&q=shared-doc$`,
          ),
        );
        const video = page.locator(`${LEGACY} video`);
        await expect(video).toBeVisible();
        await expect
          .poll(async () => await video.getAttribute("src"))
          .toBeTruthy();

        // The back link is a real navigation — this is the cold-load path
        // restoring search mode over the folder context (FR-4).
        await page.locator(`${LEGACY} a.tv-back`).click();
        await expect(page).toHaveURL(
          new RegExp(
            `\\?legacy=1&folder=${seasonFolderId}&q=shared-doc$`,
          ),
        );
        await expect(page.locator(`${LEGACY} .tv-results-count`)).toHaveText(
          "1 result",
        );
        await expect(
          page.locator(`${LEGACY} a.tv-item-link .tv-item-name`),
        ).toHaveText("shared-doc.mp4");
      } finally {
        await context.close();
      }
    });
  });
});
