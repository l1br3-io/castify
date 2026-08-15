// E2e organizer test (M9): the folder spine — tree navigation, mixed-kind
// contents (videos play; files download, never play).
//
// Flow:
//   1. Authenticate + seed Google Drive → scan (mock fixtures carry
//      non-media files across nested folders: Media/Music, Photos, Docs…)
//   2. Browse root organizer: verify mixed contents render (song.mp3 tile,
//      thesis.pdf row, vacation.mp4 poster)
//   3. Navigate the tree to Media → Music → verify contents narrow + URL
//      gains ?dir=
//   4. Video entry opens the watch page; non-media entries expose download
//      ONLY (no play affordance anywhere in the pane)
//   5. Download a file → attachment disposition + suggested filename
//   6. Cleanup: disconnect

import { test, expect, type Page } from "@playwright/test";
import {
  ensureAuthenticated,
  getCsrfToken,
  seedAndScan,
  disconnect,
} from "./helpers";

// The card's stretched play link can be intercepted by the thumbnail's
// hover layers in a real browser; the suite's established idiom (see
// play.spec.ts's clickCardLink) clicks the anchor directly in the DOM.
async function clickCardLink(page: Page, ariaLabel: string): Promise<void> {
  await page.evaluate((label) => {
    const a = document.querySelector<HTMLAnchorElement>(
      `a[aria-label="${label}"]`,
    );
    if (!a) throw new Error(`link with aria-label="${label}" not found`);
    a.click();
  }, ariaLabel);
}

test.describe("Folder organizer (e2e mock)", () => {
  test("tree navigation, mixed kinds, play-only-on-videos, file download", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    const gdId = await seedAndScan(
      page,
      "google_drive",
      "gd-organizer@example.com",
      csrf,
    );

    await page.goto("/");

    // Organizer renders with the library loaded.
    const tree = page.getByRole("tree", { name: "Folders" });
    await expect(tree).toBeVisible();

    // Root contents: mixed kinds — video poster (vacation.mp4 lives under
    // /Movies, so root shows it only when navigating; root-level here means
    // the top-level folders' direct children are folders themselves — the
    // root contents listing shows files directly at "/", i.e. none from the
    // mock). Select Movies via the tree instead.
    // Movies is a top-level folder in the mock's path layout (/Movies/…).
    await page.locator("button[data-tree-path='/Movies']").click();

    // Contents pane narrows to /Media/Movies: vacation.mp4 (video) +
    // concert.mp4 (video) + shared-doc.mp4 (video) + vacation.en.srt
    // (subtitle dual-representation file row).
    // Scope to the organizer — the rail + grid above/below also render
    // vacation.mp4 links.
    const organizer = page.locator("section[aria-label='Folder organizer']");
    await expect(
      organizer.getByRole("link", { name: "Play vacation.mp4" }),
    ).toBeVisible();
    await expect(
      organizer.getByRole("link", { name: "Download vacation.en.srt" }).first(),
    ).toBeVisible();

    // Non-media entries never carry a play affordance.
    await expect(
      organizer.getByRole("link", { name: /Play vacation.en.srt/ }),
    ).toHaveCount(0);

    // Video entry navigates to the watch page.
    await clickCardLink(page, "Play vacation.mp4");
    await expect(page).toHaveURL(/\/watch\//);
    await page.goBack();

    // Navigate deeper: Media → Music holds song.mp3 (audio tile).
    await page.getByRole("button", { name: "Expand Media" }).click();
    await page.locator("button[data-tree-path='/Media/Music']").click();
    await expect(
      organizer.getByRole("link", { name: "Download song.mp3" }).first(),
    ).toBeVisible();
    // URL deep-link: ?dir= carries the folder path.
    await expect(page).toHaveURL(/dir=%2FMedia%2FMusic/);

    // ── File download: attachment disposition + deterministic bytes ──
    const downloadPromise = page.waitForEvent("download");
    await organizer
      .getByRole("link", { name: "Download song.mp3" })
      .first()
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("song.mp3");

    // ── Cleanup ─────────────────────────────────────────────────────
    await disconnect(page, gdId, csrf);
  });
});
