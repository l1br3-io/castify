import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { CollectionCard } from "./collection-card";
import type { CollectionDto, VideoSummaryDto } from "../../api/types";
import { renderWithProviders } from "../../test/utils";

const MEMBER_BASE: VideoSummaryDto = {
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
  position_seconds: null,
  completed: false,
};

function member(id: string): VideoSummaryDto {
  return { ...MEMBER_BASE, id, name: `${id}.mp4` };
}

function makeCollection(overrides: Partial<CollectionDto> = {}): CollectionDto {
  return {
    id: "c1",
    name: "Rewatches",
    kind: "show",
    created_at: "2026-01-01T00:00:00Z",
    member_count: 2,
    preview: [member("v1"), member("v2")],
    ...overrides,
  };
}

function imgBySrc(container: HTMLElement, id: string): HTMLImageElement | null {
  return container.querySelector(
    `img[src="/api/videos/${id}/thumbnail"]`,
  ) as HTMLImageElement | null;
}

describe("CollectionCard", () => {
  it("renders the lead poster plus up to 3 layered members behind it", () => {
    const { container } = renderWithProviders(
      <CollectionCard
        collection={makeCollection({
          preview: [member("v1"), member("v2"), member("v3"), member("v4"), member("v5")],
        })}
      />,
    );

    // Lead + three layers; the fifth preview member is beyond the bound.
    for (const id of ["v1", "v2", "v3", "v4"]) {
      expect(imgBySrc(container, id)).not.toBeNull();
    }
    expect(imgBySrc(container, "v5")).toBeNull();
    // Layer members are decorative — no accessible text from the collage.
    expect(container.querySelectorAll("img[alt='']").length).toBe(4);
  });

  it("degrades to a plain poster for a single-member preview", () => {
    const { container } = renderWithProviders(
      <CollectionCard
        collection={makeCollection({ preview: [member("v1")] })}
      />,
    );

    expect(container.querySelectorAll("img").length).toBe(1);
    expect(imgBySrc(container, "v1")).not.toBeNull();
  });

  it("renders a quiet tinted block for an empty preview", () => {
    const { container } = renderWithProviders(
      <CollectionCard collection={makeCollection({ preview: [] })} />,
    );

    expect(container.querySelector("img")).toBeNull();
  });

  it("shows the kind label and member count, singular at one", () => {
    renderWithProviders(<CollectionCard collection={makeCollection()} />);
    expect(screen.getByText("Series · 2 videos")).toBeInTheDocument();

    renderWithProviders(
      <CollectionCard
        collection={makeCollection({
          kind: "time",
          member_count: 1,
          preview: [member("v1")],
        })}
      />,
    );
    expect(screen.getByText("Time group · 1 video")).toBeInTheDocument();
  });

  it("clamps the name to two lines", () => {
    renderWithProviders(<CollectionCard collection={makeCollection()} />);
    expect(screen.getByText("Rewatches")).toHaveClass("line-clamp-2");
  });

  it("links the whole card to the collection detail page", () => {
    renderWithProviders(<CollectionCard collection={makeCollection()} />);

    const link = screen.getByRole("link", { name: "Open collection Rewatches" });
    expect(link).toHaveAttribute("href", "/collections/c1");
    // Stretched-link pattern from PosterCard: overlays the card, focus
    // rings the whole thing via focus-visible.
    expect(link).toHaveClass("absolute", "inset-0", "z-0");
    expect(link).toHaveClass("focus-visible:ring-2");
  });

  it("renders menuSlot above the stretched link, right of the meta line", () => {
    renderWithProviders(
      <CollectionCard
        collection={makeCollection()}
        menuSlot={<button type="button">kebab</button>}
      />,
    );

    const button = screen.getByRole("button", { name: "kebab" });
    expect(button).toBeInTheDocument();
    // The slot wrapper keeps the controls clickable over the stretched
    // link (relative z-10) and hugs the row's right edge (ml-auto).
    expect(button.parentElement).toHaveClass("relative", "z-10", "ml-auto");
  });

  it("hovers shift the tile border toward the accent — no lift", () => {
    const { container } = renderWithProviders(
      <CollectionCard collection={makeCollection()} />,
    );

    const card = screen.getByRole("article");
    // Motion budget: no translate/lift on the card at all.
    expect(card.className).not.toContain("translate");

    // The lead tile's border shifts toward the accent on hover/focus.
    const leadTile = container.querySelector(".plate")!.parentElement!;
    expect(leadTile).toHaveClass(
      "group-hover:border-[var(--color-castify-accent)]",
      "group-focus-within:border-[var(--color-castify-accent)]",
    );
  });
});
