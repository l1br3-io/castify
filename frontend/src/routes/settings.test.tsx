import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";

import { SettingsPage } from "./settings";
import { jsonError, renderWithProviders } from "../test/utils";
import { useSession } from "../hooks/use-session";

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
    expect(login).toHaveTextContent("signed-out");

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
