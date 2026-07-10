import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { HomePage } from "./home";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";

describe("HomePage", () => {
  it("shows the loading state before the health check resolves", () => {
    renderWithProviders(<HomePage />, {
      fetchImplementation: () => new Promise<Response>(() => {}),
    });
    expect(screen.getByText("Checking…")).toBeInTheDocument();
  });

  it("renders health details when the check succeeds", async () => {
    renderWithProviders(<HomePage />, {
      fetchImplementation: (input) => {
        const url = String(input);
        if (url === "/api/health") {
          return jsonResponse({
            status: "ok",
            version: "1.2.3",
            uptime_seconds: 42,
          });
        }
        return jsonError(404, "unmocked");
      },
    });

    expect(await screen.findByText("ok")).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(screen.getByText("42s")).toBeInTheDocument();
  });

  it("shows an unreachable message when the check fails", async () => {
    renderWithProviders(<HomePage />, {
      fetchImplementation: () => jsonError(503, "down"),
    });

    expect(
      await screen.findByText("Backend unreachable. Is the API running on port 8427?"),
    ).toBeInTheDocument();
  });
});
