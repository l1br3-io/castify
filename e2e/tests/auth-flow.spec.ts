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

    // Health probe rendered with a successful status (proves SPA ↔ API
    // connectivity through the embedded single-binary server).
    await expect(
      page.getByRole("heading", { name: "Backend health" }),
    ).toBeVisible();
    await expect(page.getByText("ok", { exact: true })).toBeVisible();

    // Header reflects the authenticated session. Use exact match on the
    // display name — the wrapping span also contains it as a substring.
    await expect(page.getByText(/Signed in as/)).toBeVisible();
    await expect(
      page.getByText(DISPLAY_NAME, { exact: true }),
    ).toBeVisible();

    // ── 4. Logout ───────────────────────────────────────────────────
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // ── 5. Login again with the same password ───────────────────────
    await expect(
      page.getByRole("heading", { name: "Sign in" }),
    ).toBeVisible();
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // ── 6. Authenticated once more ──────────────────────────────────
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(/Signed in as/)).toBeVisible();
    await expect(
      page.getByText(DISPLAY_NAME, { exact: true }),
    ).toBeVisible();
  });
});
