// E2e play-lifecycle test (M3 T14).
//
// Covers the full M3 play experience against the Docker stack built with the
// `e2e` cargo feature (mock providers + mock CDN route + seed endpoint).
// Eight focused sub-tests under one `test.describe`, run serially in a single
// Playwright worker (`workers: 1`). Shared connection seeding happens once in
// `beforeAll`; each sub-test gets a fresh `page` (and therefore a fresh
// BrowserContext → fresh cookies + IndexedDB) and authenticates independently.
//
// Sub-tests:
//   1. play            — PosterCard click → /watch/:id → <video> loads
//   2. seek            — keyboard 'l' advances currentTime; Range → 206
//   3. resume          — seeded IndexedDB position seeks video + shows toast
//   4. skip (queue)    — prev/next buttons + saveNow() before navigation
//   5. subtitle        — <track> rendered + toggle flips mode to "showing"
//   6. progress (IDB)  — seeked/ended events write to IndexedDB
//   7. continue-watch  — seeded entry → shelf renders → card resumes
//   8. progress (API)  — direct POST/GET /progress contract (AC #220)
//
// Persistence note: the M3 PRD describes server-side progress (POST /progress
// → playback_progress table). T10 switched the frontend to IndexedDB-only
// (`castify-player` DB, `playbackProgress` store). The server endpoints remain
// functional but dormant. Sub-tests 6 + 7 cover the actual frontend path;
// sub-test 8 locks the backend contract for any future client (PRD AC #220).
//
// Requires the e2e compose override (builds with --features e2e).

import { test, expect, type Page } from "@playwright/test";

import {
  clearPlayerDB,
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  getProgress,
  getStreamUrl,
  getVideoDetail,
  getVideos,
  postProgress,
  readProgressEntry,
  seedAndScan,
  seedProgressEntry,
  type ProgressEntry,
  type VideoSummary,
} from "./helpers";

// ── Shared state (populated by beforeAll) ────────────────────────────

let gdConnId = "";
let odConnId = "";
let gdVideos: VideoSummary[] = [];
let odVideos: VideoSummary[] = [];

// Google Drive's e2e mock seeds `vacation.mp4` with an `.en.srt` sidecar —
// the only video with a subtitle track. Tests that need subtitles or a
// predictable "first Drive video" use this helper.
function gdByName(name: string): VideoSummary {
  const v = gdVideos.find((x) => x.name === name);
  if (!v) throw new Error(`e2e setup: google_drive video "${name}" not found`);
  return v;
}

function odFirst(): VideoSummary {
  if (odVideos.length === 0) throw new Error("e2e setup: no onedrive videos");
  return odVideos[0];
}

/** Wait for the watch page's `<video>` element to load metadata. */
async function waitForVideoMetadata(page: Page): Promise<void> {
  const video = page.locator("video");
  await expect(video).toBeVisible();
  // `src` populates once the `/stream-url` query resolves.
  await expect
    .poll(async () => await video.getAttribute("src"), { timeout: 10_000 })
    .not.toBeNull();
  // `loadedmetadata` fires once the 24-byte mock MP4 header is fetched.
  await expect
    .poll(
      async () =>
        await video.evaluate((v: HTMLVideoElement) => v.readyState),
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1);
}

/**
 * Click a PosterCard / ContinueWatchingCard link programmatically.
 *
 * The cards render a stretched `<a>` overlay (`absolute inset-0 z-0`) that
 * sits BENEATH the thumbnail content (later sibling, same z). Pointer
 * events land on the overlay, not the link — so Playwright's `click()`
 * misses navigation. `force: true` doesn't help (force skips actionability
 * checks but doesn't change event dispatch). Calling the native `click()`
 * on the anchor fires React Router's onClick handler directly, bypassing
 * the overlay entirely.
 */
async function clickCardLink(
  page: Page,
  ariaLabel: string,
): Promise<void> {
  await page.evaluate((label) => {
    const a = document.querySelector<HTMLAnchorElement>(
      `a[aria-label="${label}"]`,
    );
    if (!a) throw new Error(`link with aria-label="${label}" not found`);
    a.click();
  }, ariaLabel);
}

/** Per-test setup: authenticate + ensure a clean IndexedDB slate. */
async function setupPage(page: Page): Promise<void> {
  await ensureAuthenticated(page);
  // IndexedDB is scoped to the BrowserContext; each test gets a fresh one
  // by default. The clear is a belt-and-braces guard for `test.fail` retries
  // that reuse the same context.
  await clearPlayerDB(page);
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe("Play lifecycle (M3 T14)", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page);
      gdConnId = await seedAndScan(
        page,
        "google_drive",
        "gd-play@example.com",
        csrf,
      );
      odConnId = await seedAndScan(
        page,
        "onedrive",
        "od-play@example.com",
        csrf,
      );
      const data = await getVideos(page);
      gdVideos = data.videos.filter((v) => v.provider === "google_drive");
      odVideos = data.videos.filter((v) => v.provider === "onedrive");
      // Sanity: 3 Drive videos (vacation, concert, shared-doc) + 1 OneDrive.
      expect(gdVideos.length).toBeGreaterThanOrEqual(3);
      expect(odVideos.length).toBeGreaterThanOrEqual(1);
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
      if (gdConnId) await disconnect(page, gdConnId, csrf);
      if (odConnId) await disconnect(page, odConnId, csrf);
    } finally {
      await page.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  test("play: PosterCard click loads /watch/:id with <video> from stream-url", async ({
    page,
  }) => {
    await setupPage(page);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "All videos" }),
    ).toBeVisible();

    const vacation = gdByName("vacation.mp4");
    await clickCardLink(page, `Play ${vacation.name}`);
    await expect(page).toHaveURL(/\/watch\//);

    // Stream-url returns proxy strategy for Google Drive.
    const streamUrl = await getStreamUrl(page, vacation.id);
    expect(streamUrl.strategy).toBe("proxy");
    expect(streamUrl.url).toBe(
      `/api/videos/${encodeURIComponent(vacation.id)}/stream`,
    );

    // <video> element mounts with src from the stream-url response.
    await waitForVideoMetadata(page);
    const video = page.locator("video");
    const src = await video.getAttribute("src");
    expect(src).toBe(
      `/api/videos/${encodeURIComponent(vacation.id)}/stream`,
    );

    // Heading renders with the video name (watch page is interactive).
    await expect(
      page.getByRole("heading", { name: vacation.name }),
    ).toBeVisible();

    // The stream endpoint serves video/mp4 bytes with Range support.
    const streamRes = await page.request.get(src!, {
      headers: { Range: "bytes=0-3" },
    });
    expect(streamRes.status()).toBe(206);
    expect(streamRes.headers()["content-range"]).toMatch(
      /^bytes 0-3\/\d+$/,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  test("seek: keyboard 'l' advances currentTime; Range request returns 206", async ({
    page,
  }) => {
    await setupPage(page);

    // Use the OneDrive video to exercise the Direct strategy (mock CDN).
    const clip = odFirst();
    await page.goto(`/watch/${encodeURIComponent(clip.id)}`);
    await waitForVideoMetadata(page);

    const video = page.locator("video");

    // Stream-url reports Direct strategy + mock CDN URL.
    const streamUrl = await getStreamUrl(page, clip.id);
    expect(streamUrl.strategy).toBe("direct");
    expect(streamUrl.url).toContain("/api/__e2e/mock-cdn/");

    // Reset to a known position (the 24-byte mock MP4 won't progress on its own).
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 0;
    });

    // Global keyboard shortcut 'l' = +10s. Registered on window; safe from
    // anywhere except form fields.
    await page.keyboard.press("l");

    // currentTime advanced ~10s.
    await expect
      .poll(
        async () =>
          await video.evaluate((v: HTMLVideoElement) => v.currentTime),
        { timeout: 3_000 },
      )
      .toBeGreaterThanOrEqual(5);

    // The mock CDN endpoint serves 206 for Range requests.
    const cdnRes = await page.request.get(streamUrl.url, {
      headers: { Range: "bytes=0-3" },
    });
    expect(cdnRes.status()).toBe(206);
    expect(cdnRes.headers()["content-range"]).toMatch(/^bytes 0-3\/\d+$/);
  });

  // ────────────────────────────────────────────────────────────────────
  test("resume: seeded IndexedDB position seeks video on load + shows toast", async ({
    page,
  }) => {
    await setupPage(page);

    const vacation = gdByName("vacation.mp4");
    // Need to be on the app origin to write IndexedDB.
    await page.goto("/");
    const entry: ProgressEntry = {
      videoId: vacation.id,
      positionSeconds: 90,
      durationSeconds: 120,
      completed: false,
      updatedAt: Date.now(),
      videoName: vacation.name,
      videoDurationMs: 120_000,
      thumbnailStatus: "ready",
      height: 1080,
      provider: "google_drive",
    };
    await seedProgressEntry(page, entry);

    // Navigate directly — IDB persists across same-origin navigations.
    // (Avoids a PosterCard click here because the browse grid renders
    // asynchronously; the click helper resolves before the cards mount.)
    await page.goto(`/watch/${encodeURIComponent(vacation.id)}`);

    await waitForVideoMetadata(page);
    const video = page.locator("video");

    // The resume toast renders with formatted position (90s → "1:30").
    // Use exact match — the player time display also contains "1:30" as
    // part of "1:30 / 2:00".
    await expect(page.getByRole("status")).toContainText(/Resume from/);
    await expect(page.getByText("1:30", { exact: true })).toBeVisible();

    // The video seeked to 90s on loadedmetadata.
    await expect
      .poll(
        async () =>
          await video.evaluate((v: HTMLVideoElement) => v.currentTime),
        { timeout: 3_000 },
      )
      .toBeCloseTo(90, 0);

    // "Start from beginning" resets to 0 and dismisses the toast.
    await page.getByRole("button", { name: "Start from beginning" }).click();
    await expect
      .poll(
        async () =>
          await video.evaluate((v: HTMLVideoElement) => v.currentTime),
        { timeout: 3_000 },
      )
      .toBe(0);
    await expect(page.getByText(/Resume from/)).toHaveCount(0);
  });

  // ────────────────────────────────────────────────────────────────────
  test("skip (queue): prev/next buttons visible; saveNow persists before skip", async ({
    page,
  }) => {
    await setupPage(page);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "All videos" }),
    ).toBeVisible();

    // Click the FIRST playable PosterCard in the All files grid. The grid's
    // queue is `data.videos.map(v => v.id)` (browse.tsx) — the first card is
    // always index 0, so Next is guaranteed enabled (4+ videos seeded).
    // Don't pick a specific named card (alphabetical / insertion order
    // varies; a named pick might land at the queue's tail).
    // `concert.mp4` is excluded: the e2e fixture seeds it with MPEG-2 bytes
    // (crates/api/src/e2e.rs `gd-concert` gotcha), which no browser can
    // decode — waitForVideoMetadata would never see loadedmetadata. The
    // first non-concert card still can't be the queue's tail (3 other
    // unique videos follow it in some order), so Next stays enabled.
    const firstCard = page
      .locator("#all-videos")
      .getByRole("link", { name: /^Play (?!concert\.mp4$)/ })
      .first();
    const firstHref = await firstCard.getAttribute("href");
    expect(firstHref).toBeTruthy();
    const startVideoId = firstHref!.split("/").pop()!;
    const startAriaLabel = await firstCard.getAttribute("aria-label");
    expect(startAriaLabel).toBeTruthy();

    await clickCardLink(page, startAriaLabel!);
    await expect(page).toHaveURL(
      new RegExp(`/watch/${encodeURIComponent(startVideoId)}$`),
    );
    await waitForVideoMetadata(page);

    // Queue navigation controls render (queue state present).
    const nextBtn = page.getByRole("button", { name: "Next video" });
    await expect(nextBtn).toBeVisible();
    // If this assertion fails, vacation.mp4 is the last item in the browse
    // grid's queue — adjust the test to pick a different card.
    await expect(nextBtn).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Previous video" }),
    ).toBeVisible();

    // Drive playback position to something saveNow can persist.
    const video = page.locator("video");
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 50;
    });

    // Click "Next video" — handleNext calls tracking.saveNow() before
    // queue.goToNext(), so the IDB write lands before unmount.
    await page.getByRole("button", { name: "Next video" }).click();

    // URL changed to a different video id.
    await expect(page).toHaveURL((url) => {
      return !url.pathname.endsWith(`/watch/${encodeURIComponent(startVideoId)}`);
    });

    // The new watch page mounted.
    await expect(page.locator("video")).toBeVisible();

    // The previous video's progress was saved to IndexedDB.
    const saved = await readProgressEntry(page, startVideoId);
    expect(saved).toBeTruthy();
    expect(saved!.videoId).toBe(startVideoId);
    expect(saved!.positionSeconds).toBeGreaterThanOrEqual(45);
    expect(saved!.completed).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────
  test("subtitle display: sidecar .srt renders <track>; toggle shows mode=showing", async ({
    page,
  }) => {
    await setupPage(page);

    const vacation = gdByName("vacation.mp4");
    await page.goto(`/watch/${encodeURIComponent(vacation.id)}`);
    await waitForVideoMetadata(page);
    const video = page.locator("video");

    // Video detail API reports one English subtitle track.
    const detail = await getVideoDetail(page, vacation.id);
    expect(detail.subtitle_tracks.length).toBe(1);
    const track = detail.subtitle_tracks[0];
    expect(track.language).toBe("en");
    expect(track.format).toBe("srt");

    // <track kind="subtitles"> is rendered.
    await expect(video.locator("track[kind='subtitles']")).toHaveCount(1);

    // Settings gear is visible; the Subtitles section lives inside it
    // (grouped settings menu, task 013).
    const settingsBtn = page.getByRole("button", { name: "Settings" });
    await expect(settingsBtn).toBeVisible();

    // Initially all tracks are "hidden" (Off is selected by default).
    const initialMode = await video.evaluate((v: HTMLVideoElement) =>
      Array.from(v.textTracks).map((t) => ({ language: t.language, mode: t.mode })),
    );
    expect(initialMode.find((m) => m.language === "en")?.mode).toBe(
      "hidden",
    );

    // Open the menu + select English.
    await settingsBtn.click();
    await page.getByRole("menuitemradio", { name: "en" }).click();

    // mode flips to "showing".
    await expect
      .poll(
        async () =>
          await video.evaluate((v: HTMLVideoElement) =>
            Array.from(v.textTracks).find((t) => t.language === "en")?.mode,
          ),
        { timeout: 3_000 },
      )
      .toBe("showing");

    // Subtitle content endpoint serves VTT (with .srt→.vtt conversion).
    const subRes = await page.request.get(
      `/api/videos/${encodeURIComponent(vacation.id)}/subtitles/${encodeURIComponent(track.id)}`,
    );
    expect(subRes.status()).toBe(200);
    expect(subRes.headers()["content-type"]).toBe("text/vtt");
    const subBody = await subRes.text();
    expect(subBody.startsWith("WEBVTT")).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  test("progress persistence: seeked + ended events write to IndexedDB", async ({
    page,
  }) => {
    await setupPage(page);

    const vacation = gdByName("vacation.mp4");
    await page.goto(`/watch/${encodeURIComponent(vacation.id)}`);
    await waitForVideoMetadata(page);
    const video = page.locator("video");

    // Initial state: no entry yet.
    expect(await readProgressEntry(page, vacation.id)).toBeNull();

    // Seek to 60s — the seeked event triggers doSave().
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 60;
    });

    // IndexedDB write lands shortly after.
    await expect
      .poll(
        async () => (await readProgressEntry(page, vacation.id))?.positionSeconds,
        { timeout: 3_000 },
      )
      .toBeCloseTo(60, 0);

    const entry = await readProgressEntry(page, vacation.id);
    expect(entry).toBeTruthy();
    expect(entry!.videoId).toBe(vacation.id);
    expect(entry!.completed).toBe(false);
    expect(entry!.videoName).toBe(vacation.name);
    expect(entry!.videoDurationMs).toBe(120_000);
    expect(entry!.provider).toBe("google_drive");

    // Drive currentTime past 95% + dispatch 'ended' → completed = true.
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 115;
      v.dispatchEvent(new Event("ended"));
    });

    await expect
      .poll(
        async () => (await readProgressEntry(page, vacation.id))?.completed,
        { timeout: 3_000 },
      )
      .toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  test("continue-watching shelf: seeded entry produces shelf + card resumes", async ({
    page,
  }) => {
    await setupPage(page);

    const vacation = gdByName("vacation.mp4");
    // Need to be on origin to write IndexedDB.
    await page.goto("/");
    await seedProgressEntry(page, {
      videoId: vacation.id,
      positionSeconds: 60,
      durationSeconds: 120,
      completed: false,
      updatedAt: Date.now(),
      videoName: vacation.name,
      videoDurationMs: 120_000,
      thumbnailStatus: "ready",
      height: 1080,
      provider: "google_drive",
    });

    // Reload to trigger the shelf's TanStack Query fetch.
    await page.reload();

    // Continue Watching shelf appears.
    await expect(
      page.getByRole("heading", { name: "Continue watching & listening" }),
    ).toBeVisible();

    // Card has a progressbar at 50% (60/120).
    const progressBar = page.getByRole("progressbar", {
      name: "Watch progress",
    });
    await expect(progressBar).toBeVisible();
    await expect(progressBar).toHaveAttribute("aria-valuenow", "50");

    // Card link is labeled "Resume <name>".
    const cardLink = page.getByRole("link", {
      name: `Resume ${vacation.name}`,
    });
    await expect(cardLink).toBeVisible();

    // Click resumes into the watch page.
    await clickCardLink(page, `Resume ${vacation.name}`);
    await expect(page).toHaveURL(
      new RegExp(`/watch/${encodeURIComponent(vacation.id)}$`),
    );

    // Video seeked to 60s on load.
    await waitForVideoMetadata(page);
    const video = page.locator("video");
    await expect
      .poll(
        async () =>
          await video.evaluate((v: HTMLVideoElement) => v.currentTime),
        { timeout: 3_000 },
      )
      .toBeCloseTo(60, 0);
  });

  // ────────────────────────────────────────────────────────────────────
  test("backend progress contract: POST/GET /progress works (PRD AC #220)", async ({
    page,
  }) => {
    // The frontend uses IndexedDB-only persistence (see sub-test 6); this
    // sub-test verifies the dormant server endpoints still work as a
    // contract — satisfying PRD AC #220 + locking the API for any future
    // client. Pure API; no UI navigation.
    await setupPage(page);
    const csrf = await getCsrfToken(page);

    const vacation = gdByName("vacation.mp4");

    // Initial state: no progress row.
    expect(await getProgress(page, vacation.id)).toBeNull();

    // POST a position.
    const saved = await postProgress(
      page,
      vacation.id,
      { position_seconds: 30, duration_seconds: 120 },
      csrf,
    );
    expect(saved.position_seconds).toBe(30);
    expect(saved.duration_seconds).toBe(120);
    expect(saved.completed).toBe(false);
    expect(saved.updated_at).toBeTruthy();

    // GET returns the saved state.
    const fetched = await getProgress(page, vacation.id);
    expect(fetched?.position_seconds).toBe(30);
    expect(fetched?.completed).toBe(false);

    // The in_progress filter includes this video.
    const inProgressRes = await page.request.get(
      "/api/videos?in_progress=true",
    );
    expect(inProgressRes.ok()).toBeTruthy();
    const inProgress = await inProgressRes.json();
    expect(
      inProgress.videos.some((v: VideoSummary) => v.id === vacation.id),
    ).toBe(true);

    // Mark completed.
    await postProgress(
      page,
      vacation.id,
      {
        position_seconds: 120,
        duration_seconds: 120,
        completed: true,
      },
      csrf,
    );

    // Now excluded from in_progress.
    const completedRes = await page.request.get(
      "/api/videos?in_progress=true",
    );
    const completedList = await completedRes.json();
    expect(
      completedList.videos.some((v: VideoSummary) => v.id === vacation.id),
    ).toBe(false);
  });
});
