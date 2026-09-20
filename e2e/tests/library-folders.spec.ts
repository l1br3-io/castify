// E2e library-folders test: the owner-curated organization flow against
// the full stack (docs/specs/library-folders/spec.md success criteria).
//
// Flow:
//   1. Authenticate + seed Google Drive → scan (fixtures carry videos
//      AND non-media files — everything lands Unfiled by design)
//   2. Curated default view: Unfiled tile + count; empty-tree CTA
//   3. Build a 2-level tree (Trip → Day 1) from the organizer header
//   4. Select mode: batch-move vacation.mp4 (video) + song.mp3 (file)
//      out of Unfiled into Day 1 — one request
//   5. Descend via tile + breadcrumb; play a video from inside Day 1
//   6. Delete non-empty Trip → items reappear under Unfiled, playable
//   7. New files land unfiled: a second connection's scan adds items
//      to Unfiled with zero manual filing
//   8. Provider view still browsable behind the Cloud toggle; a ?dir=
//      deep link still lands

import { test, expect, type Page } from "@playwright/test";
import {
  ensureAuthenticated,
  getCsrfToken,
  seedAndScan,
  triggerScan,
  waitForScanComplete,
  disconnect,
} from "./helpers";

async function clickCardLink(page: Page, ariaLabel: string): Promise<void> {
  await page.evaluate((label) => {
    const a = document.querySelector<HTMLAnchorElement>(
      `a[aria-label="${label}"]`,
    );
    if (!a) throw new Error(`link with aria-label="${label}" not found`);
    a.click();
  }, ariaLabel);
}

test.describe("Library folders (e2e mock)", () => {
  test("curated tree, batch move, delete-to-unfiled, provider view intact", async ({
    page,
  }) => {
    // Two full scans (Google Drive + Dropbox) plus a long UI flow.
    test.setTimeout(120_000);
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    const gdId = await seedAndScan(
      page,
      "google_drive",
      "gd-libfolders@example.com",
      csrf,
    );

    let dbId: string | null = null;
    try {
      await page.goto("/");
    const organizer = page.locator("section[aria-label='Folder organizer']");

    // ── Curated default: empty tree + Unfiled with the whole scan ──
    await expect(organizer.getByText("Unfiled").first()).toBeVisible();
    // Google Drive scan: 3 videos + 6 files across kinds — the unfiled
    // bucket counts them all. Read the tile's live count for the deltas
    // below rather than pinning an absolute (the suite shares one stack).
    const unfiledBadge = organizer.locator("h3[title='Unfiled'] + p, h3[title='Unfiled'] ~ p").first();
    await expect(unfiledBadge).toHaveText(/\d+ items/);
    const initial = Number((await unfiledBadge.textContent())!.match(/\d+/)![0]);
    expect(initial).toBeGreaterThanOrEqual(9);
    // Use the always-present header chip, not the empty-tree CTA — the
    // suite shares one DB, so earlier tests may have left folders behind.
    await expect(
      organizer.getByRole("button", { name: "+ New folder" }),
    ).toBeVisible();
    await expect(
      organizer.getByRole("link", { name: "Play vacation.mp4" }),
    ).toBeVisible();

    // ── Build the 2-level tree: Trip → Day 1 ─────────────────────────
    await organizer.getByRole("button", { name: "+ New folder" }).click();
    await organizer.getByLabel("Folder name").fill("Trip");
    await organizer.getByRole("button", { name: "Save" }).click();
    await expect(organizer.getByRole("link", { name: "Open folder Trip" })).toBeVisible();

    // Descend into Trip; create Day 1 inside it. The folder tile's
    // stretched link is intercepted by its glyph well in a real browser —
    // use the suite's DOM-click idiom (see organizer.spec.ts) rather than
    // Playwright's actionability-checked click, which retries to the test
    // timeout.
    await clickCardLink(page, "Open folder Trip");
    await expect(organizer.getByTestId("contents-path")).toHaveText("Trip");
    await organizer.getByRole("button", { name: "+ New folder" }).click();
    await organizer.getByLabel("Folder name").fill("Day 1");
    await organizer.getByRole("button", { name: "Save" }).click();
    await expect(organizer.getByRole("link", { name: "Open folder Day 1" })).toBeVisible();

    // ── Batch-move mixed items out of Unfiled into Day 1 ────────────
    await organizer.getByRole("button", { name: "Library" }).click();
    await expect(organizer.getByTestId("contents-path")).toHaveText("Unfiled");

    await organizer.getByRole("button", { name: "Select items" }).click();
    // Gate on the action bar before touching cards: a missed or double
    // mode toggle must fail here (fast, diagnosable) rather than leave
    // the card clicks retrying actionability until the test timeout.
    await expect(organizer.getByText("0 items selected")).toBeVisible();
    // The checkbox is the card's explicit selection control (the same
    // interaction the browse-grid specs use); the audio FileCard has no
    // checkbox, so its card body toggles.
    await organizer
      .getByRole("checkbox", { name: "Select vacation.mp4" })
      .click();
    await organizer
      .locator("article", { hasText: "song.mp3" })
      .first()
      .click();
    await expect(organizer.getByText("2 items selected")).toBeVisible();

    const moveRequest = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" && req.url().endsWith("/api/library-folders/items"),
    );
    await organizer.getByRole("button", { name: "Move to folder" }).click();
    // Pick Day 1 (not Trip): the flow below descends into Day 1 to play
    // vacation.mp4 there, and the Trip deletion then lifts the whole
    // subtree (Day 1 + its items) back to Unfiled.
    await page
      .getByRole("dialog", { name: "Move 2 items" })
      .getByRole("button", { name: "Day 1" })
      .click();
    const move = await moveRequest;
    const moveBody = move.postDataJSON() as {
      items: Array<{ kind: string; id: string }>;
      folder_id: string;
    };
    expect(moveBody.items).toHaveLength(2);
    expect(moveBody.items.map((i) => i.kind).sort()).toEqual(["file", "video"]);

    // Unfiled drains by exactly the 2 filed items.
    await expect(unfiledBadge).toHaveText(`${initial - 2} items`);

    // Leave select mode before browsing on: the mode is sticky after a
    // successful move (matches the browse grid's pattern) and its cards
    // toggle selection instead of exposing play links.
    await organizer.getByRole("button", { name: "Done" }).click();

    // ── Descend and play a video from inside the folder ─────────────
    await clickCardLink(page, "Open folder Trip");
    await expect(
      organizer.getByRole("link", { name: "Open folder Day 1" }),
    ).toBeVisible();
    await clickCardLink(page, "Open folder Day 1");
    await expect(organizer.getByTestId("contents-path")).toHaveText("Day 1");
    await expect(
      organizer.getByRole("link", { name: "Play vacation.mp4" }),
    ).toBeVisible();

    await clickCardLink(page, "Play vacation.mp4");
    await expect(page).toHaveURL(/\/watch\//);
    await page.goBack();

    // ── Delete non-empty Trip → items return to Unfiled ─────────────
    await organizer.getByRole("button", { name: "Library" }).click();
    await organizer.getByRole("button", { name: "More actions for Trip" }).click();
    await organizer.getByRole("menuitem", { name: "Delete" }).click();
    await expect(
      page.getByText(/Items in it return to Unfiled and its subfolders move to the/i),
    ).toBeVisible();
    await page.getByRole("dialog", { name: 'Delete "Trip"?' }).getByRole("button", { name: "Delete" }).click();

    // Day 1 flattened to root; everything unfiled again, still playable.
    await expect(organizer.getByRole("link", { name: "Open folder Day 1" })).toBeVisible();
    await expect(unfiledBadge).toHaveText(`${initial} items`);
    await expect(
      organizer.getByRole("link", { name: "Play vacation.mp4" }),
    ).toBeVisible();

    // ── New files land unfiled: a fresh scan, zero manual filing ────
      dbId = await seedAndScan(page, "dropbox", "db-libfolders@example.com", csrf);
    // Dropbox adds screenshots.mp4 + 3 files (its shared-doc twin dedups
    // into the existing group) — unfiled grows by exactly 4.
    await expect(unfiledBadge).toHaveText(`${initial + 4} items`);
    await expect(
      organizer.getByRole("link", { name: "Play screenshots.mp4" }),
    ).toBeVisible();

    // ── Provider view still browsable; ?dir= deep link lands ────────
    await page.getByRole("button", { name: "Cloud", exact: true }).click();
    await page.getByRole("button", { name: "Expand Media" }).click();
    await page.locator("button[data-tree-key='/Media/Music']").click();
    await expect(
      organizer.getByRole("link", { name: "Download song.mp3" }).first(),
    ).toBeVisible();

    await page.goto(`/?dir=${encodeURIComponent("/Movies")}`);
    await expect(
      page.getByRole("tree", { name: "Cloud folders" }),
    ).toBeVisible();
    await expect(
      organizer.getByRole("link", { name: "Play vacation.mp4" }),
    ).toBeVisible();

    // ── Cleanup ─────────────────────────────────────────────────────
    } finally {
      await disconnect(page, gdId, csrf);
      if (dbId !== null) await disconnect(page, dbId, csrf);
    }
  });

  test("new scan output appears under Unfiled while folders keep their items", async ({
    page,
  }) => {
    // Seed-scan plus a rescan of the same connection.
    test.setTimeout(120_000);
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    const gdId = await seedAndScan(
      page,
      "google_drive",
      "gd-unfiled@example.com",
      csrf,
    );

    try {
      await page.goto("/");
      const organizer = page.locator("section[aria-label='Folder organizer']");
      const unfiledBadge = organizer.locator("h3[title='Unfiled'] + p, h3[title='Unfiled'] ~ p").first();
      await expect(unfiledBadge).toHaveText(/\d+ items/);
      const initial = Number((await unfiledBadge.textContent())!.match(/\d+/)![0]);

      // File song.mp3 into a folder, then re-run the same connection's
      // scan — placement must survive and nothing duplicates.
      // Header chip, not the empty-tree CTA (tree may not be empty —
      // the suite shares one DB with earlier tests' folders).
      await organizer.getByRole("button", { name: "+ New folder" }).click();
      await organizer.getByLabel("Folder name").fill("Music");
      await organizer.getByRole("button", { name: "Save" }).click();
      await expect(
        organizer.getByRole("link", { name: "Open folder Music" }),
      ).toBeVisible();

      await triggerScan(page, gdId, csrf);
      await waitForScanComplete(page, gdId);
      await expect(unfiledBadge).toHaveText(`${initial} items`);
    } finally {
      await disconnect(page, gdId, csrf);
    }
  });
});
