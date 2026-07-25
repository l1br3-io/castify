import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";

import { ContinueWatchingCard } from "./continue-watching-card";
import type { ProgressEntry } from "../lib/player-db";
import { renderWithProviders } from "../test/utils";

const BASE_ENTRY: ProgressEntry = {
  videoId: "v1",
  positionSeconds: 30,
  durationSeconds: 120,
  completed: false,
  updatedAt: Date.now(),
  videoName: "in-progress.mp4",
  videoDurationMs: 120_000,
  thumbnailStatus: "cached",
  height: 1080,
  provider: "google_drive",
};

// Drive the thumbnail <img> out of the loading state — jsdom never fires
// onLoad spontaneously. Mirrors the helper in poster-card.test.tsx.
function fireImageEvent(container: HTMLElement, event: "load" | "error"): void {
  const img = container.querySelector("img");
  if (!img) throw new Error("img not rendered");
  fireEvent(img, new Event(event));
}

describe("ContinueWatchingCard", () => {
  it("renders the video name, provider badge, and thumbnail src", () => {
    const { container } = renderWithProviders(
      <ContinueWatchingCard entry={BASE_ENTRY} />,
    );

    expect(screen.getByText("in-progress.mp4")).toBeInTheDocument();
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    const img = container.querySelector('img[src="/api/videos/v1/thumbnail"]');
    expect(img).not.toBeNull();
  });

  it("renders a stretched resume link pointing at /watch/:id", () => {
    renderWithProviders(<ContinueWatchingCard entry={BASE_ENTRY} />);
    const link = screen.getByRole("link", { name: "Resume in-progress.mp4" });
    expect(link).toHaveAttribute("href", "/watch/v1");
    expect(link).toHaveClass("absolute", "inset-0", "z-0");
  });

  it("URL-encodes the video id in the resume link", () => {
    const entry: ProgressEntry = {
      ...BASE_ENTRY,
      videoId: "movie 2026/final.mp4",
    };
    renderWithProviders(<ContinueWatchingCard entry={entry} />);
    const link = screen.getByRole("link", {
      name: "Resume in-progress.mp4",
    });
    expect(link).toHaveAttribute(
      "href",
      "/watch/movie%202026%2Ffinal.mp4",
    );
  });

  it("renders the progress bar with width = position/duration", () => {
    // 30s of 120s = 25%
    renderWithProviders(<ContinueWatchingCard entry={BASE_ENTRY} />);
    const bar = screen.getByRole("progressbar", { name: "Watch progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    // The inner fill div carries the explicit width.
    const fill = bar.firstElementChild;
    expect(fill).not.toBeNull();
    expect(fill).toHaveStyle({ width: "25%" });
  });

  it("clamps progress to 100% when position exceeds duration", () => {
    // Saved position can lag behind duration when the player crosses the 95%
    // auto-completion threshold but the final save fires later. The bar
    // must not render wider than 100%.
    const entry: ProgressEntry = {
      ...BASE_ENTRY,
      positionSeconds: 150,
      durationSeconds: 120,
    };
    renderWithProviders(<ContinueWatchingCard entry={entry} />);
    const bar = screen.getByRole("progressbar", { name: "Watch progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar.firstElementChild).toHaveStyle({ width: "100%" });
  });

  it("hides the progress bar when duration is null", () => {
    // Some saves land before `loadedmetadata` populates duration. The bar
    // would be meaningless without a denominator — suppress it.
    const entry: ProgressEntry = {
      ...BASE_ENTRY,
      durationSeconds: null,
    };
    renderWithProviders(<ContinueWatchingCard entry={entry} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("hides the progress bar when duration is zero or negative", () => {
    const entry: ProgressEntry = {
      ...BASE_ENTRY,
      durationSeconds: 0,
    };
    renderWithProviders(<ContinueWatchingCard entry={entry} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows the duration total label when duration is known", () => {
    renderWithProviders(<ContinueWatchingCard entry={BASE_ENTRY} />);
    // 120s * 1000 = 120,000ms → formatDuration prints "2:00".
    expect(screen.getByText("2:00 total")).toBeInTheDocument();
  });

  it("hides the duration total label when duration is null", () => {
    const entry: ProgressEntry = {
      ...BASE_ENTRY,
      durationSeconds: null,
    };
    renderWithProviders(<ContinueWatchingCard entry={entry} />);
    expect(screen.queryByText(/total/)).not.toBeInTheDocument();
  });

  it("falls back to the gradient placeholder when the thumbnail errors", () => {
    const { container } = renderWithProviders(
      <ContinueWatchingCard entry={BASE_ENTRY} />,
    );

    fireImageEvent(container, "error");

    // img is unmounted on error; the filename initial is shown instead.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("I")).toBeInTheDocument();
  });

  // --- Queue state propagation (T11 contract) ---

  function QueueStateProbe() {
    const loc = useLocation();
    return (
      <div data-testid="loc-state">{JSON.stringify(loc.state ?? null)}</div>
    );
  }

  it("passes `queue` via router state when provided", () => {
    renderWithProviders(
      <Routes>
        <Route
          path="/"
          element={
            <ContinueWatchingCard
              entry={BASE_ENTRY}
              queue={["v1", "v2", "v3"]}
            />
          }
        />
        <Route path="/watch/:id" element={<QueueStateProbe />} />
      </Routes>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Resume in-progress.mp4" }));

    const state = screen.getByTestId("loc-state").textContent ?? "";
    expect(state).toContain("queue");
    expect(state).toContain("v1");
    expect(state).toContain("v2");
    expect(state).toContain("v3");
  });

  it("omits router state when `queue` is not provided", () => {
    renderWithProviders(
      <Routes>
        <Route
          path="/"
          element={<ContinueWatchingCard entry={BASE_ENTRY} />}
        />
        <Route path="/watch/:id" element={<QueueStateProbe />} />
      </Routes>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Resume in-progress.mp4" }));

    expect(screen.getByTestId("loc-state")).toHaveTextContent("null");
  });
});
