// E2e smoke test: full auth lifecycle against the Docker stack.
//
// Covers the Checkpoint D acceptance path:
//   cold boot → /setup wizard → password enrollment → home (authenticated) →
//   logout → /login → password sign-in → home (authenticated again).
//
// Requires a cold-booted stack (no owner record). The `just e2e` recipe and
// the CI workflow tear down the volume before starting so the first-run
// wizard is guaranteed to appear.

import { test, expect } from "@playwright/test";

const DISPLAY_NAME = "E2E Owner";
const PASSWORD = "e2e-test-password-123";

test.describe("Auth lifecycle (cold boot)", () => {
  test("setup → login → logout → login", async ({ page }) => {
    // ── 1. Cold boot: no owner → / redirects to /setup ──────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);

    await expect(
      page.getByRole("heading", { name: "Welcome to Castify" }),
    ).toBeVisible();

    // ── 2. Enroll owner via password ────────────────────────────────
    await page.getByLabel("Display name").fill(DISPLAY_NAME);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();

    // ── 3. Authenticated landing on / ───────────────────────────────
    await expect(page).toHaveURL(/\/$/);

    // First-run guide rendered (proves SPA ↔ API connectivity through
    // the embedded single-binary server — the guide only appears after
    // `GET /api/connections` returns an empty array successfully).
    await expect(
      page.getByText("Connect your first cloud"),
    ).toBeVisible();

    // Header reflects the authenticated session: the avatar shows the
    // display name; the account menu carries the full identity + sign-out.
    await expect(
      page.getByText(DISPLAY_NAME, { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByText(/Signed in as/)).toBeVisible();

    // ── 4. Logout ───────────────────────────────────────────────────
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // ── 5. Login again with the same password ───────────────────────
    await expect(
      page.getByRole("heading", { name: "Sign in" }),
    ).toBeVisible();
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // ── 6. Authenticated once more ──────────────────────────────────
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByText(DISPLAY_NAME, { exact: true }),
    ).toBeVisible();
    // Account identity lives behind the avatar menu (design topbar).
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByText(/Signed in as/)).toBeVisible();
  });
});
