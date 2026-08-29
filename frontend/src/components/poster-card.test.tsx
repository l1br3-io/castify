import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";

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
  position_seconds: null,
  completed: false,
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

  it("re-roots the thumbnail through the share mirror when given a share scope", () => {
    const { container } = renderWithProviders(
      <PosterCard video={VIDEO} scope={{ kind: "share", token: "tok_abc" }} />,
    );

    // Recipient thumbnails must not touch the session-gated owner route.
    expect(
      container.querySelector('img[src="/api/videos/v1/thumbnail"]'),
    ).toBeNull();
    expect(
      container.querySelector('img[src="/api/share/tok_abc/videos/v1/thumbnail"]'),
    ).not.toBeNull();
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

  it("renders ratingSlot in the body below the year/provider line", () => {
    renderWithProviders(
      <PosterCard
        video={VIDEO}
        href="/watch/v1"
        ratingSlot={<div data-testid="rating-slot">stars go here</div>}
      />,
    );
    const rating = screen.getByTestId("rating-slot");
    // Document order: name → meta line → rating row.
    const name = screen.getByText("cat.mp4");
    expect(name.compareDocumentPosition(rating) &
      Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The row must sit above the stretched link (relative z-10) so the
    // stars stay clickable, and hug its content (w-fit) so the rest of
    // the strip still clicks through to the link.
    expect(rating.parentElement).toHaveClass("relative", "z-10", "w-fit");
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

  it("renders a stretched link when href is provided", () => {
    renderWithProviders(<PosterCard video={VIDEO} href="/watch/v1" />);
    const link = screen.getByRole("link", { name: "Play cat.mp4" });
    expect(link).toHaveAttribute("href", "/watch/v1");
    expect(link).toHaveClass("absolute", "inset-0", "z-0");
  });

  it("does not render a link when href is omitted", () => {
    renderWithProviders(<PosterCard video={VIDEO} />);
    expect(
      screen.queryByRole("link", { name: /Play/ }),
    ).not.toBeInTheDocument();
  });

  it("positions the thumbnail slot wrapper above the stretched link via z-10", () => {
    renderWithProviders(
      <PosterCard
        video={VIDEO}
        href="/watch/v1"
        topRightSlot={<button type="button">fav</button>}
      />,
    );
    const link = screen.getByRole("link", { name: "Play cat.mp4" });
    // The thumbnail slot wrapper is z-10 (above the z-0 link) so the
    // favorite stays clickable.
    const slotContainers = link.parentElement!.querySelectorAll(".z-10");
    expect(slotContainers.length).toBe(1);
  });  // --- M3 T7: ephemeral queue state propagation ---

  // Renders at /watch/:id with the location serialized so the test can
  // assert on `state.queue` after clicking a PosterCard link.
  function QueueStateProbe() {
    const loc = useLocation();
    return (
      <div data-testid="loc-state">{JSON.stringify(loc.state ?? null)}</div>
    );
  }

  it("hovers shift border + name underline only — no lift (identity pass 005)", () => {
    renderWithProviders(<PosterCard video={VIDEO} href="/watch/v1" />);
    const card = screen.getByRole("article");
    // Border-accent shift kept on both hover and focus.
    expect(card).toHaveClass("hover:border-[var(--color-castify-accent)]/40");
    expect(card).toHaveClass("focus-within:border-[var(--color-castify-accent)]/40");
    // Lift discipline: no translate on the card at all.
    expect(card.className).not.toContain("-translate-y");
    // The video name underlines instead.
    const name = screen.getByText("cat.mp4");
    expect(name).toHaveClass("group-hover:underline", "group-focus-within:underline");
  });

  it("passes `queue` via router state when provided (M3 T7)", () => {
    renderWithProviders(
      <Routes>
        <Route
          path="/"
          element={
            <PosterCard
              video={VIDEO}
              href="/watch/v1"
              queue={["v1", "v2", "v3"]}
            />
          }
        />
        <Route path="/watch/:id" element={<QueueStateProbe />} />
      </Routes>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Play cat.mp4" }));

    const state = screen.getByTestId("loc-state").textContent;
    expect(state).toContain("queue");
    expect(state).toContain("v1");
    expect(state).toContain("v2");
    expect(state).toContain("v3");
  });

  it("omits router state when `queue` is not provided (M3 T7)", () => {
    renderWithProviders(
      <Routes>
        <Route
          path="/"
          element={<PosterCard video={VIDEO} href="/watch/v1" />}
        />
        <Route path="/watch/:id" element={<QueueStateProbe />} />
      </Routes>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Play cat.mp4" }));

    // No `queue` prop → state is undefined → serialized as null.
    expect(screen.getByTestId("loc-state")).toHaveTextContent("null");
  });
});
