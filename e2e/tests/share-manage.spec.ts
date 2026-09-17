// E2e share manage spec (docs/specs/share-manage-page task 006) — the
// effort's user journey, end to end against the docker stack.
//
// It subsumes the old share-edit.spec.ts journey (mutable-share-list task
// 009): the Settings "Edit items" dialog entry point was replaced by
// "Manage" → `/settings/shares/:id` (task 003), and the dialog now serves
// as the manage page's add-only picker (task 005). The membership-flip
// coverage that spec carried (stale recipient tab → "no longer available
// in this share" card; fresh-nav denial) is preserved here, driven
// through the manage page's removal flow.
//
// Coverage map (share-manage-page spec success criteria → tests):
//   #1 detail route + meta + ordered grid   → test A "grid renders"
//   #3 remove → PUT → refetch → undo toast  → test A remove + undo
//      undo restores at the original index     (vacation stays first)
//   #4 last-item guard                        → test B guard
//   #6 add-only picker appends                → test B "Add items"
//   #7 revoked share renders read-only        → test B revoke
//   #9 recipient flow unchanged               → test A recipient tabs
//   (mutable-share-list #5/#6 membership flip → test A stale/fresh tabs)
//
// Recipient timing model unchanged: no live push, convergence on next
// fetch/navigation. `stale` keeps its `staleTime: Infinity` cache from
// before the removal; `fresh` full-navs after each edit.

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import {
  createShare,
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  getVideos,
  revokeShare,
  seedConnection,
  triggerScan,
  waitForScanComplete,
  type CreatedShare,
} from "./helpers";

const SHARE_TITLE = "Manage page";

// ── Shared state (populated by beforeAll) ────────────────────────────

let gdConnId = "";
let vacationId = "";
let docId = ""; // shared-doc.mp4 — removed, re-added via picker, removed again
let concertId = ""; // third member so the guard isn't hit mid-journey
let share: CreatedShare | null = null;

function theShare(): CreatedShare {
  if (!share) throw new Error("e2e setup: share not created");
  return share;
}

/** Same overlay trap as sharing.spec.ts: pointer events land on the
 * stretched link's siblings, so dispatch the native click on the anchor. */
async function clickCardLink(page: Page, ariaLabel: string): Promise<void> {
  await page.evaluate((label) => {
    const a = document.querySelector<HTMLAnchorElement>(
      `a[aria-label="${label}"]`,
    );
    if (!a) throw new Error(`link with aria-label="${label}" not found`);
    a.click();
  }, ariaLabel);
}

/** Open a recipient page — no session, no cookies, fresh IndexedDB. */
async function recipientPage(browser: Browser): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

/** Owner's Shares-page row for this spec's share (scoped against leaks).
 * Task 017: the list is a table — rows carry the title in the first cell. */
function shareRow(owner: Page) {
  return owner.getByRole("row", { name: new RegExp(SHARE_TITLE) });
}

/** Open the card's kebab menu and click Remove from share. */
async function removeViaMenu(page: Page, videoName: string): Promise<void> {
  await page
    .getByRole("button", { name: `More actions for ${videoName}` })
    .click();
  await page.getByRole("menuitem", { name: "Remove from share" }).click();
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe("Share manage page (docs/specs/share-manage-page task 006)", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page);
      // Assign the connection id before the scan waits (see share-edit
      // history: a failure inside the poll must still reach afterAll).
      gdConnId = await seedConnection(page, "google_drive", "gd-manage@example.com", csrf);
      await triggerScan(page, gdConnId, csrf);
      await waitForScanComplete(page, gdConnId);

      const data = await getVideos(page);
      const gd = data.videos.filter((v) => v.provider === "google_drive");
      const byName = (name: string) => {
        const v = gd.find((x) => x.name === name);
        if (!v) throw new Error(`e2e setup: video "${name}" not found`);
        return v.id;
      };
      vacationId = byName("vacation.mp4");
      docId = byName("shared-doc.mp4");
      concertId = byName("concert.mp4");

      share = await createShare(
        page,
        {
          video_ids: [vacationId, docId, concertId],
          title: SHARE_TITLE,
        },
        csrf,
      );
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
      if (share) await revokeShare(page, share.id, csrf);
      await disconnect(page, gdConnId, csrf);
    } finally {
      await page.close();
    }
  });

  test("owner removes from the manage page: undo restores, remove sticks, recipient converges", async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const owner = await browser.newPage();
    const { context, page: stale } = await recipientPage(browser);
    const fresh = await context.newPage();
    try {
      const s = theShare();

      // Recipient opens the link while the list still has all three —
      // this tab stays open across the removals (the stale tab).
      await stale.goto(s.share_url);
      await expect(stale.getByText("3 videos shared with you")).toBeVisible();

      // Owner: Shares list → Manage → the detail page mirrors the grid.
      await ensureAuthenticated(owner);
      await owner.goto("/shares");
      const row = shareRow(owner);
      // Task 017 table: the item count is its own cell ("3"), no longer
      // the old inline "3 items" run-on.
      await expect(row).toContainText("Manage page");
      await expect(row.getByText("3", { exact: true })).toBeVisible();

      await row.getByRole("link", { name: "Manage" }).click();
      await expect(owner).toHaveURL(
        new RegExp(`/settings/shares/${s.id}$`),
      );
      await expect(
        owner.getByRole("heading", { name: SHARE_TITLE }),
      ).toBeVisible();
      await expect(
        owner.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toBeVisible();

      // Remove shared-doc; the undo toast offers restore.
      await removeViaMenu(owner, "shared-doc.mp4");
      await expect(
        owner.getByText("Removed 'shared-doc.mp4'"),
      ).toBeVisible();
      await expect(
        owner.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toHaveCount(0);

      // Undo: the item returns at its original (middle) position.
      await owner.getByRole("button", { name: "Undo" }).click();
      await expect(
        owner.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toBeVisible();
      // vacation first, shared-doc second — the original curation order.
      const names = await owner
        .getByRole("article")
        .allInnerTexts();
      const order = names
        .join("\n")
        .split("\n")
        .filter((l) => l.endsWith(".mp4"));
      expect(order.indexOf("vacation.mp4")).toBeLessThan(
        order.indexOf("shared-doc.mp4"),
      );

      // Remove again and let it stick (no undo).
      await removeViaMenu(owner, "shared-doc.mp4");
      await expect(
        owner.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toHaveCount(0);
      await expect(owner.getByText("2 items")).toBeVisible();

      // Recipient convergence: fresh nav sees the new list…
      await fresh.goto(s.share_url);
      await expect(fresh.getByText("2 videos shared with you")).toBeVisible();
      await expect(
        fresh.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toHaveCount(0);

      // …and the stale tab (cached grid) clicks into the removed item →
      // the dedicated membership-loss card, with a way back (coverage
      // carried over from mutable-share-list's spec).
      await clickCardLink(stale, "Play shared-doc.mp4");
      await expect(stale).toHaveURL(
        new RegExp(`/share/.+/watch/${encodeURIComponent(docId)}$`),
      );
      await expect(
        stale.getByText("This video is no longer available in this share"),
      ).toBeVisible();
      await stale.getByRole("link", { name: "Go to the share page" }).click();
      await expect(stale).toHaveURL(new RegExp(`/share/${s.token}$`));
    } finally {
      await context.close();
      await owner.close();
    }
  });

  test("last-item guard blocks emptying; add-only picker re-adds; revoked share renders read-only", async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const owner = await browser.newPage();
    try {
      const s = theShare();

      // Journey state: test A left the share with vacation + concert.
      await ensureAuthenticated(owner);
      await owner.goto(`/settings/shares/${s.id}`);
      await expect(
        owner.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toHaveCount(0);

      // Remove concert → vacation is the last item → its Remove is
      // guarded with the revoke hint.
      await removeViaMenu(owner, "concert.mp4");
      await expect(
        owner.getByRole("link", { name: "Play concert.mp4" }),
      ).toHaveCount(0);

      await owner
        .getByRole("button", { name: "More actions for vacation.mp4" })
        .click();
      const guarded = owner.getByRole("menuitem", {
        name: "Remove from share",
      });
      await expect(guarded).toHaveAttribute("aria-disabled", "true");
      await expect(
        owner.getByText(
          "A share needs at least one item — revoke the share instead.",
        ),
      ).toBeVisible();
      await owner.keyboard.press("Escape");

      // Add items: the picker is add-only (members locked), saving
      // appends and the grid refetches.
      await owner.getByRole("button", { name: "Add items" }).click();
      const dialog = owner.getByRole("dialog");
      await expect(
        dialog.getByRole("checkbox", { name: "vacation.mp4" }),
      ).toBeDisabled();
      await dialog.getByRole("checkbox", { name: "shared-doc.mp4" }).check();
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        owner.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toBeVisible();
      await expect(owner.getByText("2 items")).toBeVisible();

      // Revoke → the detail page renders read-only: no menus, no picker.
      const csrf = await getCsrfToken(owner);
      await revokeShare(owner, s.id, csrf);
      await owner.reload();
      await expect(owner.getByText("Revoked", { exact: true })).toBeVisible();
      await expect(
        owner.getByText(/no longer available/i),
      ).toBeVisible();
      await expect(
        owner.getByRole("button", { name: /more actions for/i }),
      ).toHaveCount(0);
      await expect(
        owner.getByRole("button", { name: "Add items" }),
      ).toHaveCount(0);
    } finally {
      await owner.close();
    }
  });
});
