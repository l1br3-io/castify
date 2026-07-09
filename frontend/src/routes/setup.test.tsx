import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { SetupPage } from "./setup";
import { setupLoader } from "../auth/require-session";
import { queryClient } from "../query-client";
import {
  jsonError,
  jsonResponse,
  renderWithProviders,
} from "../test/utils";

describe("SetupPage", () => {
  it("shows the wizard heading and create-account button", () => {
    renderWithProviders(<SetupPage />, {
      initialEntries: ["/setup"],
    });
    expect(screen.getByText("Welcome to Castify")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create account/i }),
    ).toBeInTheDocument();
  });

  it("disables the submit button until a display name and password are entered", () => {
    renderWithProviders(<SetupPage />, { initialEntries: ["/setup"] });
    const submitBtn = screen.getByRole("button", {
      name: /create account/i,
    });
    expect(submitBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Alex" },
    });
    expect(submitBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "testpassword123" },
    });
    expect(submitBtn).not.toBeDisabled();
  });

  it("submits the password form and navigates home on success", async () => {
    const owner = { id: "u1", display_name: "Alex" };

    const { fetchSpy } = renderWithProviders(
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/" element={<div data-testid="home">Home</div>} />
      </Routes>,
      {
        initialEntries: ["/setup"],
        fetchImplementation: (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === "/api/setup" && method === "POST")
            return jsonResponse({ owner });
          if (url === "/api/csrf")
            return jsonResponse({ token: "csrf-token" });
          if (url === "/api/session")
            return jsonResponse({ owner });
          return jsonError(404, `unmocked ${method} ${url}`);
        },
      },
    );

    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Alex" },
    });

    const passwordInput = screen.getByLabelText("Password");
    fireEvent.change(passwordInput, { target: { value: "testpassword123" } });

    fireEvent.click(
      screen.getByRole("button", { name: /create account/i }),
    );

    await waitFor(() => {
      const setupCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/setup" &&
          (init as RequestInit)?.method === "POST",
      );
      expect(setupCall).toBeDefined();
    });

    await waitFor(() => {
      expect(screen.getByTestId("home")).toBeInTheDocument();
    });
  });

  it("shows an inline error when password submission fails with 400", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
      </Routes>,
      {
        initialEntries: ["/setup"],
        fetchImplementation: (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === "/api/setup" && method === "POST")
            return jsonError(400, "Password too common");
          return jsonError(404, "unmocked");
        },
      },
    );

    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Alex" },
    });

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "testpassword123" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /create account/i }),
    );

    await waitFor(() => {
      expect(screen.getByText("Password too common")).toBeInTheDocument();
    });
  });
});

describe("setupLoader", () => {
  beforeEach(() => {
    queryClient.clear();
  });

  it("redirects to /login when setup is closed (409)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/setup")) return jsonError(409, "exists");
        return jsonError(404, "unmocked");
      }),
    );

    try {
      await setupLoader();
      expect.fail("loader should have redirected");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      const response = error as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/login");
    }
  });
});
