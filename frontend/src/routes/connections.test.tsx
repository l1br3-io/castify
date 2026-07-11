import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";

import { ConnectionsPage } from "./connections";
import { setCsrfToken } from "../api/client";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";

// Fetch dispatch for the connections page. The page issues two GETs on mount:
// `GET /api/connections` (the list) and `GET /api/connections/available`
// (configured-providers probe). Mutations hit `POST .../start` and
// `DELETE /api/connections/{id}`.

const ALL_AVAILABLE = {
  google_drive: true,
  dropbox: true,
  onedrive: true,
};

const NONE_AVAILABLE = {
  google_drive: false,
  dropbox: false,
  onedrive: false,
};

function connectionsFetch(
  connections: unknown,
  available: unknown = ALL_AVAILABLE,
) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/connections" && method === "GET")
      return jsonResponse(connections);
    if (url === "/api/connections/available")
      return jsonResponse(available);
    return jsonError(404, "unmocked");
  };
}

const GOOGLE_CONNECTED = {
  id: "c1",
  provider: "google_drive",
  provider_account_email: "user@example.com",
  connected_at: "2026-01-01T00:00:00Z",
  scan_status: "idle",
  last_scan_at: "2026-01-02T00:00:00Z",
  video_count: 7,
};

describe("ConnectionsPage", () => {
  beforeEach(() => setCsrfToken("csrf-test"));
  afterEach(() => setCsrfToken(null));

  it("renders a connected card with email, video count, and disconnect", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([GOOGLE_CONNECTED]),
    });

    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText(/7 videos/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
  });

  it("renders an available (not connected) card with a connect button", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([]),
    });

    // Three provider cards, none connected, all configured → three Connect buttons.
    expect(await screen.findAllByRole("button", { name: /^connect$/i })).toHaveLength(3);
  });

  it("disables the connect button and shows a config hint when unconfigured", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([], NONE_AVAILABLE),
    });

    const disabledButtons = await screen.findAllByRole("button", {
      name: /connect/i,
    });
    // All three disabled.
    expect(disabledButtons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByText(/see/i).length).toBeGreaterThan(0);
  });

  it("shows a scanning badge and found-videos detail while scanning", async () => {
    const scanning = { ...GOOGLE_CONNECTED, scan_status: "scanning", video_count: 4 };
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([scanning]),
    });

    expect(await screen.findByText("Scanning")).toBeInTheDocument();
    expect(screen.getByText(/Found 4 videos/)).toBeInTheDocument();
  });

  it("navigates to the auth_url on connect", async () => {
    const originalLocation = window.location;
    const hrefSetter = vi.fn();
    // Stub window.location.href setter to observe the redirect.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        set href(value: string) {
          hrefSetter(value);
        },
      },
    });

    const { fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (
          url === "/api/connections/google_drive/start" &&
          method === "POST"
        ) {
          return jsonResponse({
            auth_url: "https://accounts.google.com/o/oauth2/auth?scope=...",
          });
        }
        return jsonError(404, "unmocked");
      },
    });

    // Click the first Connect button (Google Drive, index 0).
    const connectButtons = await screen.findAllByRole("button", {
      name: /^connect$/i,
    });
    fireEvent.click(connectButtons[0]);

    await waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith(
        "https://accounts.google.com/o/oauth2/auth?scope=...",
      );
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/connections/google_drive/start",
      expect.objectContaining({ method: "POST" }),
    );

    // Restore.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("disconnects after confirmation and clears the card", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1" && method === "DELETE")
          return new Response(null, { status: 204 });
        return jsonError(404, "unmocked");
      },
    });

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    await waitFor(() => {
      const deleteCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/connections/c1" &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeDefined();
    });
    expect(confirmSpy).toHaveBeenCalled();
    expect(
      (fetchSpy.mock.calls.at(-1)?.[1] as RequestInit).headers,
    ).toBeInstanceOf(Headers);

    confirmSpy.mockRestore();
  });

  it("does not disconnect when the confirm dialog is cancelled", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const { fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([GOOGLE_CONNECTED]),
    });

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    const deleteCall = fetchSpy.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/connections/c1" &&
        (init as RequestInit)?.method === "DELETE",
    );
    expect(deleteCall).toBeUndefined();
    confirmSpy.mockRestore();
  });

  it("shows a success banner on the ?connected={provider} callback", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections?connected=google_drive"],
      fetchImplementation: connectionsFetch([GOOGLE_CONNECTED]),
    });

    expect(
      await screen.findByText(/Google Drive connected. Scanning/),
    ).toBeInTheDocument();
  });

  it("shows an error banner on the ?error=oauth_failed callback", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections?error=oauth_failed"],
      fetchImplementation: connectionsFetch([]),
    });

    expect(
      await screen.findByText(/Connection failed/),
    ).toBeInTheDocument();
  });

  it("shows a Rescan button on connected cards", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([GOOGLE_CONNECTED]),
    });

    expect(
      await screen.findByRole("button", { name: /rescan/i }),
    ).toBeInTheDocument();
  });

  it("disables the Rescan button while scanning", async () => {
    const scanning = { ...GOOGLE_CONNECTED, scan_status: "scanning", video_count: 4 };
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([scanning]),
    });

    const rescanBtn = await screen.findByRole("button", { name: /scanning/i });
    expect((rescanBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("triggers a rescan POST on click", async () => {
    const { fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1/scan" && method === "POST")
          return new Response(null, { status: 202 });
        return jsonError(404, "unmocked");
      },
    });

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));

    await waitFor(() => {
      const rescanCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/connections/c1/scan" &&
          (init as RequestInit)?.method === "POST",
      );
      expect(rescanCall).toBeDefined();
    });
  });

  it("shows an error when rescan returns 409 conflict", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1/scan" && method === "POST")
          return jsonError(409, "a scan is already in progress");
        return jsonError(404, "unmocked");
      },
    });

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));

    expect(
      await screen.findByText(/already in progress/i),
    ).toBeInTheDocument();
  });
});
