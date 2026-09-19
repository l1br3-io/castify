// Keyboard-only player proof (app-redesign task 015 / FR-4.6).
//
// Drives /watch/:id entirely by keyboard — no mouse events: K play-pause,
// slider arrows seek, ↑/↓ volume, M mute, C cycles subtitles, the Settings
// menu opens/navigates/confirms by keyboard (APG menu-button), and the
// shortcuts overlay opens via `?`. Ends with an axe scan of the paused,
// controls-visible watch page (zero serious/critical is the gate, shared
// with the other redesigned screens).
//
// Quality rungs: the e2e stack's mock fixtures are all h264/MP4 (proxy or
// direct strategy), so no transcode fixture exists and the Settings menu
// carries no Quality section here. The quality radio path (rung →
// onLevelChange → hls) is proven in player-controls.test.tsx.
//
// Headless/fullscreen caveat: the F case presses the shortcut and asserts
// only when the browser actually enters fullscreen — headless chromium may
// refuse the request without failing the run (documented graceful skip).

import { test, expect } from "@playwright/test";

import {
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  getVideos,
  scanAxe,
  seedAndScan,
  type VideoSummary,
} from "./helpers";

test("keyboard-only playback — transport, volume, subtitles, settings menu, axe", async ({
  page,
}) => {
  await ensureAuthenticated(page);
  const csrf = await getCsrfToken(page);
  const connId = await seedAndScan(
    page,
    "google_drive",
    "keyboard@example.com",
    csrf,
  );
  try {
    const { videos } = await getVideos(page);
    // vacation.mp4 carries the fixture's `.en.srt` sidecar (a subtitle
    // track), which the C-cycle and Settings-menu cases need.
    const target: VideoSummary =
      videos.find((v) => v.name === "vacation.mp4") ?? videos[0];

    await page.goto(`/watch/${encodeURIComponent(target.id)}`);
    const video = page.locator("video");
    await expect(video).toBeVisible();
    await expect
      .poll(async () => await video.getAttribute("src"), { timeout: 10_000 })
      .not.toBeNull();
    await expect
      .poll(
        async () => await video.evaluate((v) => v.readyState),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1);

    // ── K: play / pause ────────────────────────────────────────────────
    await page.keyboard.press("k");
    await expect
      .poll(async () => await video.evaluate((v) => v.paused))
      .toBe(false);
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await page.keyboard.press("k");
    await expect
      .poll(async () => await video.evaluate((v) => v.paused))
      .toBe(true);

    // ── Seek: focus the scrubber, arrow-keys step ±5s ──────────────────
    const seek = page.getByRole("slider", { name: "Seek" });
    await seek.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => await video.evaluate((v) => v.currentTime))
      .toBeGreaterThan(0);

    // ── Volume: global ↑/↓ steps 5%; M mutes ───────────────────────────
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(async () => await video.evaluate((v) => v.volume))
      .toBeLessThan(1);
    await page.keyboard.press("m");
    await expect
      .poll(async () => await video.evaluate((v) => v.muted))
      .toBe(true);
    await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();

    // ── Settings menu by keyboard: Enter opens, arrows navigate, Enter
    //    selects, Escape closes and restores focus to the gear ──────────
    const gear = page.getByRole("button", { name: "Settings" });
    await gear.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Settings" });
    await expect(menu).toBeVisible();
    // Focus moves to the first enabled item (APG).
    const firstItem = page.getByRole("menuitemradio", { name: "0.5×" });
    await expect(firstItem).toBeFocused();

    await page.keyboard.press("ArrowDown"); // 0.5× → 0.75×
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => await video.evaluate((v) => v.playbackRate))
      .toBeCloseTo(0.75);
    // Grouped settings: the menu stays open for further adjustments.
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(gear).toBeFocused();

    // ── C: cycle subtitles Off → en → (Off) ────────────────────────────
    await page.keyboard.press("c");
    await expect
      .poll(
        async () =>
          await video.evaluate(
            (v) =>
              Array.from(v.textTracks).find((t) => t.language === "en")
                ?.mode ?? "missing",
          ),
      )
      .toBe("showing");

    // ── ?: the shortcuts overlay opens and Escape closes it ────────────
    await page.keyboard.press("?");
    const overlay = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(overlay).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(overlay).not.toBeVisible();

    // ── F: fullscreen (headed chromium asserts; headless may refuse —
    //    documented graceful path, not a failure) ───────────────────────
    await test.step("F fullscreen", async () => {
      await page.keyboard.press("f");
      const entered = await page
        .evaluate(() => !!document.fullscreenElement)
        .catch(() => false);
      if (entered) {
        // Exit through the app's own binding: `f` toggles (exits when
        // fullscreenElement is set). Browser-native Escape exit works
        // headed only — headless Chromium enters fullscreen but never
        // surfaces the native Escape exit, so relying on it flakes.
        await page.keyboard.press("f");
        await expect
          .poll(async () => await page.evaluate(() => !!document.fullscreenElement))
          .toBe(false);
      }
      // else: environment refused fullscreen — accepted (see file comment).
    });

    // ── Axe: paused, controls visible (keyboard activity revealed them) ─
    if (!(await video.evaluate((v) => v.paused))) {
      await page.keyboard.press("k");
    }
    await page.keyboard.press("Shift"); // inert keypress → controls reveal
    await scanAxe(page, "watch-keyboard");
  } finally {
    await disconnect(page, connId, csrf);
  }
});
