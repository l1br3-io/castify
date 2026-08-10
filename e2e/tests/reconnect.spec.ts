// E2e: disconnect → reconnect is lossless.
//
// Proves the core acceptance criterion of the effort (Checkpoint B + D):
//   connect → start watching → disconnect → reconnect the SAME account
//   preserves the connection id, every video UUID, the resume position,
//   and the `/watch/{id}` URL — no "Video not found."
//
// The e2e seed endpoint mirrors the OAuth callback's revive branching
// (revive soft-deleted row in place instead of delete + re-create), so
// re-seeding the same `(provider, account_email)` returns the SAME
// connection id with the SAME video rows — which is the whole point.
//
// Visibility while disconnected is checked via the API (not a watch-page
// navigation) so the watch page's detail-404 → clearProgress heal (Task 6)
// is NOT triggered — letting us also assert the resume entry survives the
// round-trip in IndexedDB.

import { test, expect } from "@playwright/test";

import {
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  getVideos,
  readProgressEntry,
  seedAndScan,
  seedConnection,
  seedProgressEntry,
  triggerScan,
  waitForScanComplete,
} from "./helpers";

test.describe("Lossless reconnect (e2e mock)", () => {
  test("disconnect → reconnect preserves connection id, video UUIDs, and resume position", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);

    // Clean slate: disconnect any leftover active connections from prior
    // specs. Without this, a Google Drive connection left active by an
    // earlier spec would dedup with ours — the unified list's vacation.mp4
    // might carry the OTHER connection's UUID, and disconnecting ours
    // wouldn't hide it (the other copy is still active). Clearing first
    // guarantees every video in the catalog belongs to our connection.
    const existing = await page.request.get("/api/connections");
    for (const conn of await existing.json()) {
      await disconnect(page, conn.id, csrf);
    }

    // ── 1. Connect + scan Google Drive ─────────────────────────────
    const connId = await seedAndScan(
      page,
      "google_drive",
      "reconnect@example.com",
      csrf,
    );

    const videos = await getVideos(page);
    const vacation = videos.videos.find((v) => v.name === "vacation.mp4");
    expect(vacation, "vacation.mp4 present after initial scan").toBeTruthy();
    const videoId = vacation!.id;

    // ── 2. Start watching; seed a resume position in IndexedDB ─────
    await page.goto(`/watch/${videoId}`);
    await expect(
      page.getByRole("heading", { name: "vacation.mp4" }),
    ).toBeVisible({ timeout: 10_000 });

    await seedProgressEntry(page, {
      videoId,
      positionSeconds: 60,
      durationSeconds: 120,
      completed: false,
      updatedAt: Date.now(),
      videoName: "vacation.mp4",
      videoDurationMs: 120_000,
      thumbnailStatus: "cached",
      height: 1080,
      provider: "google_drive",
    });

    // ── 3. Disconnect → video is hidden (FR-3.2) ───────────────────
    await disconnect(page, connId, csrf);

    // Visibility check via API (not watch-page navigation) so the 404
    // heal doesn't wipe the resume entry we just seeded.
    const hidden = await page.request.get(`/api/videos/${videoId}`);
    expect(hidden.status()).toBe(404);

    // ── 4. Reconnect (same account) → revives the soft-deleted row ─
    const revivedId = await seedConnection(
      page,
      "google_drive",
      "reconnect@example.com",
      csrf,
    );
    expect(revivedId).toBe(connId); // FR-2.2: connection id unchanged

    await triggerScan(page, revivedId, csrf);
    await waitForScanComplete(page, revivedId);

    // ── 5. Same video UUID reappears (identity preserved) ──────────
    const revived = await getVideos(page);
    const vacationAfter = revived.videos.find((v) => v.name === "vacation.mp4");
    expect(vacationAfter, "vacation.mp4 reappears after reconnect").toBeTruthy();
    expect(vacationAfter!.id).toBe(videoId); // FR-2.2: UUID preserved

    // ── 6. Resume position survived (no 404 visit → IDB untouched) ─
    const saved = await readProgressEntry(page, videoId);
    expect(saved).not.toBeNull();
    expect(saved!.positionSeconds).toBe(60);

    // ── 7. Watch URL works again — no "Video not found" ───────────
    await page.goto(`/watch/${videoId}`);
    await expect(
      page.getByRole("heading", { name: "vacation.mp4" }),
    ).toBeVisible({ timeout: 10_000 });
    expect(page.getByText("Video not found")).toHaveCount(0);
  });
});
