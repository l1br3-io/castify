import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { Thumbnail } from "./thumbnail";
import { renderWithProviders } from "../test/utils";

const VIDEO = {
  id: "v1",
  name: "sample.mp4",
  height: 1080,
  duration_ms: 61_000,
};

// Thumbnail — shared 16:9 surface. Task 011 (Classical): every poster/
// thumbnail passes through the `.plate` archival treatment, at a fixed
// aspect ratio so grid/rails never shift when images resolve (FR-3.5).

describe("Thumbnail", () => {
  it("renders the archival plate treatment at a fixed 16:9 ratio", () => {
    const { container } = renderWithProviders(<Thumbnail video={VIDEO} />);
    const plate = container.firstElementChild as HTMLElement;
    expect(plate).toHaveClass("plate");
    expect(plate).toHaveClass("aspect-video");
  });

  it("falls back to a typographic tile on error — never a broken-image box", () => {
    const { container } = renderWithProviders(<Thumbnail video={VIDEO} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    // The dead img is unmounted and the filename initial stands in.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("S")).toBeInTheDocument();
  });
});
