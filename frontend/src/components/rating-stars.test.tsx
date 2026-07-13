import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { RatingStars } from "./rating-stars";
import type { VideoSummaryDto } from "../api/types";
import { setCsrfToken } from "../api/client";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";

const UNRATED: VideoSummaryDto = {
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
};

const RATED: VideoSummaryDto = { ...UNRATED, my_rating: 4 };

function GroupedStars(props: React.ComponentProps<typeof RatingStars>) {
  return (
    <div className="group">
      <RatingStars {...props} />
    </div>
  );
}

describe("RatingStars", () => {
  beforeEach(() => setCsrfToken("csrf-test"));
  afterEach(() => setCsrfToken(null));

  it("marks only the star matching my_rating as aria-checked", () => {
    renderWithProviders(<GroupedStars video={RATED} />);
    // my_rating=4 → star 4 is the canonical value.
    expect(screen.getByRole("radio", { name: "4 stars" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    [1, 2, 3, 5].forEach((n) => {
      expect(
        screen.getByRole("radio", { name: `${n} star${n > 1 ? "s" : ""}` }),
      ).toHaveAttribute("aria-checked", "false");
    });
  });

  it("renders 5 unfilled stars when unrated", () => {
    renderWithProviders(<GroupedStars video={UNRATED} />);
    const svgs = screen.getAllByRole("radio").map((b) => b.querySelector("svg"));
    expect(svgs.length).toBe(5);
    svgs.forEach((svg) => expect(svg?.getAttribute("fill")).toBe("none"));
  });

  it("is hover-gated (opacity-0 group-hover:opacity-100) when unrated", () => {
    const { container } = renderWithProviders(<GroupedStars video={UNRATED} />);
    const group = container.querySelector('[role="group"]');
    expect(group?.className).toContain("opacity-0");
    expect(group?.className).toContain("group-hover:opacity-100");
  });

  it("is always visible when rated", () => {
    const { container } = renderWithProviders(<GroupedStars video={RATED} />);
    const group = container.querySelector('[role="group"]');
    expect(group?.className).toContain("opacity-100");
    expect(group?.className).not.toContain("opacity-0");
  });

  it("hover fills stars as a preview without firing a request", () => {
    const { fetchSpy } = renderWithProviders(<GroupedStars video={UNRATED} />, {
      fetchImplementation: () => jsonError(404, "unmocked"),
    });
    const star3 = screen.getByRole("radio", { name: "3 stars" });
    fireEvent.mouseEnter(star3);
    // After hover-preview: stars 1..3 filled, 4..5 outline.
    const svgs = screen
      .getAllByRole("radio")
      .map((b) => b.querySelector("svg")!.getAttribute("fill"));
    expect(svgs).toEqual(["currentColor", "currentColor", "currentColor", "none", "none"]);
    // No request fired on hover.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mouse leave clears the preview", () => {
    const { container } = renderWithProviders(<GroupedStars video={UNRATED} />, {
      fetchImplementation: () => jsonError(404, "unmocked"),
    });
    const star3 = screen.getByRole("radio", { name: "3 stars" });
    fireEvent.mouseEnter(star3);
    fireEvent.mouseLeave(container.querySelector('[role="group"]')!);
    const svgs = screen
      .getAllByRole("radio")
      .map((b) => b.querySelector("svg")!.getAttribute("fill"));
    expect(svgs).toEqual(["none", "none", "none", "none", "none"]);
  });

  it("clicks unrated star → fires PUT /rating with the right body", async () => {
    const { fetchSpy } = renderWithProviders(<GroupedStars video={UNRATED} />, {
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/videos/v1/rating" && method === "PUT")
          return jsonResponse({ my_rating: 3 });
        return jsonError(404, "unmocked");
      },
    });

    fireEvent.click(screen.getByRole("radio", { name: "3 stars" }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/videos/v1/rating" &&
          (init as RequestInit)?.method === "PUT",
      );
      expect(call).toBeDefined();
      const body = (call![1] as RequestInit).body;
      expect(body).toBe(JSON.stringify({ rating: 3 }));
    });
  });

  it("clicks the currently-set star → fires DELETE /rating (clear)", async () => {
    const { fetchSpy } = renderWithProviders(<GroupedStars video={RATED} />, {
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/videos/v1/rating" && method === "DELETE")
          return jsonResponse({ my_rating: null });
        return jsonError(404, "unmocked");
      },
    });

    fireEvent.click(screen.getByRole("radio", { name: "4 stars" }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/videos/v1/rating" &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(call).toBeDefined();
    });
  });

  it("renders the hero variant always visible with larger stars", () => {
    const { container } = renderWithProviders(
      <RatingStars video={UNRATED} variant="hero" />,
    );
    const group = container.querySelector('[role="group"]');
    expect(group?.className).not.toContain("opacity-0");
    expect(group?.className).not.toContain("group-hover:opacity-100");
    // Larger star icon class on hero variant.
    const svgs = container.querySelectorAll("svg");
    expect(svgs[0].className.baseVal).toContain("h-6");
  });
});
