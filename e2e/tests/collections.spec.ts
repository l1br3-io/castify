// E2e: library collections — the full user path (library-collections
// task 011).
//
// Against real MinIO: connect → upload classifiable objects (reusing
// fixture bytes — the classifier reads names/paths, not content) →
// rescan → suggestion panel in browse → accept → collection in the
// rail → detail renders. A second test dismisses a group, rescans, and
// proves the signature suppression holds.
//
// The "share a collection" describe (share-collections task 003) rides
// the same fixture: a three-episode show collection is shared from the
// detail header and from the grid kebab, and a recipient context must
// see exactly the collection's members in curation order — including
// after the source collection is deleted (snapshot semantics).
//
// All tests restore the bucket + disconnect in `finally` — the suite
// is serial (one worker) and later specs expect the seeded state.

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  triggerScan,
  waitForScanComplete,
} from "./helpers";

/** Open a recipient context — no session, no cookies, fresh IndexedDB
 *  (same pattern as sharing.spec.ts). */
async function recipientPage(
  browser: import("@playwright/test").Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

const MINIO_ENDPOINT = "http://localhost:9000";
const MINIO_ROOT_USER = "castify-e2e";
const MINIO_ROOT_PASSWORD = "castify-e2e-secret";
const BUCKET = "media";

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

/** Upload an object reusing fixture bytes — classification reads the
 * key, content is irrelevant. */
async function putObject(
  page: Page,
  csrf: string,
  connectionId: string,
  key: string,
): Promise<void> {
  const fixturePath = resolvePath(
    import.meta.dirname,
    "../fixtures/bucket/Movies/holiday.mp4",
  );
  const bodyBase64 = readFileSync(fixturePath).toString("base64");
  const res = await page.request.post("/api/__e2e/s3-put", {
    headers: await authHeaders(page, csrf),
    data: {
      connection_id: connectionId,
      key,
      body_base64: bodyBase64,
      content_type: "video/mp4",
    },
  });
  expect(res.status()).toBe(204);
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

/** Post-test cleanup that leaves the catalog truly pristine.
 *
 * A plain disconnect is NOT enough: `DELETE /api/connections/{id}` is a
 * soft-delete, and a later same-bucket connect *revives* the row
 * (stable `(endpoint, bucket)` account id) — which resurrects this
 * test's tombstoned video rows into later specs' listings. So the
 * objects are deleted, then a grace-1 rescan hard-prunes their rows,
 * then the grace override and connection are restored. */
async function cleanupConnection(
  page: Page,
  connId: string,
  keys: string[],
): Promise<void> {
  const csrf = await getCsrfToken(page).catch(() => null);
  if (!connId || !csrf) return;
  for (const key of keys) {
    await deleteObject(page, csrf, connId, key).catch(() => {});
  }
  await setPruneGrace(page, csrf, 1).catch(() => {});
  await rescanAndAwait(page, connId, csrf).catch(() => {});
  await setPruneGrace(page, csrf, null).catch(() => {});
  await disconnect(page, connId, csrf).catch(() => {});
}

type Suggestion = {
  id: string;
  kind: string;
  title: string;
  signature: string;
  member_count: number;
};

async function getSuggestions(page: Page): Promise<Suggestion[]> {
  const res = await page.request.get("/api/collections/suggestions");
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Suggestion[];
}

async function rescanAndAwait(
  page: Page,
  connectionId: string,
  csrf: string,
): Promise<void> {
  const status = async () => {
    const res = await page.request.get(
      `/api/connections/${connectionId}/scan`,
    );
    expect(res.ok()).toBeTruthy();
    return (await res.json()) as { completed_at: string | null; status: string };
  };
  const before = await status();
  await page.waitForTimeout(1_100);
  await triggerScan(page, connectionId, csrf);
  await expect
    .poll(async () => (await status()).completed_at, {
      timeout: 20_000,
      message: "rescan completed_at advances",
    })
    .not.toBe(before.completed_at);
  await waitForScanComplete(page, connectionId);
}

test.describe("library collections (MinIO, task 011)", () => {
  test.setTimeout(180_000);

  test("scan → suggestions → accept → collection in browse rail → detail", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    await waitMinioLive(page);

    let connId = "";
    const csrf = await getCsrfToken(page);
    const uploadedKeys = [
      "TV/Breaking.Bad.S01E01.mkv",
      "TV/Breaking.Bad.S01E02.mkv",
    ];
    try {
      connId = await connectS3AndScan(page);
      for (const key of uploadedKeys) {
        await putObject(page, csrf, connId, key);
      }
      await rescanAndAwait(page, connId, csrf);

      // Staging: one show group for the two episodes.
      const suggestions = await getSuggestions(page);
      const show = suggestions.find((s) => s.signature === "show:breakingbad");
      expect(show, `show suggestion staged: ${JSON.stringify(suggestions)}`)
        .toMatchObject({ kind: "show", title: "Breaking Bad", member_count: 2 });

      // UI: the review banner appears; the flat grid and the organizer
      // are untouched alongside it (spec: existing surfaces stay).
      await page.goto("/");
      await expect(
        page.getByRole("region", { name: /review suggestions/i }),
      ).toBeVisible();
      await expect(
        page.getByText("1 suggested collection ready to review."),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "All videos" }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Folder organizer" }),
      ).toBeVisible();

      // Nothing entered browse as a collection before acceptance — no
      // Collections rail yet.
      await expect(
        page.getByRole("heading", { name: /^collections$/i }),
      ).toHaveCount(0);

      // The group cards live behind the Review button's modal (current
      // panel design): accept Breaking Bad through the dialog.
      await page.getByRole("button", { name: "Review", exact: true }).click();
      const reviewDialog = page.getByRole("dialog", {
        name: "Review suggestions",
      });
      await expect(reviewDialog).toBeVisible();
      await expect(reviewDialog.getByText("Breaking Bad")).toBeVisible();
      await reviewDialog
        .getByRole("button", { name: "Accept Breaking Bad" })
        .click();
      await reviewDialog.getByRole("button", { name: "Done" }).click();
      await expect(
        page.getByRole("region", { name: /review suggestions/i }),
      ).toHaveCount(0);

      // The rail appears with the accepted collection.
      const railCard = page.getByRole("link", { name: /breaking bad/i });
      await expect(railCard).toBeVisible();
      await expect(railCard).toContainText(/2 videos/);

      // Detail view: ordered members + play-all into the watch queue.
      await railCard.click();
      await expect(
        page.getByRole("heading", { name: /breaking bad/i }),
      ).toBeVisible();
      await expect(page.getByText("Series · 2 videos")).toBeVisible();
      const playAll = page.getByRole("link", { name: /play all/i });
      await expect(playAll).toHaveAttribute("href", /\/watch\//);
    } finally {
      // Delete the collections this test created, then hard-prune the
      // uploaded rows (see cleanupConnection for why disconnect alone
      // would leak them into later specs).
      const cleanupCsrf = await getCsrfToken(page).catch(() => null);
      if (connId && cleanupCsrf) {
        const list = await page.request
          .get("/api/collections", {
            headers: await authHeaders(page, cleanupCsrf),
          })
          .catch(() => null);
        if (list?.ok()) {
          const collections = (await list.json()) as { id: string }[];
          for (const c of collections) {
            await page.request
              .delete(`/api/collections/${c.id}`, {
                headers: await authHeaders(page, cleanupCsrf),
              })
              .catch(() => {});
          }
        }
      }
      await cleanupConnection(page, connId, uploadedKeys);
    }
  });

  test("dismiss suppresses the group across rescans", async ({ page }) => {
    await ensureAuthenticated(page);
    await waitMinioLive(page);

    let connId = "";
    const csrf = await getCsrfToken(page);
    const uploadedKeys = ["Movies/The.Matrix.(1999).mkv"];
    try {
      connId = await connectS3AndScan(page);
      await putObject(page, csrf, connId, uploadedKeys[0]);
      await rescanAndAwait(page, connId, csrf);

      const staged = await getSuggestions(page);
      const movie = staged.find((s) => s.signature === "movie:thematrix1999");
      expect(movie, `movie suggestion staged: ${JSON.stringify(staged)}`)
        .toMatchObject({ kind: "movie", title: "The Matrix (1999)" });

      // Dismiss through the API (the UI path is covered in vitest).
      const res = await page.request.post(
        `/api/collections/suggestions/${movie.id}/dismiss`,
        { headers: await authHeaders(page, csrf) },
      );
      expect(res.status()).toBe(204);
      expect(
        (await getSuggestions(page)).filter((s) => s.id === movie.id),
      ).toHaveLength(0);

      // Rescan regenerates staging — the dismissed signature must not
      // resurrect.
      await rescanAndAwait(page, connId, csrf);
      const after = await getSuggestions(page);
      expect(
        after.filter((s) => s.signature === "movie:thematrix1999"),
      ).toHaveLength(0);
    } finally {
      await cleanupConnection(page, connId, uploadedKeys);
    }
  });
});

test.describe("share a collection (share-collections task 003)", () => {
  test.setTimeout(180_000);

  const SHOW_TITLE = "Better Things";
  const SHARE_TITLE = "Collection share e2e";
  // .mp4 keys (not .mkv): the staged bytes are H.264 mp4, and the name
  // drives both classification and stream strategy — mp4 keeps the
  // recipient playback assertion on the direct, natively-playable path.
  const EPISODE_KEYS = [
    "TV/Better.Things.S01E01.mp4",
    "TV/Better.Things.S01E02.mp4",
    "TV/Better.Things.S01E03.mp4",
  ];

  let connId = "";
  let collectionId = "";
  let memberNames: string[] = [];

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      await waitMinioLive(page);
      const csrf = await getCsrfToken(page);

      connId = await connectS3AndScan(page);
      for (const key of EPISODE_KEYS) {
        await putObject(page, csrf, connId, key);
      }
      await rescanAndAwait(page, connId, csrf);

      // Accept the three-episode show group through the API (the UI
      // accept path is covered above and in vitest).
      const staged = await getSuggestions(page);
      const show = staged.find(
        (s) => s.signature === "show:betterthings",
      );
      expect(show, `show suggestion staged: ${JSON.stringify(staged)}`)
        .toMatchObject({ kind: "show", title: SHOW_TITLE, member_count: 3 });
      const acceptRes = await page.request.post(
        `/api/collections/suggestions/${show!.id}/accept`,
        { headers: await authHeaders(page, csrf) },
      );
      expect(acceptRes.ok()).toBeTruthy();
      const accepted = (await acceptRes.json()) as { id: string };
      collectionId = accepted.id;

      // Curation order is whatever the detail API returns — the
      // recipient assertions compare against it, not a guess.
      const detailRes = await page.request.get(
        `/api/collections/${collectionId}`,
      );
      expect(detailRes.ok()).toBeTruthy();
      const detail = (await detailRes.json()) as {
        members: { name: string }[];
      };
      memberNames = detail.members.map((m) => m.name);
      expect(memberNames).toHaveLength(3);
    } finally {
      await page.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!connId) return;
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page).catch(() => null);
      if (csrf) {
        // Revoke the shares this describe created (matched by the title
        // both dialogs typed) so a `--grep` partial run leaves no live
        // shares behind.
        const list = await page.request
          .get("/api/shares", { headers: await authHeaders(page, csrf) })
          .catch(() => null);
        if (list?.ok()) {
          const shares = (await list.json()) as {
            id: string;
            title: string;
          }[];
          for (const s of shares.filter((x) => x.title === SHARE_TITLE)) {
            await page.request
              .delete(`/api/shares/${s.id}`, {
                headers: await authHeaders(page, csrf),
              })
              .catch(() => {});
          }
        }
        if (collectionId) {
          await page.request
            .delete(`/api/collections/${collectionId}`, {
              headers: await authHeaders(page, csrf),
            })
            .catch(() => {});
        }
      }
      await cleanupConnection(page, connId, EPISODE_KEYS);
    } finally {
      await page.close();
    }
  });

  /** Create a share through the open ShareDialog: type a known title
   *  (also the afterAll cleanup matcher), submit, and return the
   *  one-time absolute link the dialog renders. */
  async function createShareThroughDialog(
    page: Page,
  ): Promise<string> {
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title (optional)").fill(SHARE_TITLE);
    await dialog.getByRole("button", { name: "Create share" }).click();
    await expect(
      page.getByRole("dialog", { name: "Share link created" }),
    ).toBeVisible();
    const link = await dialog.locator("p.break-all").textContent();
    expect(link).toBeTruthy();
    await dialog.getByRole("button", { name: "Done" }).click();
    return link!.trim();
  }

  /** Recipient landing: the shared items, in the owner's curation
   *  order (returned for callers that want it). */
  async function expectRecipientItemsInOrder(
    page: Page,
  ): Promise<string[]> {
    await expect(
      page.getByRole("heading", { name: SHARE_TITLE }),
    ).toBeVisible();
    await expect(
      page.getByText("3 videos shared with you"),
    ).toBeVisible();
    const names = await page
      .locator('a[aria-label^="Play "]')
      .evaluateAll((els) =>
        els.map((el) =>
          (el as HTMLAnchorElement)
            .getAttribute("aria-label")!
            .replace(/^Play /, ""),
        ),
      );
    expect(names).toEqual(memberNames);
    return names;
  }

  test("detail → Share → recipient sees exactly the members in curation order", async ({
    browser,
  }) => {
    const owner = await browser.newPage();
    const { context, page } = await recipientPage(browser);
    try {
      await ensureAuthenticated(owner);
      await owner.goto(`/collections/${collectionId}`);
      await expect(
        owner.getByRole("heading", { name: SHOW_TITLE }),
      ).toBeVisible();

      await owner.getByRole("button", { name: "Share" }).click();
      await expect(
        owner.getByRole("dialog", { name: `Share ${SHOW_TITLE}` }),
      ).toBeVisible();
      await expect(
        owner.getByRole("dialog").getByText(/these 3 videos/i),
      ).toBeVisible();
      const link = await createShareThroughDialog(owner);

      // Fresh context: no session, no cookies — the link is the only
      // credential.
      await page.goto(link);
      await expectRecipientItemsInOrder(page);
    } finally {
      await context.close();
      await owner.close();
    }
  });

  test("kebab → Share → delete collection → recipient link still lists and plays", async ({
    browser,
  }) => {
    const owner = await browser.newPage();
    const { context, page } = await recipientPage(browser);
    try {
      await ensureAuthenticated(owner);

      // Grid kebab path — no detail visit first.
      await owner.goto("/collections");
      await owner
        .getByRole("button", { name: `Actions for ${SHOW_TITLE}` })
        .click();
      await owner.getByRole("menuitem", { name: "Share" }).click();
      await expect(
        owner.getByRole("dialog", { name: `Share ${SHOW_TITLE}` }),
      ).toBeVisible();
      const link = await createShareThroughDialog(owner);

      // Snapshot durability: delete the source collection via the UI…
      await owner.goto(`/collections/${collectionId}`);
      await owner.getByRole("button", { name: "Delete" }).click();
      await owner.getByRole("button", { name: "Yes, delete" }).click();
      await expect(owner).toHaveURL(/\/$/);

      // …and the recipient link is untouched: same items, same order.
      await page.goto(link);
      const names = await expectRecipientItemsInOrder(page);

      // And it still plays: the first member's watch page buffers real
      // bytes (s3 direct strategy — presigned MinIO URL).
      await page.evaluate((name) => {
        const a = document.querySelector<HTMLAnchorElement>(
          `a[aria-label="Play ${name}"]`,
        );
        if (!a) throw new Error(`link "Play ${name}" not found`);
        a.click();
      }, names[0]);
      const video = page.locator("video");
      await expect(video).toBeVisible();
      await expect
        .poll(
          async () =>
            await video.evaluate((v: HTMLVideoElement) => v.readyState),
          { timeout: 15_000, message: "recipient video buffers" },
        )
        .toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
      await owner.close();
    }
  });
});
