// E2e: S3-compatible storage against real MinIO (s3-compatible-storage
// task 009).
//
// The e2e compose override boots MinIO in the castify service's network
// namespace, seeded from `e2e/fixtures/bucket/` (an mp4, an mkv, a sidecar
// .srt, a .txt). One loopback endpoint — `http://localhost:9000` — serves
// the API container (exercising the production SSRF allowance for loopback
// http / local MinIO) and the Playwright browser (the compose port publish
// forwards the shared namespace's :9000 to the host).
//
// Test 1 — connect → scan → browse → play, the direct path:
//   * connect through the real schema-driven credentials form
//   * scan finds the seeded media set (2 videos, 1 sidecar, 1 document)
//   * browse grid + folder contents list the items
//   * playback runs on the presigned MinIO URL and the <video> progresses
//   * NETWORK ASSERTION: every video/* byte response came from MinIO
//     (localhost:9000) — the castify origin (localhost:8427) served zero
//     video bytes
//
// Test 2 — proxy fallback with presigning forced off (the e2e-only
// `POST /api/__e2e/s3-presign` switch): stream-url flips to the proxy
// strategy, playback + seeking run through `/api/videos/{id}/stream`
// (Range → 206 against MinIO via open_stream).

import { test, expect, type Page, type Response } from "@playwright/test";
import {
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  getStreamUrl,
  getVideoDetail,
  getVideos,
  type VideoSummary,
} from "./helpers";

const MINIO_ENDPOINT = "http://localhost:9000";
const MINIO_ROOT_USER = "castify-e2e";
const MINIO_ROOT_PASSWORD = "castify-e2e-secret";
const BUCKET = "media";
// The seed's completion marker: `mc anonymous set download` runs LAST, so
// an anonymous ranged GET on this object succeeding means MinIO is up AND
// the whole fixture set landed.
const SEED_MARKER_KEY = `${BUCKET}/Movies/holiday.mp4`;

/** Build explicit Cookie + X-CSRF-Token headers for a mutation (helpers'
 * authHeaders is private; same double-submit pattern). */
async function csrfHeaders(
  page: Page,
  csrf: string,
): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const parts = cookies
    .filter((c) => c.name !== "castify_csrf")
    .map((c) => `${c.name}=${c.value}`);
  parts.push(`castify_csrf=${csrf}`);
  return { Cookie: parts.join("; "), "X-CSRF-Token": csrf };
}

/** Flip the e2e-only S3 presign switch (test-only route). */
async function setS3Presign(
  page: Page,
  csrf: string,
  enabled: boolean,
): Promise<void> {
  const res = await page.request.post("/api/__e2e/s3-presign", {
    headers: await csrfHeaders(page, csrf),
    data: { enabled },
  });
  expect(res.status()).toBe(204);
}

/** Wait until MinIO is healthy and the seed marker object is fetchable. */
async function waitForMinioSeeded(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await page.request.get(`${MINIO_ENDPOINT}/minio/health/live`)
        ).status(),
      { timeout: 60_000, message: "MinIO health endpoint" },
    )
    .toBe(200);

  await expect
    .poll(
      async () => {
        const res = await page.request.get(
          `${MINIO_ENDPOINT}/${SEED_MARKER_KEY}`,
          { headers: { Range: "bytes=0-0" } },
        );
        return res.status();
      },
      { timeout: 60_000, message: "seeded marker object (anonymous GET)" },
    )
    .toBe(206);
}

interface ConnectionDto {
  id: string;
  provider: string;
  scan_status: string;
}

/** The stack's s3 connection, once connected. */
async function getS3Connection(page: Page): Promise<ConnectionDto | null> {
  const res = await page.request.get("/api/connections");
  expect(res.ok()).toBeTruthy();
  const list = (await res.json()) as ConnectionDto[];
  return list.find((c) => c.provider === "s3") ?? null;
}

/**
 * Connect via the credentials form on /connections, then wait for the
 * initial scan to surface the seeded media. The seed's `mc cp` can race
 * the first scan (verify only needs the bucket to exist), so an empty
 * result triggers rescans — upserts make rescan idempotent.
 */
async function connectAndScan(page: Page): Promise<string> {
  await page.goto("/connections");
  const card = page.locator("article", {
    has: page.getByRole("heading", { name: "S3-Compatible Storage" }),
  });
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "Connect" }).click();
  await card.locator("#cred-s3-endpoint").fill(MINIO_ENDPOINT);
  await card.locator("#cred-s3-region").fill("us-east-1");
  await card.locator("#cred-s3-bucket").fill(BUCKET);
  await card.locator("#cred-s3-access_key_id").fill(MINIO_ROOT_USER);
  await card
    .locator("#cred-s3-secret_access_key")
    .fill(MINIO_ROOT_PASSWORD);

  await card.getByRole("button", { name: "Connect" }).click();

  // Card flips to its connected state once the verify-persist round-trip
  // lands (verify = HeadBucket + one list page against real MinIO).
  await expect(card.getByText("Not connected")).toHaveCount(0, {
    timeout: 15_000,
  });

  // SC6 where the secrets were entered: no input may still hold them
  // (the form clears on success), and the connections payload — the API
  // artifact the rest of the UI consumes — must carry none either.
  // (innerText can never see input values, so assert on the DOM itself.)
  const secretLingers = await page.locator("input").evaluateAll(
    (els, secret) =>
      els.some((el) => (el as HTMLInputElement).value === secret),
    MINIO_ROOT_PASSWORD,
  );
  expect(secretLingers).toBe(false);
  const connsBody = await (
    await page.request.get("/api/connections")
  ).text();
  expect(connsBody).not.toContain(MINIO_ROOT_PASSWORD);
  expect(connsBody).not.toContain(MINIO_ROOT_USER);

  // Wait for the row + a scan that found the media set.
  const csrf = await getCsrfToken(page);
  for (let attempt = 0; attempt < 6; attempt++) {
    const conn = await getS3Connection(page);
    expect(conn, "s3 connection row appears after form submit").toBeTruthy();
    // Poll scan status to idle.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(
            `/api/connections/${conn!.id}/scan`,
          );
          expect(res.ok()).toBeTruthy();
          return (await res.json()) as {
            status: string;
            videos_found: number;
            error_message: string | null;
          };
        },
        { timeout: 20_000 },
      )
      .toMatchObject({ status: "idle" });

    const found = await s3Videos(page);
    if (found.length >= 2) return conn!.id;

    // Seed raced the scan — rescan and retry.
    const rescan = await page.request.post(
      `/api/connections/${conn!.id}/scan`,
      { headers: await csrfHeaders(page, csrf) },
    );
    expect([202, 409]).toContain(rescan.status());
    await page.waitForTimeout(1_000);
  }
  throw new Error("s3 scan never found the seeded media set");
}

/** Videos from the s3 connection. */
async function s3Videos(page: Page): Promise<VideoSummary[]> {
  const res = await page.request.get(
    "/api/videos?provider=s3&limit=100",
  );
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { total: number; videos: VideoSummary[] };
  return body.videos;
}

/** Wait for the watch page's <video> to load metadata (see play.spec.ts). */
async function waitForVideoMetadata(page: Page): Promise<void> {
  const video = page.locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(async () => await video.getAttribute("src"), { timeout: 15_000 })
    .not.toBeNull();
  await expect
    .poll(
      async () =>
        await video.evaluate((v: HTMLVideoElement) => v.readyState),
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(1);
}

/** Muted play + wait for playback to advance past `seconds`. */
async function playAndProgress(page: Page, seconds = 0.5): Promise<void> {
  const video = page.locator("video");
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    void v.play();
  });
  await expect
    .poll(
      async () =>
        await video.evaluate((v: HTMLVideoElement) => v.currentTime),
      { timeout: 10_000, message: "video currentTime progresses" },
    )
    .toBeGreaterThanOrEqual(seconds);
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe("S3-compatible storage (MinIO, task 009)", () => {
  test.setTimeout(120_000);

  test("connect via credentials form → scan → browse → play direct from MinIO", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    await waitForMinioSeeded(page);

    // A leaked s3 connection defeats Playwright's retry (a re-run of
    // connectAndScan meets an already-connected card) and contaminates the
    // later specs' full-video-list assertions — clean up even on failure.
    try {
      await connectAndScan(page);

      // ── Catalog: the whole media set ─────────────────────────────────
      const videos = await s3Videos(page);
      const names = videos.map((v) => v.name).sort();
      expect(names).toEqual(["holiday.mp4", "teaser.mkv"]);
      const holiday = videos.find((v) => v.name === "holiday.mp4")!;
      expect(holiday.provider).toBe("s3");

      // Sidecar pairing: holiday.en.srt → one English srt track.
      const detail = await getVideoDetail(page, holiday.id);
      expect(detail.mime_type).toBe("video/mp4");
      expect(detail.subtitle_tracks.length).toBe(1);
      expect(detail.subtitle_tracks[0].language).toBe("en");
      expect(detail.subtitle_tracks[0].format).toBe("srt");

      // The .txt lands as a Document file in /Docs (folder contents API).
      const docs = await page.request.get(
        "/api/folders/contents?path=/Docs&provider=s3",
      );
      expect(docs.ok()).toBeTruthy();
      const docsBody = (await docs.json()) as {
        entries: { kind: string; name: string }[];
      };
      expect(
        docsBody.entries.map((e) => e.name),
        `docs entries: ${JSON.stringify(docsBody.entries)}`,
      ).toContain("notes.txt");
      expect(
        docsBody.entries.find((e) => e.name === "notes.txt")!.kind,
      ).toBe("document");

      // Subtitle content serves through the proxy (S3 open_stream default
      // fetch path — the credential-flow fix beyond stream-url).
      const subRes = await page.request.get(
        `/api/videos/${encodeURIComponent(holiday.id)}/subtitles/${encodeURIComponent(detail.subtitle_tracks[0].id)}`,
      );
      expect(subRes.status()).toBe(200);
      expect(subRes.headers()["content-type"]).toBe("text/vtt");
      expect((await subRes.text()).startsWith("WEBVTT")).toBe(true);

      // ── Browse UI ────────────────────────────────────────────────────
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "All Videos" }),
      ).toBeVisible();
      await expect(
        page.locator("#all-videos").getByRole("link", {
          name: `Play ${holiday.name}`,
        }),
      ).toBeVisible();

      // ── Play: the direct, presigned path ─────────────────────────────
      // Capture every video/* byte response before navigation.
      const mediaResponses: { url: string; origin: string }[] = [];
      page.on("response", (res: Response) => {
        const type = res.headers()["content-type"] ?? "";
        if (type.startsWith("video/")) {
          mediaResponses.push({
            url: res.url(),
            origin: new URL(res.url()).origin,
          });
        }
      });

      await page.goto(`/watch/${encodeURIComponent(holiday.id)}`);
      await waitForVideoMetadata(page);

      // stream-url resolved to a presigned direct URL on the MinIO origin.
      const streamUrl = await getStreamUrl(page, holiday.id);
      expect(streamUrl.strategy).toBe("direct");
      expect(streamUrl.url).toContain("X-Amz-Signature");
      expect(streamUrl.expires_at).toBeTruthy();
      const minioOrigin = new URL(MINIO_ENDPOINT).origin;
      expect(streamUrl.url.startsWith(`${minioOrigin}/media/Movies/`)).toBe(
        true,
      );

      // The <video> element streams straight from MinIO.
      const video = page.locator("video");
      const src = await video.getAttribute("src");
      expect(src!.startsWith(`${minioOrigin}/media/`)).toBe(true);
      expect(src!).toContain("X-Amz-Signature");

      // Real playback + progression on the direct URL.
      await playAndProgress(page);

      // Seek (Range request straight to MinIO).
      await video.evaluate((v: HTMLVideoElement) => {
        v.currentTime = 4;
      });
      await expect
        .poll(
          async () =>
            await video.evaluate((v: HTMLVideoElement) => v.currentTime),
          { timeout: 5_000 },
        )
        .toBeCloseTo(4, 0);

      // MinIO honors ranges on the presigned URL (explicit contract check).
      const ranged = await page.request.get(src!, {
        headers: { Range: "bytes=0-3" },
      });
      expect(ranged.status()).toBe(206);
      expect(ranged.headers()["content-range"]).toMatch(
        /^bytes 0-3\/\d+$/,
      );
      expect((await ranged.body()).length).toBe(4);

      // ── THE network assertion: backend served zero video bytes ──────
      expect(mediaResponses.length).toBeGreaterThan(0);
      expect(
        mediaResponses.map((m) => m.origin),
        `all video bytes came from MinIO: ${JSON.stringify(mediaResponses)}`,
      ).toEqual(expect.arrayContaining([minioOrigin]));
      const castifyOrigin = new URL(
        process.env.CASTIFY_E2E_BASE_URL ?? "http://localhost:8427",
      ).origin;
      const throughBackend = mediaResponses.filter(
        (m) => m.origin === castifyOrigin,
      );
      expect(
        throughBackend,
        `no video bytes may transit the castify api: ${JSON.stringify(throughBackend)}`,
      ).toEqual([]);

      // ── Secrets never render ─────────────────────────────────────────
      // (input-value coverage lives in connectAndScan, where the form
      // lived; here the serialized page itself must not contain the
      // secret. NB: the access key ID intentionally appears inside the
      // presigned URL's X-Amz-Credential scope — SigV4 embeds the key ID
      // in every presigned URL; it identifies, it does not authenticate.)
      const html = await page.content();
      expect(html).not.toContain(MINIO_ROOT_PASSWORD);
    } finally {
      const leaked = await getS3Connection(page).catch(() => null);
      if (leaked) {
        const csrf = await getCsrfToken(page).catch(() => null);
        if (csrf) {
          await disconnect(page, leaked.id, csrf).catch(() => {});
        }
      }
    }
  });

  test("proxy fallback: presigning forced off → proxy playback + Range/206 seeking", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    await waitForMinioSeeded(page);

    const existing = await getS3Connection(page);
    const connId = existing ? existing.id : await connectAndScan(page);
    const videos = await s3Videos(page);
    const holiday = videos.find((v) => v.name === "holiday.mp4")!;
    const holidayId = holiday.id;

    const csrf = await getCsrfToken(page);
    try {
      await setS3Presign(page, csrf, false);

      // stream-url flips to the proxy strategy + the /stream endpoint.
      const streamUrl = await getStreamUrl(page, holidayId);
      expect(streamUrl.strategy).toBe("proxy");
      expect(streamUrl.url).toBe(
        `/api/videos/${encodeURIComponent(holidayId)}/stream`,
      );

      // The proxy serves MinIO bytes with Range → 206.
      const ranged = await page.request.get(streamUrl.url, {
        headers: { Range: "bytes=0-3" },
      });
      expect(ranged.status()).toBe(206);
      expect(ranged.headers()["content-type"]).toContain("video/mp4");
      expect(ranged.headers()["content-range"]).toMatch(
        /^bytes 0-3\/\d+$/,
      );
      expect((await ranged.body()).length).toBe(4);

      // Full proxy playback in the browser + seek through the proxy.
      await page.goto(`/watch/${encodeURIComponent(holidayId)}`);
      await waitForVideoMetadata(page);
      const video = page.locator("video");
      expect(await video.getAttribute("src")).toBe(streamUrl.url);

      await playAndProgress(page);

      await video.evaluate((v: HTMLVideoElement) => {
        v.currentTime = 4;
      });
      await expect
        .poll(
          async () =>
            await video.evaluate((v: HTMLVideoElement) => v.currentTime),
          { timeout: 5_000 },
        )
        .toBeCloseTo(4, 0);
    } finally {
      // Process-global switch + connection cleanup — even on failure, so
      // the later specs see the production presign posture.
      await setS3Presign(page, csrf, true).catch(() => {});
      await disconnect(page, connId, csrf).catch(() => {});
    }
  });
});
