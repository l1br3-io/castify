import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";

import { SettingsPage } from "./settings";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";
import { useSession } from "../hooks/use-session";
import { getShareLinkMap } from "../lib/share-links-db";

// The page embeds the Shares section (task 011), which reads the per-device
// link map from IndexedDB on mount — jsdom has no IndexedDB, so mock the
// store at the module boundary (same pattern as browse.test.tsx's
// player-db mock). `restoreMocks: true` resets implementations, so the
// default is re-established before each test.
vi.mock("../lib/share-links-db", () => ({
  getShareLinkMap: vi.fn(),
  saveShareLink: vi.fn(),
  deleteShareLink: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getShareLinkMap).mockResolvedValue({});
});

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function fillForm(current: string, next: string, confirm: string = next): void {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: current },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: next },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: confirm },
  });
}

// Mirrors the fake login route's current location (query params the settings
// page navigates with) and subscribes to the session query so the cache
// read-out survives the test client's gcTime: 0 (no unobserved-query GC).
function LoginProbe() {
  const location = useLocation();
  const { data: session } = useSession();
  return (
    <div data-testid="login">
      {location.search}|{session === null ? "signed-out" : "session"}
    </div>
  );
}

describe("SettingsPage", () => {
  it("renders the change-password form", () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>,
      { initialEntries: ["/settings"] },
    );

    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /change password/i }),
    ).toBeInTheDocument();
  });

  it("blocks submit when new and confirm passwords mismatch", () => {
    const { fetchSpy } = renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>,
      { initialEntries: ["/settings"] },
    );

    fillForm("oldpassword123", "newpassword123", "different123");
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(
      fetchSpy.mock.calls.filter(([input, init]) => {
        const url = String(input);
        return (
          url === "/api/session/password" && (init?.method ?? "GET") === "PUT"
        );
      }),
    ).toHaveLength(0);
  });

  it("submits, clears the session cache, and redirects to /login on 204", async () => {
    const { fetchSpy } = renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/login" element={<LoginProbe />} />
      </Routes>,
      {
        initialEntries: ["/settings"],
        fetchImplementation: (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === "/api/session/password" && method === "PUT")
            return noContent();
          // The login probe's `useSession` refetch must resolve `null`
          // (401 → null in fetchSession), never a live owner, so the
          // signed-out read-out stays deterministic.
          if (url === "/api/session" && method === "GET")
            return jsonError(401, "no session");
          return jsonError(404, `unmocked ${method} ${url}`);
        },
      },
    );

    fillForm("oldpassword123", "newpassword123");
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    const login = await screen.findByTestId("login");
    expect(login).toHaveTextContent("password_changed");
    // The probe's session query starts in flight (`undefined` renders as
    // "session"), so wait for the 401→null resolution instead of racing it.
    await waitFor(() => expect(login).toHaveTextContent("signed-out"));

    const putCall = fetchSpy.mock.calls.find(([input, init]) => {
      const url = String(input);
      return (
        url === "/api/session/password" && (init?.method ?? "GET") === "PUT"
      );
    });
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      current_password: "oldpassword123",
      new_password: "newpassword123",
    });
  });

  it("renders a generic form-level error on 401 (wrong current password)", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>,
      {
        initialEntries: ["/settings"],
        fetchImplementation: (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === "/api/session/password" && method === "PUT")
            return jsonError(401, "invalid credentials");
          return jsonError(404, `unmocked ${method} ${url}`);
        },
      },
    );

    fillForm("wrongpassword1", "newpassword123");
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() => {
      expect(screen.getByText("Wrong password.")).toBeInTheDocument();
    });
  });

  it("renders the server validation message on 400", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>,
      {
        initialEntries: ["/settings"],
        fetchImplementation: (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === "/api/session/password" && method === "PUT")
            return jsonError(400, "password must be at least 8 characters");
          return jsonError(404, `unmocked ${method} ${url}`);
        },
      },
    );

    fillForm("oldpassword123", "newpassword123");
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() => {
      expect(
        screen.getByText("password must be at least 8 characters"),
      ).toBeInTheDocument();
    });
  });
});

describe("SettingsPage shares section", () => {
  it("renders the Shares heading and rows from GET /api/shares", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>,
      {
        initialEntries: ["/settings"],
        fetchImplementation: (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === "/api/shares" && method === "GET")
            return jsonResponse([
              {
                id: "s1",
                title: "Trip footage",
                item_count: 3,
                created_at: "2026-08-01T12:00:00Z",
                expires_at: null,
                revoked_at: null,
                status: "active",
              },
            ]);
          return jsonError(404, `unmocked ${method} ${url}`);
        },
      },
    );

    expect(await screen.findByText("Trip footage")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shares" })).toBeInTheDocument();
    // No local link for this share → status only, no copy button.
    expect(
      screen.queryByRole("button", { name: /copy link/i }),
    ).not.toBeInTheDocument();
  });
});

describe("SettingsPage transcoding section", () => {
  // Stateful handler: GET returns the current toggle state, and a
  // successful PUT persists the flip (mirrors the real server — a GET
  // after a PUT returns the new value, not the boot-time one).
  function transcodeHandler(
    initial: boolean,
    putError?: Response,
  ): (input: RequestInfo | URL, init?: RequestInit) => Response {
    let current = initial;
    return (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings/transcode" && method === "GET")
        return jsonResponse({ enabled: current });
      if (url === "/api/settings/transcode" && method === "PUT") {
        if (putError) return putError;
        current = !current;
        return jsonResponse({ enabled: current });
      }
      return jsonError(404, `unmocked ${method} ${url}`);
    };
  }

  it("reflects the server state on load", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>,
      {
        initialEntries: ["/settings"],
        fetchImplementation: transcodeHandler(true),
      },
    );

    const toggle = await screen.findByRole("switch", { name: /transcoding/i });
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "true"),
    );
    expect(
      screen.getByText(/browser-friendly formats/i),
    ).toBeInTheDocument();
  });

  it("issues a PUT with the flipped value on click", async () => {
    const { fetchSpy } = renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>,
      {
        initialEntries: ["/settings"],
        fetchImplementation: transcodeHandler(true),
      },
    );

    const toggle = await screen.findByRole("switch", { name: /transcoding/i });
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "true"),
    );
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /transcoding/i }),
      ).toHaveAttribute("aria-checked", "false");
    });
    const putCall = fetchSpy.mock.calls.find(([input, init]) => {
      const url = String(input);
      return (
        url === "/api/settings/transcode" && (init?.method ?? "GET") === "PUT"
      );
    });
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      enabled: false,
    });
  });

  it("reverts with an error notice when the PUT fails", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>,
      {
        initialEntries: ["/settings"],
        fetchImplementation: transcodeHandler(true, jsonError(500, "boom")),
      },
    );

    const toggle = await screen.findByRole("switch", { name: /transcoding/i });
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "true"),
    );
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /transcoding/i }),
      ).toHaveAttribute("aria-checked", "true");
    });
    expect(
      await screen.findByText(/couldn't save\. try again\./i),
    ).toBeInTheDocument();
  });
});
