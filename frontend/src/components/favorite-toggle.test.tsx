import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { FavoriteToggle } from "./favorite-toggle";
import type { VideoSummaryDto } from "../api/types";
import { setCsrfToken } from "../api/client";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";

const NOT_FAV: VideoSummaryDto = {
  id: "v1",
  name: "cat.mp4",
  provider: "google_drive",
  size_bytes: 1024,
  mime_type: "video/mp4",
  duration_ms: null,
  width: null,
  height: null,
  sources: [],
  created_at: "2026-01-01T00:00:00Z",
  path: null,
  is_favorite: false,
  my_rating: null,
  thumbnail_status: "pending",
  position_seconds: null,
  completed: false,
};

const FAV: VideoSummaryDto = { ...NOT_FAV, is_favorite: true };

// Renders the toggle inside a `group` parent so the hover-reveal Tailwind
// classes apply the same way they do inside PosterCard.
function GroupedToggle(props: React.ComponentProps<typeof FavoriteToggle>) {
  return (
    <div className="group">
      <FavoriteToggle {...props} />
    </div>
  );
}

describe("FavoriteToggle", () => {
  beforeEach(() => setCsrfToken("csrf-test"));
  afterEach(() => setCsrfToken(null));

  it("renders an unfilled heart with aria-pressed=false when not favorited", () => {
    renderWithProviders(<GroupedToggle video={NOT_FAV} />);
    const btn = screen.getByRole("button", { name: /add to favorites/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    // Heart icon path uses fill="none" when not favorited.
    const svg = btn.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("none");
  });

  it("renders a filled heart with aria-pressed=true when favorited", () => {
    renderWithProviders(<GroupedToggle video={FAV} />);
    const btn = screen.getByRole("button", { name: /remove from favorites/i });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    const svg = btn.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
  });

  it("is visible at low prominence (opacity-70) when not favorited, full on hover", () => {
    renderWithProviders(<GroupedToggle video={NOT_FAV} />);
    const btn = screen.getByRole("button", { name: /add to favorites/i });
    // Design-pass: previously hover-gated (opacity-0 → group-hover:opacity-100),
    // now always visible at opacity-70 so the affordance is discoverable.
    expect(btn.className).toContain("opacity-70");
    expect(btn.className).toContain("group-hover:opacity-100");
    expect(btn.className).not.toContain("opacity-0");
  });

  it("is always visible (opacity-100) when favorited", () => {
    renderWithProviders(<GroupedToggle video={FAV} />);
    const btn = screen.getByRole("button", { name: /remove from favorites/i });
    expect(btn.className).toContain("opacity-100");
    expect(btn.className).not.toContain("opacity-0");
  });

  it("fires POST /favorite and flips optimistically when clicking unfavorited", async () => {
    const { fetchSpy } = renderWithProviders(<GroupedToggle video={NOT_FAV} />, {
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/videos/v1/favorite" && method === "POST")
          return jsonResponse({ is_favorite: true });
        return jsonError(404, "unmocked");
      },
    });

    const btn = screen.getByRole("button", { name: /add to favorites/i });
    fireEvent.click(btn);

    // The optimistic cache patch flips `is_favorite` to true synchronously.
    // The component re-renders from the patched cache via the parent, but
    // this test asserts the network call fired with the right method.
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/videos/v1/favorite" &&
          (init as RequestInit)?.method === "POST",
      );
      expect(call).toBeDefined();
    });
  });

  it("fires DELETE /favorite when clicking favorited", async () => {
    const { fetchSpy } = renderWithProviders(<GroupedToggle video={FAV} />, {
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/videos/v1/favorite" && method === "DELETE")
          return jsonResponse({ is_favorite: false });
        return jsonError(404, "unmocked");
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /remove from favorites/i }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/videos/v1/favorite" &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(call).toBeDefined();
    });
  });

  it("renders the hero variant with a text label, always visible", () => {
    renderWithProviders(<FavoriteToggle video={NOT_FAV} variant="hero" />);
    const btn = screen.getByRole("button", { name: /add to favorites/i });
    expect(btn.className).not.toContain("opacity-0");
    expect(btn.className).not.toContain("group-hover:opacity-100");
    expect(screen.getByText("Favorite")).toBeInTheDocument();
  });

  it("renders 'Favorited' label on hero variant when favorited", () => {
    renderWithProviders(<FavoriteToggle video={FAV} variant="hero" />);
    expect(screen.getByText("Favorited")).toBeInTheDocument();
  });
});
