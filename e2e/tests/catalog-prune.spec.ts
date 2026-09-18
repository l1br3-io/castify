// E2e: catalog prune — reconcile deletions on rescan (catalog-prune
// task 008).
//
// Against real MinIO: connect → scan → delete an object at the provider
// (via the e2e-only s3-delete hook) → rescan → still present (tombstoned,
// grace 2) → rescan → gone from the API + browse, with the removal toast.
// A second test flips the e2e-only prune-grace override to 1 and proves
// `immediate` semantics: one rescan removes.
//
// Both tests restore the deleted object and disconnect in `finally` —
// the bucket must end exactly as the seeder left it for the later specs
// in the same run (the suite is serial, one worker).

import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  triggerScan,
  waitForScanComplete,
} from "./helpers";

const MINIO_ENDPOINT = "http://localhost:9000";
const MINIO_ROOT_USER = "castify-e2e";
const MINIO_ROOT_PASSWORD = "castify-e2e-secret";
const BUCKET = "media";

/** Auth + CSRF headers for a mutation (helpers' authHeaders is private). */
async function authHeaders(
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

async function waitMinioLive(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await page.request.get(`${MINIO_ENDPOINT}/minio/health/live`)
        ).status(),
      { timeout: 60_000, message: "MinIO health endpoint" },
    )
    .toBe(200);
}

/** Connect the s3 bucket through the credentials API and wait out the
 * initial scan. Returns the connection id. */
async function connectS3AndScan(page: Page): Promise<string> {
  const csrf = await getCsrfToken(page);
  const res = await page.request.post("/api/connections/s3", {
    headers: await authHeaders(page, csrf),
    data: {
      endpoint: MINIO_ENDPOINT,
      region: "us-east-1",
      bucket: BUCKET,
      access_key_id: MINIO_ROOT_USER,
      secret_access_key: MINIO_ROOT_PASSWORD,
      prefix: null,
    },
  });
  expect(res.status()).toBe(201);
  const conn = (await res.json()) as { id: string };
  await waitForScanComplete(page, conn.id);
  return conn.id;
}

/** Videos of the s3 connection. */
async function s3VideoNames(page: Page): Promise<string[]> {
  const res = await page.request.get("/api/videos?provider=s3&limit=100");
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { videos: { name: string }[] };
  return body.videos.map((v) => v.name).sort();
}

async function scanStatus(
  page: Page,
  connectionId: string,
): Promise<{
  status: string;
  videos_found: number;
  completed_at: string | null;
  videos_pruned: number;
  files_pruned: number;
}> {
  const res = await page.request.get(`/api/connections/${connectionId}/scan`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as {
    status: string;
    videos_found: number;
    completed_at: string | null;
    videos_pruned: number;
    files_pruned: number;
  };
}

async function deleteObject(
  page: Page,
  csrf: string,
  connectionId: string,
  key: string,
): Promise<void> {
  const res = await page.request.post("/api/__e2e/s3-delete", {
    headers: await authHeaders(page, csrf),
    data: { connection_id: connectionId, key },
  });
  expect(res.status()).toBe(204);
}

/** Restore a fixture object byte-for-byte (seeder uploaded the same
 * files from e2e/fixtures/bucket). Resolved from this spec's location —
 * the process CWD is e2e/ under `just e2e`, not the repo root.
 * `mc cp` set a content type per extension; the restore must match or
 * the stream proxy serves octet-stream and breaks later specs. */
async function restoreObject(
  page: Page,
  csrf: string,
  connectionId: string,
  key: string,
): Promise<void> {
  const fixturePath = resolvePath(
    import.meta.dirname,
    "../fixtures/bucket",
    key,
  );
  const bodyBase64 = readFileSync(fixturePath).toString("base64");
  const contentType = key.endsWith(".mp4")
    ? "video/mp4"
    : key.endsWith(".mkv")
      ? "video/x-matroska"
      : "application/octet-stream";
  const res = await page.request.post("/api/__e2e/s3-put", {
    headers: await authHeaders(page, csrf),
    data: {
      connection_id: connectionId,
      key,
      body_base64: bodyBase64,
      content_type: contentType,
    },
  });
  expect(res.status()).toBe(204);
}

async function setPruneGrace(
  page: Page,
  csrf: string,
  scans: number | null,
): Promise<void> {
  const res = await page.request.post("/api/__e2e/prune-grace", {
    headers: await authHeaders(page, csrf),
    data: { scans },
  });
  expect(res.status()).toBe(204);
}

/** Trigger a rescan and wait for THIS one to finish. Two races to dodge:
 * the 202 can land before the spawned task writes `scanning` (a bare
 * idle-poll returns on the previous scan's state), and scan timestamps
 * have second granularity — a rescan in the same second as its
 * predecessor is indistinguishable by `completed_at`, so tick the clock
 * first. */
async function rescanAndAwait(
  page: Page,
  connectionId: string,
  csrf: string,
): Promise<void> {
  const before = await scanStatus(page, connectionId);
  await page.waitForTimeout(1_100);
  await triggerScan(page, connectionId, csrf);
  await expect
    .poll(
      async () => (await scanStatus(page, connectionId)).completed_at,
      { timeout: 20_000, message: "rescan completed_at advances" },
    )
    .not.toBe(before.completed_at);
  const after = await scanStatus(page, connectionId);
  if (after.status === "error") {
    throw new Error(`rescan failed: ${after.status}`);
  }
  await waitForScanComplete(page, connectionId);
}

test.describe("catalog prune (MinIO, task 008)", () => {
  test.setTimeout(120_000);

  test("grace 2: delete at provider → rescan (tombstoned) → rescan (gone + toast)", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    await waitMinioLive(page);

    let connId = "";
    const csrf = await getCsrfToken(page);
    try {
      connId = await connectS3AndScan(page);
      expect(await s3VideoNames(page)).toEqual(["holiday.mp4", "teaser.mkv"]);

      // The provider deletes teaser.mkv.
      await deleteObject(page, csrf, connId, "Movies/teaser.mkv");

      // Rescan 1: first miss tombstones — the row survives the grace
      // window (spec §5: tombstoned rows stay visible mid-grace).
      await rescanAndAwait(page, connId, csrf);
      expect(await s3VideoNames(page)).toEqual(["holiday.mp4", "teaser.mkv"]);
      expect((await scanStatus(page, connId)).videos_pruned).toBe(0);

      // Rescan 2 through the UI so the removal toast is asserted on the
      // real connections page (task 007's surface).
      await page.goto("/connections");
      const rescanButton = page.getByRole("button", { name: /rescan/i });
      await expect(rescanButton).toBeVisible();
      await rescanButton.click();
      await expect(page.getByText(/removed/)).toBeVisible({ timeout: 20_000 });
      await waitForScanComplete(page, connId);

      // Gone from the API…
      expect(await s3VideoNames(page)).toEqual(["holiday.mp4"]);
      expect((await scanStatus(page, connId)).videos_pruned).toBe(1);

      // …and from browse.
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "All videos" })).toBeVisible();
      await expect(page.locator("#all-videos")).toContainText("holiday.mp4");
      await expect(page.locator("#all-videos")).not.toContainText("teaser.mkv");
    } finally {
      // Fresh CSRF: the UI navigations above rotate the csrf cookie, and
      // a stale token would silently fail the restore + disconnect —
      // poisoning every later spec that expects the seeded bucket.
      const cleanupCsrf = await getCsrfToken(page).catch(() => null);
      if (connId && cleanupCsrf) {
        await restoreObject(page, cleanupCsrf, connId, "Movies/teaser.mkv").catch(
          () => {},
        );
        await disconnect(page, connId, cleanupCsrf).catch(() => {});
      }
    }
  });

  test("immediate mode (grace 1): one rescan removes", async ({ page }) => {
    await ensureAuthenticated(page);
    await waitMinioLive(page);

    let connId = "";
    const csrf = await getCsrfToken(page);
    try {
      connId = await connectS3AndScan(page);
      expect(await s3VideoNames(page)).toEqual(["holiday.mp4", "teaser.mkv"]);

      await setPruneGrace(page, csrf, 1);
      await deleteObject(page, csrf, connId, "Movies/holiday.mp4");

      // A single completed scan is the whole confirmation window here.
      await rescanAndAwait(page, connId, csrf);
      expect(await s3VideoNames(page)).toEqual(["teaser.mkv"]);
      expect((await scanStatus(page, connId)).videos_pruned).toBe(1);
    } finally {
      const cleanupCsrf = await getCsrfToken(page).catch(() => null);
      await setPruneGrace(page, cleanupCsrf ?? csrf, null).catch(() => {});
      if (connId && cleanupCsrf) {
        await restoreObject(page, cleanupCsrf, connId, "Movies/holiday.mp4").catch(
          () => {},
        );
        await disconnect(page, connId, cleanupCsrf).catch(() => {});
      }
    }
  });
});
