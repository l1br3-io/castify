// E2e share-list edit spec (docs/specs/mutable-share-list task 009) — the
// effort's user journey, end to end against the docker stack:
//
//   owner creates a 2-item share → recipient opens the link (grid shows
//   both) → owner removes one item via Settings' edit dialog → the
//   recipient's next full load converges to 1 → a stale recipient tab
//   (grid cached from before the edit) clicks into the removed item →
//   the dedicated "no longer available in this share" card, with a way
//   back to the grid → owner re-adds the item → recipient converges
//   back to 2.
//
// Coverage map (spec success criteria → tests here):
//   #1 replace via PUT (UI path)      → "owner edits a live share's items"
//   #5 membership flips per-request   → stale-tab card + fresh-nav denial:
//        the removed id 404s on the share scope the moment the PUT lands
//   #6 membership-loss card           → "no longer available in this
//        share" renders (not the generic stream-error card), link back
//   #8 Settings reflects edits          → row item_count flips 2→1→2;
//        the "server refetch, no optimistic patching" half of this
//        criterion is pinned by the vitest (≥2 GET /api/shares after a
//        save) — the e2e row text alone can't distinguish the two
//
// Recipient timing model (the spec promises no live push — convergence
// on next fetch/navigation). Two pages in one recipient context:
//   - stale  — loaded before the edit and left open. Its items query is
//     `staleTime: Infinity`, so the grid (and the watch page's membership
//     check) keep reading the cached 2-item list after the owner's PUT.
//     Clicking into the removed member then passes the cached membership
//     gate, the share-scope mirror 404s, and the dedicated card renders —
//     exactly the mid-session removal it exists for.
//   - fresh  — full page load after each edit, so every visit refetches
//     and shows the server's current list. A removed id loaded this way
//     never reaches the mirrors (the fresh items list already excludes
//     it) and renders the pre-existing "isn't part of the share" card —
//     asserted here as the fresh-navigation denial, matching how a
//     never-member id behaves (sharing.spec.ts's non-member test).

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

const SHARE_TITLE = "Mutable list";

// ── Shared state (populated by beforeAll) ────────────────────────────

let gdConnId = "";
let vacationId = "";
let docId = ""; // shared-doc.mp4 — the item that gets removed and re-added
let share: CreatedShare | null = null;

function theShare(): CreatedShare {
  if (!share) throw new Error("e2e setup: share not created");
  return share;
}

/**
 * Click a PosterCard's stretched link programmatically. Same overlay trap
 * as sharing.spec.ts: pointer events land on a sibling overlay, so dispatch
 * the native click() on the anchor to fire React Router's handler.
 */
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

/**
 * The owner's Settings row for this spec's share. Scoped to the listitem
 * so a leaked share from another spec can't hijack the "Edit items"
 * button lookups.
 */
function shareRow(owner: Page) {
  return owner
    .getByRole("listitem")
    .filter({ has: owner.getByRole("heading", { name: SHARE_TITLE }) });
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe("Share list editing (docs/specs/mutable-share-list task 009)", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page);
      // Assign the connection id before the scan waits: a failure inside
      // the scan poll must still reach afterAll's disconnect, or the
      // leaked fixtures (same names sharing.spec.ts picks by) stay in the
      // catalog and poison the next spec's byName lookups.
      gdConnId = await seedConnection(page, "google_drive", "gd-edit@example.com", csrf);
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

      share = await createShare(
        page,
        { video_ids: [vacationId, docId], title: SHARE_TITLE },
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

  // ────────────────────────────────────────────────────────────────────
  test("owner edits a live share's items: remove → recipient converges → stale tab gets the removal card → re-add", async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const owner = await browser.newPage();
    const { context, page: stale } = await recipientPage(browser);
    // `fresh` shares the recipient context — a full page.goto is a new
    // document with a new query cache, so it always refetches.
    const fresh = await context.newPage();
    try {
      const s = theShare();

      // Recipient opens the link while the list still has both items —
      // this tab stays open across the edit (the stale tab).
      await stale.goto(s.share_url);
      await expect(stale.getByText("2 videos shared with you")).toBeVisible();
      await expect(
        stale.getByRole("link", { name: "Play vacation.mp4" }),
      ).toBeVisible();
      await expect(
        stale.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toBeVisible();

      // Owner opens Settings and removes shared-doc.mp4 via the dialog.
      await ensureAuthenticated(owner);
      await owner.goto("/settings");
      const row = shareRow(owner);
      await expect(row).toContainText("2 items");

      await row.getByRole("button", { name: "Edit items" }).click();
      const dialog = owner.getByRole("dialog");
      await expect(
        dialog.getByRole("heading", { name: "Edit share items" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("checkbox", { name: "vacation.mp4" }),
      ).toBeChecked();
      await expect(
        dialog.getByRole("checkbox", { name: "shared-doc.mp4" }),
      ).toBeChecked();

      await dialog.getByRole("checkbox", { name: "shared-doc.mp4" }).uncheck();
      await expect(dialog.getByText("1 item selected")).toBeVisible();
      await dialog.getByRole("button", { name: "Save" }).click();

      // Dialog closes; the row's count comes from the server refetch.
      await expect(dialog).toHaveCount(0);
      await expect(row).toContainText("1 item");

      // Recipient convergence: a fresh load sees exactly the new list…
      await fresh.goto(s.share_url);
      await expect(fresh.getByText("1 video shared with you")).toBeVisible();
      await expect(
        fresh.getByRole("link", { name: "Play vacation.mp4" }),
      ).toBeVisible();
      await expect(
        fresh.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toHaveCount(0);

      // …and a removed id opened by full URL behaves like a never-member:
      // the fresh items list excludes it before any mirror is touched.
      await fresh.goto(
        `/share/${s.token}/watch/${encodeURIComponent(docId)}`,
      );
      await expect(
        fresh.getByText("This video isn't part of the share."),
      ).toBeVisible();
      await expect(fresh.locator("video")).toHaveCount(0);

      // Stale tab: the cached grid still offers the removed item. Clicking
      // in passes the cached membership gate, the share-scope mirror 404s,
      // and the dedicated card renders — not the generic stream error.
      await clickCardLink(stale, "Play shared-doc.mp4");
      await expect(stale).toHaveURL(
        new RegExp(`/share/.+/watch/${encodeURIComponent(docId)}$`),
      );
      await expect(
        stale.getByText("This video is no longer available in this share"),
      ).toBeVisible();
      await expect(
        stale.getByText("Couldn't load this video"),
      ).toHaveCount(0);
      await expect(stale.locator("video")).toHaveCount(0);

      // The card's link is the way back to the share grid.
      await stale.getByRole("link", { name: "Go to the share page" }).click();
      await expect(stale).toHaveURL(new RegExp(`/share/${s.token}$`));

      // Owner re-adds the item — same dialog, checkbox now in Library.
      await row.getByRole("button", { name: "Edit items" }).click();
      await expect(
        dialog.getByRole("checkbox", { name: "shared-doc.mp4" }),
      ).not.toBeChecked();
      await dialog.getByRole("checkbox", { name: "shared-doc.mp4" }).check();
      await expect(dialog.getByText("2 items selected")).toBeVisible();
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row).toContainText("2 items");

      // Recipient converges back to 2 (reload = fresh document = refetch).
      await stale.reload();
      await expect(stale.getByText("2 videos shared with you")).toBeVisible();
      await expect(
        stale.getByRole("link", { name: "Play shared-doc.mp4" }),
      ).toBeVisible();
    } finally {
      await context.close();
      await owner.close();
    }
  });
});
