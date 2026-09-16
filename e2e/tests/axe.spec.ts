// A11y gate (app-redesign task 004): one axe scan per redesigned screen.
//
// Green by construction (see scanAxe in helpers.ts): only screens that
// have already been redesigned get a case here. Every later screen task
// appends its own scan case — login/setup arrive with tasks 006/007, and
// so on. Zero serious/critical violations is a hard gate.
//
// Named axe.spec.ts (spec sketch said a11y.spec.ts): Playwright runs
// spec files alphabetically with one worker, and auth-flow.spec.ts must
// run FIRST — its cold-boot case expects no owner to exist. "axe" sorts
// after "auth-flow"; "a11y" sorted before it and broke that assumption.

import { test } from "@playwright/test";

import { ensureAuthenticated, scanAxe } from "./helpers";

test.describe("A11y (axe) — redesigned screens", () => {
  test("home/library (/) — no serious or critical violations", async ({
    page,
  }) => {
    await ensureAuthenticated(page);
    await page.waitForLoadState("networkidle");
    await scanAxe(page, "home-library");
  });
});
