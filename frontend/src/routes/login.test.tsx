import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { LoginPage } from "./login";
import {
  jsonError,
  jsonResponse,
  renderWithProviders,
} from "../test/utils";

describe("LoginPage", () => {
  it("shows 'Wrong password.' on a 401", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
      </Routes>,
      {
        initialEntries: ["/login"],
        fetchImplementation: (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === "/api/session" && method === "POST")
            return jsonError(401, "invalid credentials");
          return jsonError(404, `unmocked ${method} ${url}`);
        },
      },
    );

    const passwordInput = screen.getByLabelText("Password");
    fireEvent.change(passwordInput, { target: { value: "testpassword123" } });

    fireEvent.click(
      screen.getByRole("button", { name: /sign in with password/i }),
    );

    await waitFor(() => {
      expect(screen.getByText("Wrong password.")).toBeInTheDocument();
    });
  });

  it("navigates home on successful password login", async () => {
    const owner = { id: "u1", display_name: "Alex" };

    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div data-testid="home">Home</div>} />
      </Routes>,
      {
        initialEntries: ["/login"],
        fetchImplementation: (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === "/api/session" && method === "POST")
            return jsonResponse({ owner });
          if (url === "/api/csrf")
            return jsonResponse({ token: "csrf-token" });
          if (url === "/api/session") return jsonResponse({ owner });
          return jsonError(404, `unmocked ${method} ${url}`);
        },
      },
    );

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "testpassword123" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /sign in with password/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("home")).toBeInTheDocument();
    });
  });

  it("disables the passkey button with helper text when begin returns 404", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
      </Routes>,
      {
        initialEntries: ["/login"],
        fetchImplementation: (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url.includes("/api/session/webauthn/begin"))
            return jsonError(404, "no passkeys");
          return jsonError(404, `unmocked ${method} ${url}`);
        },
      },
    );

    fireEvent.click(
      screen.getByRole("button", { name: /sign in with passkey/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/no passkey registered/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /sign in with passkey/i }),
    ).toBeDisabled();
  });
});
