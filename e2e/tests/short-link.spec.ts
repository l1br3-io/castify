// E2e short-link spec (docs/specs/short-links task 005) — the spec's two
// user journeys against the docker stack, with the third-party shortener
// fully intercepted:
//
//   A. mocked mint  → "Copy short link" puts the https alias on the
//      clipboard, the dialog shows it as text, and a re-click is served
//      from the per-device cache with ZERO further outbound calls;
//   B. mocked outage → the canonical link is copied instead and the
//      "shortener unavailable" note announces the fallback;
//   C. canonical primary → plain "Copy link" works with the shortener
//      down and never touches the shortener route;
//   D. shares-list surface → active rows with a local link offer the
//      button; mint-once applies there too.
//
// Hermeticity: every spoo.me request is handled by page.route with
// route.fulfill/route.abort only — no `route.continue`, so CI never
// contacts the live service. The call counter doubles as the mint-once
// proof (criterion: ≤1 outbound request per user action, 0 on cache hit).
//
// Clipboard in headless Chromium: instead of fighting clipboard
// permissions, an init script replaces navigator.clipboard.writeText with
// a recorder — the component-under-test's copy path is exercised
// unchanged, and the exact payload is assertable.

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import {
  disconnect,
  ensureAuthenticated,
  getCsrfToken,
  getVideos,
  revokeShare,
  seedAndScan,
} from "./helpers";

const TITLE_PREFIX = "Short link ";
const MINTED_ALIAS = "http://spoo.me/e2eShort"; // provider echoes http:
const MINTED_HTTPS = "https://spoo.me/e2eShort"; // the app upgrades it

let gdConnId = "";
let vacationId = "";

// ── Setup ────────────────────────────────────────────────────────────

test.describe("Short links (docs/specs/short-links task 005)", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page);
      gdConnId = await seedAndScan(page, "google_drive", "gd-shortlink@example.com", csrf);
      const data = await getVideos(page);
      const vacation = data.videos.find(
        (v) => v.provider === "google_drive" && v.name === "vacation.mp4",
      );
      if (!vacation) throw new Error('e2e setup: video "vacation.mp4" not found');
      vacationId = vacation.id;
    } finally {
      await page.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!gdConnId) return;
    const page = await browser.newPage();
    try {
      await ensureAuthenticated(page);
      const csrf = await getCsrfToken(page);
      const res = await page.request.get("/api/shares");
      if (res.ok()) {
        const shares = (await res.json()) as { id: string; title: string }[];
        for (const s of shares.filter((x) => x.title.startsWith(TITLE_PREFIX))) {
          await revokeShare(page, s.id, csrf);
        }
      }
      await disconnect(page, gdConnId, csrf);
    } finally {
      await page.close();
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────

  /** Owner context whose clipboard is a recorder. `__copied` holds every
   * writeText payload in order. */
  async function ownerWithClipboard(
    browser: Browser,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const w = window as unknown as { __copied: string[] };
      w.__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: (text: string) => {
            w.__copied.push(text);
            return Promise.resolve();
          },
        },
        configurable: true,
      });
    });
    const page = await context.newPage();
    await ensureAuthenticated(page);
    return { context, page };
  }

  async function lastCopied(page: Page): Promise<string> {
    return page.evaluate(() => {
      const w = window as unknown as { __copied?: string[] };
      return w.__copied?.[w.__copied.length - 1] ?? "";
    });
  }

  /** Intercept every spoo.me request hermetically. "ok" fulfills with a
   * minted alias, "down" aborts — never `route.continue`. */
  async function mockSpooMe(
    page: Page,
    mode: "ok" | "down",
  ): Promise<{ calls: () => number }> {
    let calls = 0;
    await page.route(/^https:\/\/spoo\.me\//, (route) => {
      calls += 1;
      if (mode === "down") return route.abort("connectionrefused");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ short_url: MINTED_ALIAS }),
      });
    });
    return { calls: () => calls };
  }

  /** Create a share through the dialog UI so this device ends up holding
   * the one-time link (surface #1) AND the per-device IndexedDB entry
   * (surface #2). Resolves once the post-creation view is up. */
  async function createShareViaDialog(
    page: Page,
    title: string,
  ): Promise<{ dialog: ReturnType<Page["getByRole"]> }> {
    await page.goto(`/watch/${encodeURIComponent(vacationId)}`);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/title/i).fill(title);
    await dialog.getByRole("button", { name: "Create share" }).click();
    await expect(
      dialog.getByText("This link is shown only once"),
    ).toBeVisible();
    return { dialog };
  }

  /** The canonical absolute link as displayed by the created view. */
  async function canonicalLink(
    dialog: ReturnType<Page["getByRole"]>,
  ): Promise<string> {
    return dialog.locator("p.font-mono").first().innerText();
  }

  // ── Tests ──────────────────────────────────────────────────────────

  test("A: mint puts the https alias on the clipboard; re-click is a zero-call cache hit", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { context, page } = await ownerWithClipboard(browser);
    try {
      const spoo = await mockSpooMe(page, "ok");
      const { dialog } = await createShareViaDialog(page, `${TITLE_PREFIX}mint`);

      const shortButton = page.getByRole("button", { name: "Copy short link" });
      await expect(shortButton).toBeVisible();
      await shortButton.click();

      // Clipboard holds the upgraded alias, the dialog shows it as text,
      // and exactly one outbound shortener request was made.
      await expect
        .poll(() => lastCopied(page), { timeout: 15_000 })
        .toBe(MINTED_HTTPS);
      await expect(dialog.getByText(MINTED_HTTPS)).toBeVisible();
      expect(spoo.calls()).toBe(1);

      // Second click: the label reset (2s) re-exposes "Copy short link";
      // the alias is served from the per-device cache — zero new calls.
      await expect(shortButton).toBeVisible({ timeout: 10_000 });
      await shortButton.click();
      await expect
        .poll(() => lastCopied(page), { timeout: 15_000 })
        .toBe(MINTED_HTTPS);
      expect(spoo.calls()).toBe(1);
    } finally {
      await context.close();
    }
  });

  test("B: outage falls back to the canonical link with an announced note", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { context, page } = await ownerWithClipboard(browser);
    try {
      const spoo = await mockSpooMe(page, "down");
      const { dialog } = await createShareViaDialog(page, `${TITLE_PREFIX}outage`);
      const canonical = await canonicalLink(dialog);

      await page.getByRole("button", { name: "Copy short link" }).click();

      await expect
        .poll(() => lastCopied(page), { timeout: 15_000 })
        .toBe(canonical);
      await expect(
        dialog.getByText(/Shortener unavailable — copied the full link instead/),
      ).toBeVisible();
      expect(spoo.calls()).toBe(1);
    } finally {
      await context.close();
    }
  });

  test("C: plain Copy link works with the shortener down and never calls it", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { context, page } = await ownerWithClipboard(browser);
    try {
      const spoo = await mockSpooMe(page, "down");
      const { dialog } = await createShareViaDialog(page, `${TITLE_PREFIX}primary`);
      const canonical = await canonicalLink(dialog);

      // exact: true — "Copy short link" must not match.
      await page.getByRole("button", { name: "Copy link", exact: true }).click();

      await expect
        .poll(() => lastCopied(page), { timeout: 15_000 })
        .toBe(canonical);
      expect(spoo.calls()).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("D: shares-list rows offer Copy short link; mint-once applies", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { context, page } = await ownerWithClipboard(browser);
    try {
      const spoo = await mockSpooMe(page, "ok");
      const title = `${TITLE_PREFIX}row`;
      await createShareViaDialog(page, title);

      await page.goto("/shares");
      const row = page.getByRole("row", { name: new RegExp(title) });
      await expect(row).toBeVisible();
      const shortButton = row.getByRole("button", { name: "Copy short link" });
      await expect(shortButton).toBeVisible();

      await shortButton.click();
      await expect
        .poll(() => lastCopied(page), { timeout: 15_000 })
        .toBe(MINTED_HTTPS);
      expect(spoo.calls()).toBe(1);

      // Cache hit on this device: same value, still exactly one call.
      await expect(shortButton).toBeVisible({ timeout: 10_000 });
      await shortButton.click();
      await expect
        .poll(() => lastCopied(page), { timeout: 15_000 })
        .toBe(MINTED_HTTPS);
      expect(spoo.calls()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
