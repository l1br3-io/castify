// Shares page (/shares, app-redesign task 005): the SharesSection that
// used to live on /settings, promoted to its own route per spec D4.
// The section component is untouched — these tests pin the route-level
// contract: the list renders from GET /api/shares, and the per-device
// link map still gates the copy button (jsdom has no IndexedDB, so the
// store is mocked at the module boundary).

import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { SharesPage } from "./shares";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";
import { getShareLinkMap } from "../lib/share-links-db";

vi.mock("../lib/share-links-db", () => ({
  getShareLinkMap: vi.fn(),
  saveShareLink: vi.fn(),
  deleteShareLink: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getShareLinkMap).mockResolvedValue({});
});

function sharesFetch(rows: unknown[]) {
  return (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/shares" && method === "GET")
      return jsonResponse(rows);
    return jsonError(404, `unmocked ${method} ${url}`);
  };
}

describe("SharesPage", () => {
  it("renders the Shares heading and rows from GET /api/shares", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/shares" element={<SharesPage />} />
      </Routes>,
      { initialEntries: ["/shares"], fetchImplementation: sharesFetch([
        {
          id: "s1",
          title: "Trip footage",
          item_count: 3,
          created_at: "2026-08-01T12:00:00Z",
          expires_at: null,
          revoked_at: null,
          status: "active",
        },
      ]) },
    );

    expect(await screen.findByText("Trip footage")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shares" })).toBeInTheDocument();
    // No local link for this share → status only, no copy button.
    expect(
      screen.queryByRole("button", { name: /copy link/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the empty state when no shares exist", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/shares" element={<SharesPage />} />
      </Routes>,
      { initialEntries: ["/shares"], fetchImplementation: sharesFetch([]) },
    );

    expect(await screen.findByText("No shares yet")).toBeInTheDocument();
  });
});
