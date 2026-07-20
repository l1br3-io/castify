import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { HeroShowcase, HeroSkeleton } from "./hero-showcase";
import type { VideoSummaryDto } from "../api/types";
import { renderWithProviders } from "../test/utils";

const VIDEO: VideoSummaryDto = {
  id: "hero-1",
  name: "epic-concert.mp4",
  provider: "google_drive",
  size_bytes: 1_073_741_824,
  mime_type: "video/mp4",
  duration_ms: 3_661_000,
  width: 3840,
  height: 2160,
  sources: [
    { connection_id: "c1", provider: "google_drive", provider_file_id: "gd-1" },
    { connection_id: "c2", provider: "dropbox", provider_file_id: "db-1" },
  ],
  created_at: "2026-01-01T00:00:00Z",
  path: "/Concerts/epic.mp4",
  is_favorite: false,
  my_rating: null,
  thumbnail_status: "pending",
  position_seconds: null,
  completed: false,
};

describe("HeroShowcase", () => {
  it("renders a skeleton when video is undefined", () => {
    const { container } = renderWithProviders(<HeroShowcase video={undefined} />);
    // Skeleton has animate-pulse and no heading text.
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByText("epic-concert.mp4")).not.toBeInTheDocument();
  });

  it("renders the video name and metadata", () => {
    renderWithProviders(<HeroShowcase video={VIDEO} />);
    expect(screen.getByText("epic-concert.mp4")).toBeInTheDocument();
    // Duration: 1:01:01
    expect(screen.getByText("1:01:01")).toBeInTheDocument();
    // Resolution: 3840×2160
    expect(screen.getByText(/3840\u00d72160/)).toBeInTheDocument();
    // Size: 1.0 GB
    expect(screen.getByText("1.0 GB")).toBeInTheDocument();
  });

  it("renders provider and dedup badges", () => {
    renderWithProviders(<HeroShowcase video={VIDEO} />);
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    expect(screen.getByText(/Also in: Dropbox/)).toBeInTheDocument();
  });

  it("renders a blurred backdrop img with the thumbnail URL", () => {
    const { container } = renderWithProviders(<HeroShowcase video={VIDEO} />);
    const img = container.querySelector('img[src="/api/videos/hero-1/thumbnail"]');
    expect(img).not.toBeNull();
    // The backdrop should have blur filter applied.
    expect((img as HTMLElement | null)?.style.filter).toContain("blur");
  });

  it("renders T11 slots when provided", () => {
    renderWithProviders(
      <HeroShowcase
        video={VIDEO}
        favoriteSlot={<button type="button">Favorite</button>}
        ratingSlot={<div data-testid="rating">stars</div>}
      />,
    );
    expect(screen.getByRole("button", { name: "Favorite" })).toBeInTheDocument();
    expect(screen.getByTestId("rating")).toBeInTheDocument();
  });

  it("omits the slot container when no slots are provided", () => {
    renderWithProviders(<HeroShowcase video={VIDEO} />);
    // No favorite/rating buttons from slots.
    expect(screen.queryByRole("button", { name: "Favorite" })).not.toBeInTheDocument();
  });

  it("falls back to a gradient on image error (img unmounted)", () => {
    const { container } = renderWithProviders(<HeroShowcase video={VIDEO} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent(img!, new Event("error"));
    // After error, the img is unmounted.
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("HeroSkeleton", () => {
  it("renders a pulsing placeholder", () => {
    const { container } = renderWithProviders(<HeroSkeleton />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });
});
