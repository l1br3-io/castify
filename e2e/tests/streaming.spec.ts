// E2e direct-streaming test (M3 T12).
//
// Verifies `GET /api/videos/{id}/stream-url` returns the right strategy per
// provider and that the mock CDN endpoint serves bytes when the strategy is
// "direct". The frontend's `<video src>` is set from this response — the
// integration tests + watch.test.tsx cover the src-swap + retry logic, so
// here we focus on the contract that crosses the HTTP boundary:
//
//   - OneDrive + Dropbox → strategy "direct", URL points at the mock CDN
//   - Google Drive       → strategy "proxy",  URL points at /stream
//   - Mock CDN route     → serves video/mp4 bytes with Range support
//
// Test flow:
//   1. Authenticate
//   2. Seed + scan all three providers (Drive, Dropbox, OneDrive)
//   3. For each provider, find one of its videos and verify the strategy
//   4. Verify the mock CDN serves actual bytes when called directly
//   5. Cleanup

import { test, expect } from "@playwright/test";
import {
  ensureAuthenticated,
  getCsrfToken,
  seedAndScan,
  disconnect,
  getVideos,
} from "./helpers";

test.describe("Direct CDN streaming (M3 T12)", () => {
  test("stream-url returns direct for OneDrive/Dropbox and proxy for Drive", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);

    const gdConn = await seedAndScan(
      page,
      "google_drive",
      "gd-stream@example.com",
      csrf,
    );
    const dbConn = await seedAndScan(
      page,
      "dropbox",
      "db-stream@example.com",
      csrf,
    );
    const odConn = await seedAndScan(
      page,
      "onedrive",
      "od-stream@example.com",
      csrf,
    );

    const data = await getVideos(page);
    // 5 unique videos: 3 Drive (incl. shared-doc) + 1 Dropbox non-shared +
    // 1 OneDrive. shared-doc dedupes across Drive + Dropbox.
    expect(data.total).toBe(5);

    // Group one representative video per provider.
    const byProvider: Record<string, string> = {};
    for (const v of data.videos) {
      if (!(v.provider in byProvider)) byProvider[v.provider] = v.id;
    }
    expect(Object.keys(byProvider).sort()).toEqual(
      ["dropbox", "google_drive", "onedrive"].sort(),
    );

    // ── OneDrive + Dropbox → strategy: direct ───────────────────────
    for (const provider of ["dropbox", "onedrive"]) {
      const id = byProvider[provider];
      const res = await page.request.get(
        `/api/videos/${encodeURIComponent(id)}/stream-url`,
      );
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.strategy).toBe("direct");
      // Mock CDN URL points at the e2e-only route (relative path).
      expect(body.url).toContain("/api/__e2e/mock-cdn/");
    }

    // ── Google Drive → strategy: proxy ──────────────────────────────
    const driveId = byProvider["google_drive"];
    const driveRes = await page.request.get(
      `/api/videos/${encodeURIComponent(driveId)}/stream-url`,
    );
    expect(driveRes.status()).toBe(200);
    const driveBody = await driveRes.json();
    expect(driveBody.strategy).toBe("proxy");
    expect(driveBody.url).toBe(
      `/api/videos/${encodeURIComponent(driveId)}/stream`,
    );

    // ── Mock CDN route serves bytes with Range support ──────────────
    // The browser's `<video>` would hit this URL directly for the direct
    // strategy; verify the route is wired and serves video/mp4 bytes.
    const onedriveId = byProvider["onedrive"];
    const streamUrlRes = await page.request.get(
      `/api/videos/${encodeURIComponent(onedriveId)}/stream-url`,
    );
    const streamUrlBody = await streamUrlRes.json();
    const cdnUrl = streamUrlBody.url as string;

    // Full content fetch.
    const cdnFull = await page.request.get(cdnUrl);
    expect(cdnFull.status()).toBe(200);
    expect(cdnFull.headers()["content-type"]).toBe("video/mp4");
    const fullBody = await cdnFull.body();
    expect(fullBody.length).toBeGreaterThan(0);

    // Range fetch → 206 partial content.
    const cdnRange = await page.request.get(cdnUrl, {
      headers: { Range: "bytes=0-3" },
    });
    expect(cdnRange.status()).toBe(206);
    expect(cdnRange.headers()["content-range"]).toMatch(/^bytes 0-3\/\d+$/);
    const rangeBody = await cdnRange.body();
    expect(rangeBody.length).toBe(4);

    // ── Cleanup ─────────────────────────────────────────────────────
    await disconnect(page, gdConn, csrf);
    await disconnect(page, dbConn, csrf);
    await disconnect(page, odConn, csrf);
  });
});
