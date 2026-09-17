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
    { initialEntries: ["/"], fetchImplementation: fetchImpl },
  );
}

describe("AppLayout", () => {
  beforeEach(() => setCsrfToken(null));
  afterEach(() => setCsrfToken(null));

  it("shows the owner display name and sign-out button when session present", async () => {
    renderLayout(() =>
      jsonResponse({
        owner: { id: "u1", display_name: "Alex" },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Alex")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /sign out/i }),
    ).toBeInTheDocument();

    // Primary nav (spec D4): Library / Shares / Sources / Settings.
    const nav = screen.getByRole("navigation");
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      "Library",
      "Shares",
      "Sources",
      "Settings",
    ]);
    expect(
      within(nav).getByRole("link", { name: "Library" }),
    ).toHaveAttribute("href", "/");
    expect(
      within(nav).getByRole("link", { name: "Shares" }),
    ).toHaveAttribute("href", "/shares");
    expect(
      within(nav).getByRole("link", { name: "Sources" }),
    ).toHaveAttribute("href", "/connections");
    expect(
      within(nav).getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("href", "/settings");
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

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() => {
      const deleteCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/session" &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeDefined();
      const headers = new Headers(
        (deleteCall![1] as RequestInit).headers,
      );
      expect(headers.get("x-csrf-token")).toBe("test-csrf");
    });
  });

  it("shows a bare header without auth chrome when no session", async () => {
    renderLayout(() => jsonError(401, "unauthorized"));

    await waitFor(() => {
      expect(screen.getByText("Castify")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText("Sources")).not.toBeInTheDocument();
  });

  describe("scan LED", () => {
    it("announces scanning while any connection has scan_status scanning", async () => {
      const { fetchSpy } = renderLayout((input) => {
        if (String(input) === "/api/connections")
          return jsonResponse([connectionFixture("scanning")]);
        return jsonResponse({ owner: { id: "u1", display_name: "Alex" } });
      });

      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent("Scanning your cloud");
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
      const { fetchSpy } = renderLayout(() =>
        jsonError(401, "unauthorized"),
      );

      await waitFor(() => {
        expect(screen.getByText("Castify")).toBeInTheDocument();
      });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(fetchedUrls(fetchSpy)).not.toContain("/api/connections");
    });
  });
});
