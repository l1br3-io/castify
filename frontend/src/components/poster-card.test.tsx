import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { PosterCard } from "./poster-card";
import type { VideoSummaryDto } from "../api/types";
import { renderWithProviders } from "../test/utils";

const VIDEO: VideoSummaryDto = {
  id: "v1",
  name: "cat.mp4",
  provider: "google_drive",
  size_bytes: 5_242_880,
  mime_type: "video/mp4",
  duration_ms: 120_000,
  width: 1920,
  height: 1080,
  sources: [
    { connection_id: "c1", provider: "google_drive", provider_file_id: "gd-1" },
  ],
  created_at: "2026-01-01T00:00:00Z",
  path: "/Movies/cat.mp4",
  is_favorite: false,
  my_rating: null,
  thumbnail_status: "pending",
};

const MULTI_SOURCE_VIDEO: VideoSummaryDto = {
  ...VIDEO,
  id: "v2",
  name: "dedup.mp4",
  sources: [
    { connection_id: "c1", provider: "google_drive", provider_file_id: "gd-2" },
    { connection_id: "c2", provider: "dropbox", provider_file_id: "db-1" },
  ],
};

// jsdom doesn't actually fetch image bytes, so onLoad/onError never fire
// spontaneously — we synthesize them to drive the PosterCard state machine.
function fireImageEvent(container: HTMLElement, event: "load" | "error"): void {
  const img = container.querySelector("img");
  if (!img) throw new Error("img not rendered");
  fireEvent(img, new Event(event));
}

describe("PosterCard", () => {
  it("renders the video name, provider badge, and thumbnail src", () => {
    const { container } = renderWithProviders(<PosterCard video={VIDEO} />);

    expect(screen.getByText("cat.mp4")).toBeInTheDocument();
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    const img = container.querySelector('img[src="/api/videos/v1/thumbnail"]');
    expect(img).not.toBeNull();
  });

  it("shows duration and resolution badges after the image loads", () => {
    const { container } = renderWithProviders(<PosterCard video={VIDEO} />);
    // Before load: metadata badges hidden (state === "loading").
    expect(screen.queryByText("2:00")).not.toBeInTheDocument();
    expect(screen.queryByText("1080p")).not.toBeInTheDocument();

    fireImageEvent(container, "load");

    expect(screen.getByText("2:00")).toBeInTheDocument();
    expect(screen.getByText("1080p")).toBeInTheDocument();
  });

  it("hides duration badge when duration_ms is null after load", () => {
    const { container } = renderWithProviders(
      <PosterCard video={{ ...VIDEO, duration_ms: null }} />,
    );
    fireImageEvent(container, "load");
    expect(screen.queryByText(/^\d+:\d+/)).not.toBeInTheDocument();
    // Resolution badge still renders.
    expect(screen.getByText("1080p")).toBeInTheDocument();
  });

  it("falls back to a first-letter placeholder when the thumbnail errors", () => {
    const { container } = renderWithProviders(<PosterCard video={VIDEO} />);

    fireImageEvent(container, "error");

    // img is unmounted on error; only the gradient + initial remains.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("C")).toBeInTheDocument();
  });

  it("renders a dedup badge when sources span multiple providers", () => {
    renderWithProviders(<PosterCard video={MULTI_SOURCE_VIDEO} />);
    expect(screen.getByText(/Also in: Dropbox/)).toBeInTheDocument();
  });

  it("hides the dedup badge for single-source videos", () => {
    renderWithProviders(<PosterCard video={VIDEO} />);
    expect(screen.queryByText(/Also in:/)).not.toBeInTheDocument();
  });

  it("renders topRightSlot when provided", () => {
    renderWithProviders(
      <PosterCard
        video={VIDEO}
        topRightSlot={<button type="button">♡</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "♡" })).toBeInTheDocument();
  });

  it("renders bottomOverlaySlot and suppresses duration/resolution badges when provided", () => {
    const { container } = renderWithProviders(
      <PosterCard
        video={VIDEO}
        bottomOverlaySlot={<div data-testid="rating-slot">stars go here</div>}
      />,
    );

    // Drive the img into the loaded state.
    fireImageEvent(container, "load");

    // Slot is present.
    expect(screen.getByTestId("rating-slot")).toBeInTheDocument();
    // Badges are suppressed even though the img is loaded.
    expect(screen.queryByText("2:00")).not.toBeInTheDocument();
    expect(screen.queryByText("1080p")).not.toBeInTheDocument();
  });

  it("omits the resolution badge for heights below 360 after load", () => {
    const { container } = renderWithProviders(
      <PosterCard video={{ ...VIDEO, height: 240, width: 320 }} />,
    );
    fireImageEvent(container, "load");
    // Duration still renders; resolution bucket returns null for height < 360.
    expect(screen.getByText("2:00")).toBeInTheDocument();
    expect(screen.queryByText("240p")).not.toBeInTheDocument();
  });
});
