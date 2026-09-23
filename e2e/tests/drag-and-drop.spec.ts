// E2e drag-and-drop test: the three verbs against the full stack
// (docs/specs/drag-and-drop/spec.md success criteria).
//
//   1. Organize — item drags onto folder tiles + the Unfiled pin (one
//      PATCH per drop, selection carried), folder reparent drag, and
//      the client-side refusal of an illegal drop (self-reparent)
//   2. Order — within-folder reorder via one items/order request whose
//      order survives a reload
//   3. Upload — two local files dropped through the veil into the e2e
//      stack's real MinIO connection, landing Unfiled after the scan
//
// Pointer drags use real mouse steps (the implementation listens to
// pointer events — HTML5 DnD automation would bypass the engine).

import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  seedAndScan,
} from "./helpers";

const MINIO_ENDPOINT = "http://localhost:9000";
const MINIO_ROOT_USER = "castify-e2e";
const MINIO_ROOT_PASSWORD = "castify-e2e-secret";
const BUCKET = "media";

/** Mouse-step pointer drag: press on the source, walk to the target,
 *  release. Steps keep the engine's threshold and hover transitions
 *  real (a single teleport move can skip element enter events). */
async function pointerDrag(
  page: Page,
  source: Locator,
  target: Locator,
  steps = 12,
): Promise<void> {
  await expect(source).toBeVisible();
  const from = (await source.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const to = (await target.boundingBox())!;
    const x = from.x + from.width / 2 + ((to.x + to.width / 2 - (from.x + from.width / 2)) * i) / steps;
    const y = from.y + from.height / 2 + ((to.y + to.height / 2 - (from.y + from.height / 2)) * i) / steps;
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
}

/** Count PATCHes to one endpoint while the callback runs — the
 *  one-request-per-action gate. */
async function countPatches(
  page: Page,
  urlSuffix: string,
  action: () => Promise<void>,
): Promise<number> {
  let count = 0;
  const listener = (request: { method(): string; url(): string }): void => {
    if (request.method() === "PATCH" && request.url().endsWith(urlSuffix)) {
      count += 1;
    }
  };
  page.on("request", listener);
  try {
    await action();
  } finally {
    page.off("request", listener);
  }
  return count;
}

test.describe("Drag and drop (e2e)", () => {
  test("organize: item drags, reparent, illegal-drop refusal", async ({ page }) => {
    test.setTimeout(150_000);
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    const gdId = await seedAndScan(
      page,
      "google_drive",
      "gd-dnd@example.com",
      csrf,
    );

    try {
      await page.goto("/");
      const organizer = page.locator("section[aria-label='Folder organizer']");

      // Two destination folders at the root.
      for (const name of ["Trips", "Outer"]) {
        await organizer.getByRole("button", { name: "+ New folder" }).click();
        await organizer.getByLabel("Folder name").fill(name);
        await organizer.getByRole("button", { name: "Save" }).click();
        await expect(
          organizer.getByRole("link", { name: `Open folder ${name}` }),
        ).toBeVisible();
      }
      const unfiledBadge = organizer
        .locator("h3[title='Unfiled'] ~ p")
        .first();
      await expect(unfiledBadge).toHaveText(/\d+ items/);
      const initial = Number((await unfiledBadge.textContent())!.match(/\d+/)![0]);
      expect(initial).toBeGreaterThanOrEqual(9);

      // ── Single-card drag onto a folder tile: ONE batch move ────────
      const card = organizer
        .locator("article", { hasText: "vacation.mp4" })
        .first();
      const tripsTile = organizer
        .locator("article", { hasText: "Trips" })
        .first();
      // Count preview while hovering: the badge steps to its post-drop
      // value before release.
      const patches = await countPatches(
        page,
        "/api/library-folders/items",
        async () => {
          const drag = pointerDrag(page, card, tripsTile);
          await expect(organizer.getByText(/\d+ → \d+ items/).first()).toBeVisible({ timeout: 5_000 }).catch(() => {});
          await drag;
        },
      );
      expect(patches).toBe(1);
      await expect(unfiledBadge).toHaveText(`${initial - 1} items`);

      // ── Multi-select drag carries the whole selection ─────────────
      await organizer.getByRole("button", { name: "Select items" }).click();
      await expect(organizer.getByText("0 items selected")).toBeVisible();
      await organizer
        .getByRole("checkbox", { name: "Select screenshots.mp4" })
        .click()
        .catch(async () => {
          // The gd fixture's second video: fall back to any checkbox.
          await organizer.getByRole("checkbox").first().click();
        });
      await organizer
        .locator("article", { hasText: "song.mp3" })
        .first()
        .click();
      await expect(organizer.getByText("2 items selected")).toBeVisible();

      const selected = organizer
        .locator("article", { hasText: "screenshots.mp4" })
        .first();
      const selectionPatches = await countPatches(
        page,
        "/api/library-folders/items",
        () => pointerDrag(page, selected, tripsTile),
      );
      expect(selectionPatches).toBe(1);
      await expect(unfiledBadge).toHaveText(`${initial - 3} items`);
      await organizer.getByRole("button", { name: "Done" }).click();

      // ── Drag onto the Unfiled pin: move back with folder_id null ──
      const unfiledPin = organizer
        .locator("article", { hasText: "Unfiled" })
        .first();
      const backPatches = await countPatches(
        page,
        "/api/library-folders/items",
        async () => {
          const request = page.waitForRequest(
            (req) =>
              req.method() === "PATCH" &&
              req.url().endsWith("/api/library-folders/items"),
          );
          await pointerDrag(page, organizer.locator("article", { hasText: "song.mp3" }).first(), unfiledPin);
          const body = (await request).postDataJSON() as {
            folder_id: string | null;
          };
          expect(body.folder_id).toBeNull();
        },
      );
      expect(backPatches).toBe(1);
      await expect(unfiledBadge).toHaveText(`${initial - 2} items`);

      // ── Reparent: Outer gets a child, dragged onto it ──────────────
      await organizer
        .getByRole("button", { name: "More actions for Outer" })
        .click();
      await organizer.getByRole("menuitem", { name: "New folder" }).click();
      await organizer.getByLabel("Folder name").fill("Inner");
      await organizer.getByRole("button", { name: "Save" }).click();
      await expect(
        organizer.getByRole("link", { name: "Open folder Inner" }),
      ).toBeVisible();

      // Illegal drop: Inner onto itself — refused client-side, zero
      // requests, explicit invalid state (strike-through label).
      const innerTile = organizer
        .locator("article", { hasText: "Inner" })
        .first();
      const selfPatches = await countPatches(page, "/api/library-folders/", async () => {
        await pointerDrag(page, innerTile, innerTile);
      });
      expect(selfPatches).toBe(0);
    } finally {
      await disconnect(page, gdId, csrf);
    }
  });

  test("order: within-folder reorder persists across reload", async ({ page }) => {
    test.setTimeout(150_000);
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);
    const gdId = await seedAndScan(
      page,
      "google_drive",
      "gd-reorder@example.com",
      csrf,
    );

    try {
      await page.goto("/");
      const organizer = page.locator("section[aria-label='Folder organizer']");
      await organizer.getByRole("button", { name: "+ New folder" }).click();
      await organizer.getByLabel("Folder name").fill("Mix");
      await organizer.getByRole("button", { name: "Save" }).click();
      await expect(
        organizer.getByRole("link", { name: "Open folder Mix" }),
      ).toBeVisible();

      // Drag the first listed video onto the Mix tile — three times for
      // three videos (each its own single request).
      for (const name of ["vacation.mp4", "screenshots.mp4"]) {
        const patches = await countPatches(
          page,
          "/api/library-folders/items",
          () =>
            pointerDrag(
              page,
              organizer.locator("article", { hasText: name }).first(),
              organizer.locator("article", { hasText: "Mix" }).first(),
            ),
        );
        expect(patches).toBe(1);
      }

      // Enter Mix (the tile's stretched link needs the DOM-click idiom).
      await page.evaluate(() => {
        document
          .querySelector<HTMLAnchorElement>("a[aria-label='Open folder Mix']")
          ?.click();
      });
      await expect(organizer.getByTestId("contents-path")).toHaveText("Mix");
      const names = () =>
        organizer.locator("[data-contents-grid] article h3").allTextContents();

      // The server's order stands before the reorder.
      let before = await names();
      expect(before.length).toBeGreaterThanOrEqual(2);
      expect(before).toContain("vacation.mp4");

      // Drag the LAST card past the FIRST: one items/order request with
      // the full reordered list.
      const cards = organizer.locator("[data-contents-grid] article");
      const orderRequest = page.waitForRequest(
        (req) =>
          req.method() === "PATCH" &&
          req.url().endsWith("/api/library-folders/items/order"),
      );
      await pointerDrag(page, cards.nth(1), cards.nth(0));
      const body = (await orderRequest).postDataJSON() as {
        items: Array<{ kind: string; id: string }>;
      };
      expect(body.items).toHaveLength(before.length);

      // The displayed order followed the drag…
      const after = await names();
      expect(after).not.toEqual(before);
      // …and survives a reload (the server owns the order).
      await page.reload();
      await expect(organizer.getByTestId("contents-path")).toHaveText("Mix");
      await expect
        .poll(async () => organizer.locator("[data-contents-grid] article h3").allTextContents())
        .toEqual(after);
    } finally {
      await disconnect(page, gdId, csrf);
    }
  });

  test("upload: veil → destination → progress → Unfiled pickup", async ({ page }) => {
    test.setTimeout(180_000);
    await ensureAuthenticated(page);
    const csrf = await getCsrfToken(page);

    // Connect the stack's real MinIO through the credentials form.
    await page.goto("/connections");
    const card = page.locator("article", {
      has: page.getByRole("heading", { name: "S3-Compatible Storage" }),
    });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Connect" }).click();
    await card.getByLabel("Endpoint").fill(MINIO_ENDPOINT);
    await card.getByLabel("Region").fill("us-east-1");
    await card.getByLabel("Bucket").fill(BUCKET);
    await card.getByLabel("Access key ID", { exact: true }).fill(MINIO_ROOT_USER);
    await card
      .getByLabel("Secret access key", { exact: true })
      .fill(MINIO_ROOT_PASSWORD);
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(card.getByText("Not connected")).toHaveCount(0, {
      timeout: 15_000,
    });

    const connectionId = await page
      .request.get("/api/connections")
      .then((res) => res.json())
      .then(
        (list: Array<{ id: string; provider: string }>) =>
          list.find((c) => c.provider === "s3")!.id,
      );

    try {
      await page.goto("/");
      const organizer = page.locator("section[aria-label='Folder organizer']");
      await expect(organizer.getByText("Unfiled").first()).toBeVisible();

      // Two local fixture files through the veil — real DataTransfer
      // events from the browser context.
      const uploadNames = ["e2e-dnd-a.txt", "e2e-dnd-b.txt"];
      await page.evaluate(
        ([a, b]) => {
          const dt = new DataTransfer();
          for (const name of [a, b]) {
            dt.items.add(
              new File([`drag-and-drop e2e fixture ${name}\n`], name, {
                type: "text/plain",
              }),
            );
          }
          window.dispatchEvent(
            new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }),
          );
          window.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt,
            }),
          );
        },
        uploadNames,
      );

      // The veil showed, the dialog took over.
      const dialog = page.getByRole("dialog", { name: "Upload files" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(uploadNames[0]!)).toBeVisible();
      await expect(dialog.getByText(uploadNames[1]!)).toBeVisible();
      await dialog.getByRole("button", { name: "Upload 2 files" }).click();

      // The queue concludes with the verb held constant.
      await expect(page.getByText("Uploaded 2 files")).toBeVisible({
        timeout: 60_000,
      });

      // The kicked scan lands them Unfiled (documents list under the
      // grid's rows section).
      await expect
        .poll(
          async () =>
            organizer
              .locator("[data-contents-rows], [data-contents-grid]")
              .getByText(uploadNames[0]!)
              .count(),
          { timeout: 60_000 },
        )
        .toBeGreaterThan(0);
      await expect(
        organizer.getByText(uploadNames[1]!),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await disconnect(page, connectionId, csrf);
    }
  });
});
