// E2e sharing spec (docs/specs/sharing task 013) — the spec's user journey,
// end to end against the docker stack:
//
//   owner creates a password-protected share → clean browser context opens
//   the link → password gate (wrong password rejected) → unlock → item
//   list → play a direct item → play a transcode-needing item → owner
//   revokes → recipient gets the terminal page.
//
// Coverage map (spec success criteria → tests here):
//   #1 create w/ items+password        → "password share happy path"
//   #2 stream both strategies          → "direct play" + "transcode via HLS"
//   #3 revoked → terminal 410          → "revoke → terminal state"
//   #4 gate + wrong-password rejection → "password share happy path"
//      (rate limiting is unit/integration-covered; one wrong attempt here
//      proves the rejection path without tripping the lockout)
//   #6 non-member items unreachable    → "non-member denial"
//   #7 zero server writes on playback  → vitest share-watch (fetch spy);
//      here the recipient context holds no session at all, so any write
//      would 401 rather than silently succeed
//
// The transcode sub-test relies on the e2e stack being built on the
// alpine+ffmpeg `e2e-runtime` image (docker-compose.e2e.yml) and on the
// `gd-concert` mock fixture carrying MPEG-2 bytes: the first share-scoped
// stream-url call triggers the lazy ffprobe, which flips the strategy to
// `transcode`; ffmpeg then produces real HLS segments that hls.js plays
// through the share scope.

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import {
  createShare,
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  getShareStreamUrl,
  getVideos,
  revokeShare,
  seedAndScan,
  unlockShare,
  type CreatedShare,
} from "./helpers";

const SHARE_PASSWORD = "share-pass-123";
const SHARE_TITLE = "Family videos";

// ── Shared state (populated by beforeAll) ────────────────────────────

let gdConnId = "";
let odConnId = "";
let vacationId = "";
let concertId = "";
let clipId = "";
let nonMemberId = ""; // shared-doc.mp4 — in the catalog, never in a share
let pwShare: CreatedShare | null = null; // password-protected
let openShare: CreatedShare | null = null; // passwordless

function shareA(): CreatedShare {
  if (!pwShare) throw new Error("e2e setup: password share not created");
  return pwShare;
}
function shareB(): CreatedShare {
  if (!openShare) throw new Error("e2e setup: open share not created");
  return openShare;
}

/**
 * Click a PosterCard's stretched link programmatically. Same overlay trap
 * as play.spec.ts: pointer events land on a sibling overlay, so dispatch
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

/** Open a recipient context — no session, no cookies, fresh IndexedDB. */
async function recipientPage(browser: import("@playwright/test").Browser): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

/** Wait for the watch page's `<video>` to reach a readyState threshold. */
async function waitForVideoReady(
  page: Page,
  minReadyState = 1,
  timeoutMs = 15_000,
): Promise<void> {
  const video = page.locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(
      async () =>
        await video.evaluate((v: HTMLVideoElement) => v.readyState),
      { timeout: timeoutMs },
    )
    .toBeGreaterThanOrEqual(minReadyState);
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe("Sharing (docs/specs/sharing task 013)", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page);
      gdConnId = await seedAndScan(page, "google_drive", "gd-share@example.com", csrf);
      odConnId = await seedAndScan(page, "onedrive", "od-share@example.com", csrf);

      const data = await getVideos(page);
      const gd = data.videos.filter((v) => v.provider === "google_drive");
      const od = data.videos.filter((v) => v.provider === "onedrive");
      const byName = (list: typeof data.videos, name: string) => {
        const v = list.find((x) => x.name === name);
        if (!v) throw new Error(`e2e setup: video "${name}" not found`);
        return v.id;
      };
      vacationId = byName(gd, "vacation.mp4");
      concertId = byName(gd, "concert.mp4"); // MPEG-2 fixture (see e2e.rs)
      clipId = byName(od, "onedrive-clip.mp4");
      nonMemberId = byName(gd, "shared-doc.mp4");

      pwShare = await createShare(
        page,
        {
          video_ids: [vacationId, concertId, clipId],
          title: SHARE_TITLE,
          password: SHARE_PASSWORD,
        },
        csrf,
      );
      openShare = await createShare(
        page,
        { video_ids: [vacationId] },
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
      // Share A is revoked by the revoke sub-test; tidy up B so a
      // `--grep` partial run never leaves live shares behind.
      if (openShare) await revokeShare(page, openShare.id, csrf);
      if (gdConnId) await disconnect(page, gdConnId, csrf);
      if (odConnId) await disconnect(page, odConnId, csrf);
    } finally {
      await page.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  test("password share: gate → wrong password rejected → unlock → items → direct play", async ({
    browser,
  }) => {
    const { context, page } = await recipientPage(browser);
    try {
      const share = shareA();
      await page.goto(share.share_url);

      // Gate renders: title + password form, no item grid.
      await expect(
        page.getByRole("heading", { name: SHARE_TITLE }),
      ).toBeVisible();
      const passwordInput = page.getByLabel("Password");
      await expect(passwordInput).toBeVisible();
      await expect(page.getByText("shared with you")).toHaveCount(0);

      // Items are locked at the API level too (no unlock cookie yet).
      const lockedItems = await page.request.get(
        `/api/share/${share.token}/items`,
      );
      expect(lockedItems.status()).toBe(401);

      // Wrong password → inline rejection, still on the gate.
      await passwordInput.fill("totally-wrong-pass");
      await page.getByRole("button", { name: "Unlock" }).click();
      await expect(page.getByRole("alert")).toContainText(
        /Wrong password/,
      );

      // Correct password → grid with all three members.
      await passwordInput.fill(SHARE_PASSWORD);
      await page.getByRole("button", { name: "Unlock" }).click();
      await expect(
        page.getByText("3 videos shared with you"),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Play onedrive-clip.mp4" }),
      ).toBeVisible();

      // The proxy member's stream-url is share-scoped (Drive → proxy).
      const proxyUrl = await getShareStreamUrl(page, share.token, vacationId);
      expect(proxyUrl.strategy).toBe("proxy");
      expect(proxyUrl.url).toBe(
        `/api/share/${share.token}/videos/${encodeURIComponent(vacationId)}/stream`,
      );

      // Play the direct-strategy member (OneDrive → mock CDN passthrough).
      await clickCardLink(page, "Play onedrive-clip.mp4");
      await expect(page).toHaveURL(
        new RegExp(`/share/.+/watch/${encodeURIComponent(clipId)}$`),
      );

      const video = page.locator("video");
      await expect(video).toBeVisible();
      await expect
        .poll(async () => await video.getAttribute("src"))
        .toContain("/api/__e2e/mock-cdn/od-clip");
      await waitForVideoReady(page);

      await expect(
        page.getByRole("heading", { name: "onedrive-clip.mp4" }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  test("transcode-needing item plays via share-scoped HLS (hls.js)", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const { context, page } = await recipientPage(browser);
    try {
      const share = shareA();

      // API unlock — the UI unlock path is covered by the previous test.
      await unlockShare(page, share.token, SHARE_PASSWORD);

      // The first share-scoped stream-url call triggers the lazy probe;
      // poll until ffprobe's mpeg2video verdict flips the strategy.
      await expect
        .poll(
          async () =>
            (await getShareStreamUrl(page, share.token, concertId)).strategy,
          { timeout: 30_000 },
        )
        .toBe("transcode");

      const streamUrl = await getShareStreamUrl(page, share.token, concertId);
      // Master URL is rooted under the share scope (task 005's seam) —
      // hls.js resolves the relative variant/segment URIs against it.
      const masterUrl = streamUrl.url;
      expect(masterUrl).toBe(
        `/api/share/${share.token}/videos/${encodeURIComponent(concertId)}/transcode/master.m3u8`,
      );

      // Kick the master (starts the transcode worker) and read the variant
      // URI it advertises.
      const masterRes = await page.request.get(masterUrl);
      expect(masterRes.status()).toBe(200);
      const masterBody = await masterRes.text();
      expect(masterBody).toContain("#EXT-X-STREAM-INF");
      const variantUri = masterBody
        .split("\n")
        .find((l) => l.endsWith("playlist.m3u8"));
      expect(variantUri).toBeTruthy();

      // Wait until ffmpeg has written the variant playlist + first
      // segment — before the browser mounts. hls.js's retry policy on a
      // 404 level playlist is not contractual; facing ready assets keeps
      // the browser-side assertions deterministic.
      const playlistUrl = masterUrl.replace("master.m3u8", "") + variantUri;
      await expect
        .poll(
          async () =>
            (await page.request.get(playlistUrl)).status(),
          { timeout: 60_000 },
        )
        .toBe(200);

      // Watch the HLS chain flow through share-scoped URLs in the browser.
      const masterInBrowser = page.waitForResponse(
        (r) =>
          r.url().includes("/transcode/master.m3u8") && r.status() === 200,
      );
      const playlistInBrowser = page.waitForResponse(
        (r) => r.url().includes("playlist.m3u8") && r.status() === 200,
      );
      const segmentInBrowser = page.waitForResponse(
        (r) =>
          r.url().includes(".ts") &&
          r.url().includes("/transcode/") &&
          r.status() === 200,
      );

      await page.goto(
        `/share/${share.token}/watch/${encodeURIComponent(concertId)}`,
      );

      expect((await masterInBrowser).url()).toContain("/api/share/");
      expect((await playlistInBrowser).url()).toContain("/api/share/");
      expect((await segmentInBrowser).url()).toContain("/api/share/");

      // The "Transcoding…" overlay clears once the HLS engine is ready,
      // and the <video> buffers actual frames. GOTCHA: don't assert on
      // video.src — this Chromium answers canPlayType("…mpegurl"), so
      // useHlsStream takes its native-HLS branch (src = master URL);
      // MSE-elsewhere is an engine detail, not a contract.
      const video = page.locator("video");
      await expect(video).toBeVisible();
      await expect(page.getByText("Transcoding…")).toHaveCount(0, {
        timeout: 30_000,
      });
      await waitForVideoReady(page, 2, 30_000);
    } finally {
      await context.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  test("passwordless share: no gate, items render directly", async ({
    browser,
  }) => {
    const { context, page } = await recipientPage(browser);
    try {
      await page.goto(shareB().share_url);

      await expect(
        page.getByRole("heading", { name: "Shared items" }),
      ).toBeVisible();
      await expect(page.getByLabel("Password")).toHaveCount(0);
      await expect(page.getByText("1 video shared with you")).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Play vacation.mp4" }),
      ).toBeVisible();

      // Degenerate flat share (share-folders criterion 2): no folder
      // affordances at all — the tree payload's empty `folders` list
      // renders exactly the pre-folders grid.
      await expect(
        page.getByRole("link", { name: /Open folder/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("navigation", { name: "Folders" }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  test("non-member item is not reachable with the share token", async ({
    browser,
  }) => {
    const { context, page } = await recipientPage(browser);
    try {
      const share = shareB(); // contains only vacation.mp4

      // API denial: stream + stream-url mirrors both 404 for a catalog
      // video that exists but is not a member of this share.
      const streamRes = await page.request.get(
        `/api/share/${share.token}/videos/${encodeURIComponent(nonMemberId)}/stream`,
        { headers: { Range: "bytes=0-3" } },
      );
      expect(streamRes.status()).toBe(404);

      const streamUrlRes = await page.request.get(
        `/api/share/${share.token}/videos/${encodeURIComponent(nonMemberId)}/stream-url`,
      );
      expect(streamUrlRes.status()).toBe(404);

      // UI denial: the watch page refuses before fetching any bytes.
      await page.goto(
        `/share/${share.token}/watch/${encodeURIComponent(nonMemberId)}`,
      );
      await expect(
        page.getByText("This video isn't part of the share."),
      ).toBeVisible();
      await expect(page.locator("video")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  test("owner revokes → recipient gets terminal state (cookie is not authority)", async ({
    browser,
  }) => {
    const owner = await browser.newPage();
    const { context, page } = await recipientPage(browser);
    try {
      const share = shareA();

      // Recipient unlocks while the share is still live — the cookie is
      // now in their context jar.
      await unlockShare(page, share.token, SHARE_PASSWORD);
      const before = await page.request.get(`/api/share/${share.token}`);
      expect(before.status()).toBe(200);

      // Owner revokes.
      await ensureAuthenticated(owner);
      const csrf = await getCsrfToken(owner);
      await revokeShare(owner, share.id, csrf);

      // API: every recipient endpoint is terminal — even with the unlock
      // cookie present (revocation is re-checked on every request).
      const resolveRes = await page.request.get(`/api/share/${share.token}`);
      expect(resolveRes.status()).toBe(410);
      const itemsRes = await page.request.get(
        `/api/share/${share.token}/items`,
      );
      expect(itemsRes.status()).toBe(410);

      // UI: landing shows the sticky terminal page, no catalog leak.
      await page.goto(share.share_url);
      await expect(
        page.getByText("This share is no longer available."),
      ).toBeVisible();
      await expect(page.getByLabel("Password")).toHaveCount(0);
    } finally {
      await context.close();
      await owner.close();
    }
  });
});
