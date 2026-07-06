import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { AppLayout } from "./app-layout";
import { setCsrfToken } from "../api/client";
import {
  jsonError,
  jsonResponse,
  renderWithProviders,
  type FetchHandler,
} from "../test/utils";

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
      expect(screen.getByText("M0 · Foundation")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();
  });
});
