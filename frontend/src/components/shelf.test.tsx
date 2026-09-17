import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { Shelf } from "./shelf";
import type { VideoSummaryDto } from "../api/types";
import { renderWithProviders } from "../test/utils";

const VIDEOS: VideoSummaryDto[] = [
  {
    id: "v1",
    name: "alpha.mp4",
    provider: "google_drive",
    size_bytes: 1_048_576,
    mime_type: "video/mp4",
    duration_ms: 60_000,
    width: 1920,
    height: 1080,
    sources: [{ connection_id: "c1", provider: "google_drive", provider_file_id: "gd-1" }],
    created_at: "2026-01-01T00:00:00Z",
    path: "/Movies/alpha.mp4",
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "pending",
    position_seconds: null,
    completed: false,
  },
  {
    id: "v2",
    name: "beta.mp4",
    provider: "dropbox",
    size_bytes: 2_097_152,
    mime_type: "video/mp4",
    duration_ms: 120_000,
    width: 1280,
    height: 720,
    sources: [{ connection_id: "c2", provider: "dropbox", provider_file_id: "db-1" }],
    created_at: "2026-01-02T00:00:00Z",
    path: "/TV/beta.mp4",
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "pending",
    position_seconds: null,
    completed: false,
  },
];

describe("Shelf", () => {
  it("renders the shelf title and a PosterCard per video", () => {
    renderWithProviders(<Shelf title="Recently Added" videos={VIDEOS} />);

    expect(screen.getByText("Recently Added")).toBeInTheDocument();
    expect(screen.getByText("alpha.mp4")).toBeInTheDocument();
    expect(screen.getByText("beta.mp4")).toBeInTheDocument();
  });

  it("renders a View All button when onViewAll is provided", () => {
    const onViewAll = vi.fn();
    renderWithProviders(
      <Shelf title="Favorites" videos={VIDEOS} onViewAll={onViewAll} />,
    );

    const button = screen.getByRole("button", { name: "View All" });
    fireEvent.click(button);
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it("omits the View All button when onViewAll is not provided", () => {
    renderWithProviders(<Shelf title="Recently Added" videos={VIDEOS} />);
    expect(screen.queryByRole("button", { name: "View All" })).not.toBeInTheDocument();
  });

  it("styles the title in the display serif voice with tabular-numeral count", () => {
    renderWithProviders(
      <Shelf title="Recently added" videos={VIDEOS} totalCount={47} />,
    );

    const heading = screen.getByRole("heading", { name: "Recently added" });
    // Classical rails: display serif (global heading voice), not the mono
    // eyebrow strip.
    expect(heading).not.toHaveClass("eyebrow");

    const count = screen.getByText("· 47");
    expect(count).toHaveClass("figure");
  });

  it("keeps the View All accent affordance with a visible focus ring", () => {
    renderWithProviders(<Shelf title="T" videos={VIDEOS} onViewAll={() => {}} />);

    const button = screen.getByRole("button", { name: "View All" });
    // AA-strong accent step for text on paper (task 008 token split).
    expect(button).toHaveClass("text-[var(--color-castify-accent-strong)]");
    expect(button).toHaveClass("focus-visible:ring-2");
  });

  it("renders nothing when the videos array is empty", () => {
    const { container } = renderWithProviders(
      <Shelf title="Empty Shelf" videos={[]} />,
    );
    // Title renders, but no cards.
    expect(screen.getByText("Empty Shelf")).toBeInTheDocument();
    expect(container.querySelectorAll("article")).toHaveLength(0);
  });

  it("applies fixed-width wrappers for horizontal scrolling", () => {
    const { container } = renderWithProviders(
      <Shelf title="Test" videos={VIDEOS} />,
    );
    const wrappers = container.querySelectorAll(".w-\\[200px\\]");
    expect(wrappers.length).toBe(2);
  });
});
