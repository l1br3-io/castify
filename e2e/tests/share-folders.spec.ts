// E2e share-folders spec (docs/specs/share-folders task 009) — the
// effort's user journey, end to end against the docker stack:
//
//   owner builds a 2-level folder tree on the manage page (New folder ×2,
//   Move to folder… ×3 through the shared picker) → clean recipient
//   context opens the link → folder tiles → descent + breadcrumbs →
//   plays an item from inside a folder → owner deletes the non-empty
//   folder (contents-to-root confirm) → recipient refresh sees the
//   lifted items at root, still playable.
//
// Coverage map (share-folders spec success criteria → tests):
//   #1 recipient one-shot tree + client-side navigation → "recipient
//      browses the tree" (descent/breadcrumb asserts ride the ONE items
//      fetch — no extra request assertions needed; the vitest suite
//      pins the budget)
//   #2 flat share renders as today                    → sharing.spec.ts
//      "passwordless share" (extended with no-folder-affordance checks)
//   #4 delete-folder lifts contents to root            → "delete lifts"
//   #5 authorization untouched                          → item inside a
//      folder plays through the unchanged mirrors (this spec); denial
//      matrix lives in sharing.spec.ts + api tests
//
// Owner edits ride the real UI (dialogs, menus, picker) — task 007/008
// surfaces exercised exactly as a user drives them.

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

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

const SHARE_TITLE = "Trip folders";

// ── Shared state (populated by beforeAll) ────────────────────────────

let gdConnId = "";
let odConnId = "";
let vacationId = ""; // gd — lands in Trip
let docId = ""; // gd shared-doc.mp4 — lands in Trip
let clipId = ""; // od onedrive-clip.mp4 — lands in Night (2nd level)
let share: CreatedShare | null = null;

function theShare(): CreatedShare {
  if (!share) throw new Error("e2e setup: share not created");
  return share;
}

/** Same stretched-link overlay trap as sharing.spec.ts: dispatch the
 * native click on the anchor so React Router's handler fires. */
async function clickLink(page: Page, ariaLabel: string): Promise<void> {
  await page.evaluate((label) => {
    const a = document.querySelector<HTMLAnchorElement>(
      `a[aria-label="${label}"]`,
    );
    if (!a) throw new Error(`link with aria-label="${label}" not found`);
    a.click();
  }, ariaLabel);
}

/** Owner-side folder creation through the toolbar dialog, landing in
 * whatever level the page currently shows (`?folder=` state). */
async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("link", { name: `Open folder ${name}` }),
  ).toBeVisible();
}

/** Owner-side item move through the card menu + shared picker. */
async function moveItem(
  page: Page,
  videoName: string,
  targetFolder: string,
): Promise<void> {
  await page
    .getByRole("button", { name: `More actions for ${videoName}` })
    .click();
  await page.getByRole("menuitem", { name: "Move to folder…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: targetFolder, exact: true }).click();
  // The refetched grid drops the card from the current level.
  await expect(
    page.getByRole("link", { name: `Play ${videoName}` }),
  ).toHaveCount(0);
}

/** Recipient context — no session, no cookies, fresh IndexedDB. */
async function recipientPage(browser: Browser): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe("Share folders (docs/specs/share-folders task 009)", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page);
      gdConnId = await seedAndScan(page, "google_drive", "gd-folders@example.com", csrf);
      odConnId = await seedAndScan(page, "onedrive", "od-folders@example.com", csrf);

      const data = await getVideos(page);
      const byName = (name: string) => {
        const v = data.videos.find((x) => x.name === name);
        if (!v) throw new Error(`e2e setup: video "${name}" not found`);
        return v.id;
      };
      vacationId = byName("vacation.mp4");
      docId = byName("shared-doc.mp4");
      clipId = byName("onedrive-clip.mp4");

      share = await createShare(
        page,
        { video_ids: [vacationId, docId, clipId], title: SHARE_TITLE },
        csrf,
      );
    } finally {
      await page.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!gdConnId && !odConnId) return;
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page);
      if (share) await revokeShare(page, share.id, csrf);
      if (gdConnId) await disconnect(page, gdConnId, csrf);
      if (odConnId) await disconnect(page, odConnId, csrf);
    } finally {
      await page.close();
    }
  });

  test("owner builds a tree; recipient browses it and plays from a folder", async ({
    browser,
  }) => {
    // ── Owner: build Trip → Night, move all three members in. ──
    const owner = await browser.newPage();
    try {
      await ensureAuthenticated(owner);
      await owner.goto(`/settings/shares/${theShare().id}`);

      // Root: flat share renders the member grid.
      await expect(
        owner.getByRole("link", { name: "Play vacation.mp4" }),
      ).toBeVisible();

      // Level 1: Trip at root.
      await createFolder(owner, "Trip");
      // Level 2: Night inside Trip (created while descended — the
      // toolbar lands folders in the current level).
      await clickLink(owner, "Open folder Trip");
      await createFolder(owner, "Night");
      // Back to root for the item moves.
      await owner.getByRole("link", { name: SHARE_TITLE }).click();
      await expect(
        owner.getByRole("link", { name: "Play vacation.mp4" }),
      ).toBeVisible();

      // Move items: two into Trip, the clip two levels deep into Night.
      await moveItem(owner, "vacation.mp4", "Trip");
      await moveItem(owner, "shared-doc.mp4", "Trip");
      await moveItem(owner, "onedrive-clip.mp4", "Night");
    } finally {
      await owner.close();
    }

    // ── Recipient: clean context, one items fetch, pure client nav. ──
    const { context, page } = await recipientPage(browser);
    try {
      await page.goto(theShare().share_url);

      // Root shows the folder tile, not the folder contents.
      await expect(
        page.getByRole("link", { name: "Open folder Trip" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Play vacation.mp4" }),
      ).toHaveCount(0);

      // Descend into Trip: breadcrumb + Night tile + Trip's videos.
      await clickLink(page, "Open folder Trip");
      await expect(
        page.getByRole("link", { name: "Open folder Night" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Play vacation.mp4" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toBeVisible();

      // Descend into Night: full breadcrumb chain, the clip.
      await clickLink(page, "Open folder Night");
      await expect(
        page.getByRole("link", { name: "Play onedrive-clip.mp4" }),
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Folders" }),
      ).toContainText("Trip");
      await expect(
        page.getByRole("navigation", { name: "Folders" }),
      ).toContainText("Night");

      // Play from inside the folder — folders never gate playback.
      await clickLink(page, "Play onedrive-clip.mp4");
      await expect(page).toHaveURL(
        new RegExp(`/share/.+/watch/${encodeURIComponent(clipId)}$`),
      );
      const video = page.locator("video");
      await expect(video).toBeVisible();
      await expect
        .poll(async () => await video.getAttribute("src"))
        .toContain("/api/__e2e/mock-cdn/od-clip");
    } finally {
      await context.close();
    }
  });

  test("owner deletes a non-empty folder → recipient sees contents lift to root, still playable", async ({
    browser,
  }) => {
    // Owner: delete Trip (contains Night + all three items) through the
    // confirm dialog whose copy names the consequence.
    const owner = await browser.newPage();
    try {
      await ensureAuthenticated(owner);
      await owner.goto(`/settings/shares/${theShare().id}`);
      await expect(
        owner.getByRole("link", { name: "Open folder Trip" }),
      ).toBeVisible();

      await owner.getByRole("button", { name: "More actions for Trip" }).click();
      await owner.getByRole("menuitem", { name: "Delete" }).click();
      const dialog = owner.getByRole("dialog");
      await expect(dialog).toContainText(/move to the top level/i);
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();

      // Tree flattens: Night lifts to root alongside the videos.
      await expect(
        owner.getByRole("link", { name: "Open folder Trip" }),
      ).toHaveCount(0);
      await expect(
        owner.getByRole("link", { name: "Open folder Night" }),
      ).toBeVisible();
    } finally {
      await owner.close();
    }

    // Recipient: refresh converges on the next fetch — everything the
    // folder held sits at root and plays through the unchanged mirrors.
    const { context, page } = await recipientPage(browser);
    try {
      await page.goto(theShare().share_url);
      await expect(
        page.getByRole("link", { name: "Play vacation.mp4" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Play onedrive-clip.mp4" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Open folder Night" }),
      ).toBeVisible();

      await clickLink(page, "Play vacation.mp4");
      await expect(page).toHaveURL(
        new RegExp(`/share/.+/watch/${encodeURIComponent(vacationId)}$`),
      );
      const video = page.locator("video");
      await expect(video).toBeVisible();
      await expect
        .poll(
          async () =>
            await video.evaluate((v: HTMLVideoElement) => v.readyState),
          { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
});
