import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { AppLayout } from "./app-layout";
import { setCsrfToken } from "../api/client";
import type { ConnectionDto, ScanStatus } from "../api/types";
import {
  jsonError,
  jsonResponse,
  renderWithProviders,
  type FetchHandler,
} from "../test/utils";

function connectionFixture(scan_status: ScanStatus): ConnectionDto {
  return {
    id: "c1",
    provider: "google_drive",
    provider_account_email: null,
    connected_at: "2026-01-01T00:00:00Z",
    scan_status,
    last_scan_at: null,
    video_count: 0,
    videos_pruned: 0,
    files_pruned: 0,
  };
}

function fetchedUrls(fetchSpy: { mock: { calls: unknown[][] } }): string[] {
  return fetchSpy.mock.calls.map(([url]) => String(url));
}

function renderLayout(fetchImpl: FetchHandler) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<div data-testid="page">Content</div>} />
      </Route>
      <Route path="/login" element={<div data-testid="login">Login</div>} />
    </Routes>,
    {
      initialEntries: ["/"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        // The shell answers the Library sidebar's folder tree; individual
        // tests mock everything else.
        if (url === "/api/folders/tree") return jsonResponse([]);
        return fetchImpl(input, init);
      },
    },
  );
}

describe("AppLayout (design frame shell: topbar + sidebar + drawer)", () => {
  beforeEach(() => setCsrfToken(null));
  afterEach(() => setCsrfToken(null));

  it("renders the sidebar nav in design order with the owner chrome when session present", async () => {
    renderLayout(() =>
      jsonResponse({
        owner: { id: "u1", display_name: "Alex" },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Alex")).toBeInTheDocument();
    });
    // The account menu is closed — Sign out lives behind it.
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();

    // Sidebar nav (design order): Library / Collections / Connections /
    // Shares / Settings — icons are decorative; the link text is the
    // accessible name.
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      "Library",
      "Collections",
      "Connections",
      "Shares",
      "Settings",
    ]);
    expect(within(nav).getByRole("link", { name: "Library" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(
      within(nav).getByRole("link", { name: "Collections" }),
    ).toHaveAttribute("href", "/collections");
    expect(
      within(nav).getByRole("link", { name: "Connections" }),
    ).toHaveAttribute("href", "/connections");
    expect(within(nav).getByRole("link", { name: "Shares" })).toHaveAttribute(
      "href",
      "/shares",
    );
    expect(within(nav).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("sends DELETE /api/session with x-csrf-token on sign-out", async () => {
    setCsrfToken("test-csrf");

    const { fetchSpy } = renderLayout((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/session" && method === "DELETE")
        return new Response(null, { status: 204 });
      if (url === "/api/session")
        return jsonResponse({
          owner: { id: "u1", display_name: "Alex" },
        });
      return jsonError(404, "unmocked");
    });

    await waitFor(() => {
      expect(screen.getByText("Alex")).toBeInTheDocument();
    });

    // Sign out lives in the account menu.
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /sign out/i }));

    await waitFor(() => {
      const deleteCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/session" &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeDefined();
      const headers = new Headers((deleteCall![1] as RequestInit).headers);
      expect(headers.get("x-csrf-token")).toBe("test-csrf");
    });
  });

  it("renders no shell chrome of its own when no session (auth screens own their brand)", async () => {
    renderLayout(() => jsonError(401, "unauthorized"));

    await waitFor(() => {
      expect(screen.getByTestId("page")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText("Connections")).not.toBeInTheDocument();
    // The topbar brand is session chrome; logged-out pages render
    // bare (login/setup carry their own brand).
    expect(
      screen.queryByRole("link", { name: "Castify" }),
    ).not.toBeInTheDocument();
  });

  describe("scan indicator", () => {
    it("names the scanning provider in a status announcement", async () => {
      const { fetchSpy } = renderLayout((input) => {
        if (String(input) === "/api/connections")
          return jsonResponse([connectionFixture("scanning")]);
        return jsonResponse({ owner: { id: "u1", display_name: "Alex" } });
      });

      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent("Scanning Google Drive");
      expect(fetchedUrls(fetchSpy)).toContain("/api/connections");
    });

    it("stays quiet when every connection is idle", async () => {
      const { fetchSpy } = renderLayout((input) => {
        if (String(input) === "/api/connections")
          return jsonResponse([connectionFixture("idle")]);
        return jsonResponse({ owner: { id: "u1", display_name: "Alex" } });
      });

      await waitFor(() => {
        expect(fetchedUrls(fetchSpy)).toContain("/api/connections");
      });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("does not render or fetch connections without a session", async () => {
      const { fetchSpy } = renderLayout(() => jsonError(401, "unauthorized"));

      await waitFor(() => {
        expect(screen.getByTestId("page")).toBeInTheDocument();
      });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(fetchedUrls(fetchSpy)).not.toContain("/api/connections");
    });
  });
});
